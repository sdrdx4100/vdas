"""CSV / Parquet ファイルの取り込み。

アップロードされたファイルは data/uploads/ に原本保存した上で、
DuckDB のテーブル (ds_xxxx) として永続化する。以降のクエリは
すべて DuckDB テーブルに対して実行されるため高速。
"""
from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Any, BinaryIO

from .config import UPLOAD_DIR
from . import db

SUPPORTED_EXTENSIONS = {".csv", ".parquet", ".pq"}


class IngestError(Exception):
    pass


def _clean_tags(tags: list[str] | None) -> list[str]:
    seen: list[str] = []
    for t in tags or []:
        t = str(t).strip()
        if t and t not in seen:
            seen.append(t)
    return seen


def ingest_file(fileobj: BinaryIO, original_filename: str, dataset_name: str | None = None,
                tags: list[str] | None = None) -> dict[str, Any]:
    ext = Path(original_filename).suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise IngestError(f"未対応の拡張子です: {ext} (CSV / Parquet のみ対応)")

    dataset_id = uuid.uuid4().hex[:12]
    table_name = f"ds_{dataset_id}"
    stored_path = UPLOAD_DIR / f"{dataset_id}{ext}"

    with open(stored_path, "wb") as out:
        shutil.copyfileobj(fileobj, out)

    try:
        with db.duck() as con:
            if ext == ".csv":
                reader = "read_csv_auto(?, sample_size=-1)"
            else:
                reader = "read_parquet(?)"
            con.execute(
                f'CREATE TABLE "{table_name}" AS SELECT * FROM {reader}',
                [str(stored_path)],
            )
            row_count = con.execute(f'SELECT count(*) FROM "{table_name}"').fetchone()[0]
            columns = con.execute(f'DESCRIBE "{table_name}"').fetchall()
    except Exception as e:
        stored_path.unlink(missing_ok=True)
        raise IngestError(f"ファイルの読み込みに失敗しました: {e}") from e

    name = dataset_name or Path(original_filename).stem
    db.meta_execute(
        "INSERT INTO datasets (id, name, original_filename, stored_path, table_name, row_count, column_count, file_size, tags)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (dataset_id, name, original_filename, str(stored_path), table_name,
         row_count, len(columns), stored_path.stat().st_size,
         json.dumps(_clean_tags(tags), ensure_ascii=False)),
    )
    return get_dataset(dataset_id)


def _decode(row: dict[str, Any]) -> dict[str, Any]:
    row["tags"] = json.loads(row.get("tags") or "[]")
    return row


def get_dataset(dataset_id: str) -> dict[str, Any]:
    rows = db.meta_query("SELECT * FROM datasets WHERE id = ?", (dataset_id,))
    if not rows:
        raise IngestError(f"データセットが見つかりません: {dataset_id}")
    return _decode(rows[0])


def list_datasets() -> list[dict[str, Any]]:
    return [_decode(r) for r in db.meta_query("SELECT * FROM datasets ORDER BY created_at DESC")]


def update_tags(dataset_id: str, tags: list[str]) -> dict[str, Any]:
    get_dataset(dataset_id)  # 存在チェック
    db.meta_execute("UPDATE datasets SET tags = ? WHERE id = ?",
                    (json.dumps(_clean_tags(tags), ensure_ascii=False), dataset_id))
    return get_dataset(dataset_id)


def bulk_update_tags(dataset_ids: list[str], add: list[str] | None = None,
                     remove: list[str] | None = None) -> dict[str, Any]:
    """複数データセットにまとめてタグを追加 / 削除する。"""
    add = _clean_tags(add)
    remove = set(_clean_tags(remove))
    for ds_id in dataset_ids:
        ds = get_dataset(ds_id)
        tags = [t for t in ds["tags"] if t not in remove]
        tags += [t for t in add if t not in tags]
        db.meta_execute("UPDATE datasets SET tags = ? WHERE id = ?",
                        (json.dumps(tags, ensure_ascii=False), ds_id))
    return {"updated": len(dataset_ids)}


def all_tags() -> list[str]:
    tags: set[str] = set()
    for ds in list_datasets():
        tags.update(ds["tags"])
    return sorted(tags)


def delete_dataset(dataset_id: str) -> None:
    ds = get_dataset(dataset_id)
    with db.duck() as con:
        con.execute(f'DROP TABLE IF EXISTS "{ds["table_name"]}"')
    Path(ds["stored_path"]).unlink(missing_ok=True)
    db.meta_execute("DELETE FROM datasets WHERE id = ?", (dataset_id,))


def dataset_schema(dataset_id: str) -> dict[str, Any]:
    ds = get_dataset(dataset_id)
    with db.duck() as con:
        described = con.execute(f'DESCRIBE "{ds["table_name"]}"').fetchall()
    numeric_prefixes = ("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
                        "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
                        "FLOAT", "DOUBLE", "DECIMAL")
    temporal_prefixes = ("DATE", "TIME", "TIMESTAMP")
    columns = []
    for row in described:
        col_name, col_type = row[0], row[1]
        upper = col_type.upper()
        if upper.startswith(numeric_prefixes):
            kind = "numeric"
        elif upper.startswith(temporal_prefixes):
            kind = "temporal"
        else:
            kind = "other"
        columns.append({"name": col_name, "type": col_type, "kind": kind})
    return {"dataset": ds, "columns": columns}
