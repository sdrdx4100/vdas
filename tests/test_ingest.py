from __future__ import annotations

from pathlib import Path

import pytest

from app import db, ingest


CSV = """time,speed,rpm,mode
0,0,800,idle
1,10,1000,drive
2,20,1200,drive
3,30,1400,drive
4,40,1600,drive
5,50,1800,drive
"""


def test_ingest_csv_records_schema_tags_and_original(ingest_csv) -> None:
    dataset = ingest_csv(CSV, name="走行A", tags=[" A社 ", "評価", "A社", ""])

    assert dataset["name"] == "走行A"
    assert dataset["row_count"] == 6
    assert dataset["column_count"] == 4
    assert dataset["tags"] == ["A社", "評価"]
    assert Path(dataset["stored_path"]).read_text(encoding="utf-8") == CSV

    schema = ingest.dataset_schema(dataset["id"])
    kinds = {column["name"]: column["kind"] for column in schema["columns"]}
    assert kinds == {"time": "numeric", "speed": "numeric", "rpm": "numeric", "mode": "other"}


def test_bulk_tags_are_deduplicated_and_removable(ingest_csv) -> None:
    first = ingest_csv(CSV, filename="first.csv", tags=["既存"])
    second = ingest_csv(CSV, filename="second.csv")

    result = ingest.bulk_update_tags(
        [first["id"], second["id"]],
        add=["共通", "共通"],
        remove=["既存"],
    )

    assert result == {"updated": 2}
    assert ingest.get_dataset(first["id"])["tags"] == ["共通"]
    assert ingest.get_dataset(second["id"])["tags"] == ["共通"]
    assert ingest.all_tags() == ["共通"]


def test_delete_dataset_removes_table_metadata_and_original(ingest_csv) -> None:
    dataset = ingest_csv(CSV)
    stored_path = Path(dataset["stored_path"])

    ingest.delete_dataset(dataset["id"])

    assert not stored_path.exists()
    assert ingest.list_datasets() == []
    with db.duck() as con:
        tables = {row[0] for row in con.execute("SHOW TABLES").fetchall()}
    assert dataset["table_name"] not in tables
    with pytest.raises(ingest.IngestError, match="見つかりません"):
        ingest.get_dataset(dataset["id"])


def test_rejects_unsupported_extension(ingest_csv) -> None:
    with pytest.raises(ingest.IngestError, match="未対応の拡張子"):
        ingest_csv(CSV, filename="sample.txt")
