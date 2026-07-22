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


def test_chart_groups_bar_share(ingest_csv) -> None:
    a = ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    b = ingest_csv(CSV_B, filename="b.csv", tags=["B社"])
    res = queries.chart_groups(
        [
            {"label": "A社", "dataset_ids": [a["id"]]},
            {"label": "B社", "dataset_ids": [b["id"]]},
        ],
        "bar", x="gear", agg="share",
    )
    assert res["categories"] == ["1", "2", "3"]
    assert [s["label"] for s in res["series"]] == ["A社", "B社"]
    for series in res["series"]:
        assert sum(v for v in series["values"] if v is not None) == pytest.approx(100.0, abs=0.01)
    assert [s["label"] for s in res["stats"]] == ["A社", "B社"]


def test_chart_groups_pools_members(ingest_csv) -> None:
    a1 = ingest_csv(CSV_A, filename="a1.csv")
    a2 = ingest_csv(CSV_A, filename="a2.csv")
    b = ingest_csv(CSV_B, filename="b.csv")
    res = queries.chart_groups(
        [
            {"label": "A社", "dataset_ids": [a1["id"], a2["id"]]},
            {"label": "B社", "dataset_ids": [b["id"]]},
        ],
        "histogram", x="speed", bins=5,
    )
    assert res["sub"] == "numeric"
    assert sum(res["series"][0]["counts"]) == 12  # 2ログ分がプールされる
    assert sum(res["series"][1]["counts"]) == 4


def test_chart_groups_scatter_and_heatmap(ingest_csv) -> None:
    a = ingest_csv(CSV_A, filename="a.csv")
    b = ingest_csv(CSV_B, filename="b.csv")
    groups = [
        {"label": "A", "dataset_ids": [a["id"]]},
        {"label": "B", "dataset_ids": [b["id"]]},
    ]
    scatter = queries.chart_groups(groups, "scatter", x="speed", y="rpm")
    assert len(scatter["series"]) == 2
    assert scatter["series"][0]["total_rows"] == 6
    heatmap = queries.chart_groups(groups, "heatmap", x="speed", y="rpm", bins=10)
    assert len(heatmap["series"]) == 2
    assert len(heatmap["series"][0]["matrix"]) == 10


def test_chart_groups_missing_column_names_group(ingest_csv) -> None:
    a = ingest_csv(CSV_A, filename="a.csv")
    b = ingest_csv("time,other\n0,1\n", filename="b.csv")
    with pytest.raises(queries.QueryError, match="B"):
        queries.chart_groups(
            [
                {"label": "A", "dataset_ids": [a["id"]]},
                {"label": "B", "dataset_ids": [b["id"]]},
            ],
            "histogram", x="speed",
        )


def test_chart_groups_heatmap_returns_group_normalized_percents(ingest_csv) -> None:
    # A社は2ログ(計12行)、B社は1ログ(6行)で母数が違う
    a1 = ingest_csv(CSV_A, filename="a1.csv")
    a2 = ingest_csv(CSV_A, filename="a2.csv")
    b = ingest_csv(CSV_B, filename="b.csv")
    res = queries.chart_groups(
        [
            {"label": "A社", "dataset_ids": [a1["id"], a2["id"]]},
            {"label": "B社", "dataset_ids": [b["id"]]},
        ],
        "heatmap", x="speed", y="rpm", bins=10,
    )
    for series in res["series"]:
        # 各グループの割合% は母数に関わらず合計100%になる
        total = sum(sum(row) for row in series["percents"])
        assert total == pytest.approx(100.0, abs=0.01)
