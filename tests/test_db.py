"""DuckDB接続の並行読み取りと書き込み排他を検証する。"""
from __future__ import annotations

import threading

from app import db


def test_duck_reads_can_overlap() -> None:
    acquired = threading.Event()

    def read_in_thread() -> None:
        with db.duck() as con:
            assert con.execute("SELECT 1").fetchone()[0] == 1
            acquired.set()

    with db.duck() as first:
        assert first.execute("SELECT 1").fetchone()[0] == 1
        thread = threading.Thread(target=read_in_thread)
        thread.start()
        assert acquired.wait(2), "別の読み取りが先行読み取りの終了を待っている"
    thread.join(timeout=2)
    assert not thread.is_alive()


def test_duck_write_waits_for_active_read() -> None:
    attempting = threading.Event()
    acquired = threading.Event()

    def write_in_thread() -> None:
        attempting.set()
        with db.duck_write():
            acquired.set()

    with db.duck():
        thread = threading.Thread(target=write_in_thread)
        thread.start()
        assert attempting.wait(2)
        assert not acquired.wait(0.1), "読み取り中に書き込みロックを取得した"
    assert acquired.wait(2)
    thread.join(timeout=2)
    assert not thread.is_alive()
