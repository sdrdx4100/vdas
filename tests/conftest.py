from __future__ import annotations

import io
import os
import shutil
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

# app.config は import 時に保存先を確定するため、app を読む前に隔離先を設定する。
TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="vdas-tests-"))
os.environ["VDAS_DATA_DIR"] = str(TEST_DATA_DIR)

from app import db, ingest  # noqa: E402


@pytest.fixture(autouse=True)
def clean_databases() -> Iterator[None]:
    """各テストを空のDuckDB・メタDBから開始する。"""
    db.init()
    ingest.delete_all(include_views=True)
    yield
    ingest.delete_all(include_views=True)


@pytest.fixture
def ingest_csv() -> Callable[..., dict]:
    def _ingest(
        csv_text: str,
        filename: str = "sample.csv",
        name: str | None = None,
        tags: list[str] | None = None,
    ) -> dict:
        return ingest.ingest_file(
            io.BytesIO(csv_text.encode("utf-8")),
            filename,
            name,
            tags,
        )

    return _ingest


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Windowsでも一時DBを削除できるよう接続を明示的に閉じる。"""
    del session, exitstatus
    if db._duck_conn is not None:
        db._duck_conn.close()
        db._duck_conn = None
    if db._meta_conn is not None:
        db._meta_conn.close()
        db._meta_conn = None
    shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)
