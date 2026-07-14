"""DuckDB (データ本体) と SQLite (メタデータ) への接続管理。

FastAPI は複数スレッドからハンドラを呼ぶため、それぞれの接続を
ロックで直列化して使う。分析クエリは DuckDB 側で実行されるので
この粒度のロックで実用上十分な性能が出る。
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterator

import duckdb

from .config import DUCKDB_PATH, META_DB_PATH, ensure_dirs

_duck_lock = threading.Lock()
_meta_lock = threading.Lock()
_duck_conn: duckdb.DuckDBPyConnection | None = None
_meta_conn: sqlite3.Connection | None = None

META_SCHEMA = """
CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    table_name TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    column_count INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS saved_views (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,              -- 'timeseries' | 'stats'
    dataset_id TEXT,
    config TEXT NOT NULL,            -- JSON: 選択列・フィルタ条件・チャート設定
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS label_sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dataset_id TEXT,
    columns TEXT NOT NULL,           -- JSON: 列名の配列
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def init() -> None:
    """起動時に一度呼ぶ。ディレクトリと接続とスキーマを準備する。"""
    global _duck_conn, _meta_conn
    ensure_dirs()
    if _duck_conn is None:
        _duck_conn = duckdb.connect(str(DUCKDB_PATH))
    if _meta_conn is None:
        _meta_conn = sqlite3.connect(str(META_DB_PATH), check_same_thread=False)
        _meta_conn.row_factory = sqlite3.Row
        _meta_conn.executescript(META_SCHEMA)
        _meta_conn.commit()


@contextmanager
def duck() -> Iterator[duckdb.DuckDBPyConnection]:
    if _duck_conn is None:
        init()
    with _duck_lock:
        yield _duck_conn  # type: ignore[misc]


@contextmanager
def meta() -> Iterator[sqlite3.Connection]:
    if _meta_conn is None:
        init()
    with _meta_lock:
        yield _meta_conn  # type: ignore[misc]


def meta_query(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with meta() as con:
        rows = con.execute(sql, params).fetchall()
        return [dict(r) for r in rows]


def meta_execute(sql: str, params: tuple[Any, ...] = ()) -> None:
    with meta() as con:
        con.execute(sql, params)
        con.commit()
