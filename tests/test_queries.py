from __future__ import annotations

import pytest

from app import queries


CSV_A = """time,speed,rpm,mode
0,0,800,idle
1,10,1000,drive
2,20,1200,drive
3,30,1400,drive
4,40,1600,drive
5,50,1800,drive
"""

CSV_B = """time,speed,rpm,mode
0,0,700,idle
1,5,800,drive
2,10,900,drive
3,15,1000,drive
4,20,1100,drive
5,25,1200,drive
"""


def test_timeseries_filters_orders_and_downsamples(ingest_csv) -> None:
    dataset = ingest_csv(CSV_A)

    result = queries.timeseries(
        dataset["id"],
        "time",
        ["speed", "rpm"],
        filters=[{"column": "speed", "op": "ge", "value": 20}],
        max_points=2,
    )

    assert result["total_rows"] == 4
    assert result["returned_rows"] == 2
    assert result["stride"] == 2
    assert result["data"] == {"time": [2, 4], "speed": [20, 40], "rpm": [1200, 1600]}


def test_histogram_uses_all_rows_and_fixed_bin_boundaries(ingest_csv) -> None:
    dataset = ingest_csv(CSV_A)

    result = queries.histogram(dataset["id"], "speed", bins=5)

    assert result["kind"] == "numeric"
    assert result["edges"] == [0, 10, 20, 30, 40, 50]
    assert result["counts"] == [1, 1, 1, 1, 2]


def test_categorical_histogram_and_correlation(ingest_csv) -> None:
    dataset = ingest_csv(CSV_A)

    histogram = queries.histogram(dataset["id"], "mode")
    correlation = queries.correlation(dataset["id"], ["speed", "rpm"])

    assert histogram == {"kind": "categorical", "labels": ["drive", "idle"], "counts": [5, 1]}
    assert correlation["columns"] == ["speed", "rpm"]
    assert correlation["matrix"] == [[1.0, 1.0], [1.0, 1.0]]


def test_compare_summary_and_histogram_share_dataset_axis(ingest_csv) -> None:
    first = ingest_csv(CSV_A, filename="a.csv")
    second = ingest_csv(CSV_B, filename="b.csv")
    ids = [first["id"], second["id"]]

    summary = queries.compare_summary(ids, "speed")
    histogram = queries.compare_histogram(ids, "speed", bins=5)

    assert [row["dataset_id"] for row in summary["series"]] == ids
    assert [row["avg"] for row in summary["series"]] == [25.0, 12.5]
    assert [row["dataset_id"] for row in histogram["series"]] == ids
    assert all(sum(row["counts"]) == 6 for row in histogram["series"])


def test_preview_summary_and_scatter(ingest_csv) -> None:
    dataset = ingest_csv(CSV_A)

    preview = queries.preview(dataset["id"], limit=2)
    summary = queries.summary(dataset["id"])
    scatter = queries.scatter(dataset["id"], "speed", "rpm", "mode", max_points=3)

    assert preview["columns"] == ["time", "speed", "rpm", "mode"]
    assert preview["rows"] == [[0, 0, 800, "idle"], [1, 10, 1000, "drive"]]
    assert {row["column_name"] for row in summary["stats"]} == {"time", "speed", "rpm", "mode"}
    assert scatter["total_rows"] == 6
    assert scatter["returned_rows"] == 3
    assert scatter["data"] == {
        "speed": [0, 20, 40],
        "rpm": [800, 1200, 1600],
        "mode": ["idle", "drive", "drive"],
    }


def test_all_compare_views_return_aligned_series(ingest_csv) -> None:
    first = ingest_csv(CSV_A, filename="a.csv")
    second = ingest_csv(CSV_B, filename="b.csv")
    ids = [first["id"], second["id"]]

    groupstats = queries.compare_groupstats(ids, "speed", "mode")
    curve = queries.compare_curve(ids, "time", "speed", bins=5)
    cdf = queries.compare_cdf(ids, "speed")
    diff = queries.compare_diff(ids, baseline=first["id"])

    assert groupstats["groups"] == ["drive", "idle"]
    assert [row["dataset_id"] for row in groupstats["series"]] == ids
    assert len(curve["centers"]) == 5
    assert [row["dataset_id"] for row in curve["series"]] == ids
    assert len(cdf["percents"]) == 101
    assert cdf["series"][0]["values"] == pytest.approx([index * 0.5 for index in range(101)])
    assert diff["baseline"] == first["id"]
    assert {signal["name"] for signal in diff["signals"]} == {"time", "speed", "rpm"}
    assert all(signal["comps"][0]["dataset_id"] == second["id"] for signal in diff["signals"])


def test_compare_categorical_histogram_uses_common_labels(ingest_csv) -> None:
    first = ingest_csv(CSV_A, filename="a.csv")
    second = ingest_csv(CSV_B.replace("drive", "sport"), filename="b.csv")

    result = queries.compare_histogram([first["id"], second["id"]], "mode")

    assert result["kind"] == "categorical"
    assert result["labels"] == ["drive", "sport", "idle"]
    assert result["series"][0]["counts"] == [5, 0, 1]
    assert result["series"][1]["counts"] == [0, 5, 1]


def test_invalid_filter_column_is_rejected(ingest_csv) -> None:
    dataset = ingest_csv(CSV_A)

    with pytest.raises(queries.QueryError, match="列が存在しません"):
        queries.timeseries(
            dataset["id"],
            "time",
            ["speed"],
            filters=[{"column": "missing", "op": "eq", "value": 1}],
        )


@pytest.mark.parametrize("op", ["notnull", "isnull", "contains"])
def test_supported_filter_operators_execute(ingest_csv, op: str) -> None:
    dataset = ingest_csv(CSV_A)
    value = "riv" if op == "contains" else None

    result = queries.histogram(
        dataset["id"],
        "mode",
        filters=[{"column": "mode", "op": op, "value": value}],
    )

    if op == "isnull":
        assert result["counts"] == []
    elif op == "contains":
        assert result == {"kind": "categorical", "labels": ["drive"], "counts": [5]}
    else:
        assert sum(result["counts"]) == 6
