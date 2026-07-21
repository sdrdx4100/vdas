"""自由分析 (汎用チャート) と割合比較のテスト。"""
from __future__ import annotations

import pytest

from app import cohorts, queries

CSV_A = """time,speed,rpm,gear,mode
0,10,1000,1,idle
1,20,1500,1,drive
2,30,2000,2,drive
3,40,2500,2,drive
4,50,3000,2,drive
5,60,3500,3,drive
"""

CSV_B = """time,speed,rpm,gear,mode
0,5,900,1,idle
1,15,1200,2,drive
2,25,1500,2,drive
3,35,1800,3,drive
"""


def test_chart_scatter_with_color(ingest_csv) -> None:
    ds = ingest_csv(CSV_A)
    res = queries.chart(ds["id"], "scatter", x="speed", y="rpm", color="gear")
    assert res["returned_rows"] == 6
    assert set(res["data"]) == {"speed", "rpm", "gear"}
    assert res["stats"]["column"] == "rpm"


def test_chart_bar_share_normalizes_to_100(ingest_csv) -> None:
    ds = ingest_csv(CSV_A)
    res = queries.chart(ds["id"], "bar", x="gear", agg="share")
    assert res["groups"] == ["1", "2", "3"]
    values = res["series"][0]["values"]
    assert values == pytest.approx([100 / 3, 50.0, 100 / 6], abs=0.01)
    assert sum(values) == pytest.approx(100.0, abs=0.01)


def test_chart_bar_share_normalizes_within_color_group(ingest_csv) -> None:
    ds = ingest_csv(CSV_A)
    res = queries.chart(ds["id"], "bar", x="gear", agg="share", color="mode")
    for series in res["series"]:
        total = sum(v for v in series["values"] if v is not None)
        assert total == pytest.approx(100.0, abs=0.01)


def test_chart_histogram_percents_per_color(ingest_csv) -> None:
    ds = ingest_csv(CSV_A)
    res = queries.chart(ds["id"], "histogram", x="speed", color="mode", bins=5)
    assert res["sub"] == "numeric"
    for series in res["series"]:
        assert sum(series["percents"]) == pytest.approx(100.0, abs=0.01)


def test_chart_rejects_unknown_kind(ingest_csv) -> None:
    ds = ingest_csv(CSV_A)
    with pytest.raises(queries.QueryError):
        queries.chart(ds["id"], "pie", x="speed")


def test_compare_histogram_as_category_treats_numeric_as_share(ingest_csv) -> None:
    a = ingest_csv(CSV_A, filename="a.csv")
    b = ingest_csv(CSV_B, filename="b.csv")
    res = queries.compare_histogram([a["id"], b["id"]], "gear", as_category=True)
    assert res["kind"] == "categorical"
    assert res["labels"] == ["2", "1", "3"] or set(res["labels"]) == {"1", "2", "3"}
    for series in res["series"]:
        assert sum(series["percents"]) == pytest.approx(100.0, abs=0.01)


def test_cohort_histogram_as_category(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])
    res = cohorts.compare_histogram(
        [
            {"name": "A", "tags": ["A社"], "match": "all"},
            {"name": "B", "tags": ["B社"], "match": "all"},
        ],
        "gear",
        as_category=True,
    )
    assert res["kind"] == "categorical"
    for cohort in res["cohorts"]:
        assert sum(cohort["pooled_percents"]) == pytest.approx(100.0, abs=0.01)
