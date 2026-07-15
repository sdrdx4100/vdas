from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import cohorts, queries
from app.main import app


CSV_A = """time,speed,rpm,gear
0,0,800,1
1,10,1000,1
2,20,1200,2
3,30,1400,2
4,40,1600,3
5,50,1800,3
"""

CSV_B = """time,speed,rpm,gear
0,0,700,1
1,5,800,2
2,10,900,1
3,15,1000,2
4,20,1100,3
5,25,1200,3
"""


def specs() -> list[dict]:
    return [
        {"name": "A", "tags": ["A社"], "match": "all"},
        {"name": "B", "tags": ["B社"], "match": "all"},
    ]


def test_resolve_cohorts_supports_all_any_and_reports_overlap(ingest_csv) -> None:
    first = ingest_csv(CSV_A, filename="a.csv", tags=["A社", "共通"])
    second = ingest_csv(CSV_B, filename="b.csv", tags=["B社", "共通"])
    ingest_csv(CSV_B, filename="other.csv", tags=["その他"])

    result = cohorts.resolve_cohorts(
        [
            {"name": "AB", "tags": ["A社", "B社"], "match": "any"},
            {"name": "共通", "tags": ["共通"], "match": "all"},
        ]
    )

    assert set(result["cohorts"][0]["dataset_ids"]) == {second["id"], first["id"]}
    assert set(result["cohorts"][1]["dataset_ids"]) == {second["id"], first["id"]}
    assert {overlap["dataset_id"] for overlap in result["overlaps"]} == {first["id"], second["id"]}


def test_resolve_cohorts_rejects_empty_groups(ingest_csv) -> None:
    ingest_csv(CSV_A, tags=["A社"])

    with pytest.raises(queries.QueryError, match="該当するデータセットがありません"):
        cohorts.resolve_cohorts(specs())


def test_cohort_histogram_returns_pooled_and_equal_dataset_weights(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a1.csv", tags=["A社"])
    ingest_csv("speed,rpm\n0,800\n50,1800\n", filename="a2.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])

    result = cohorts.compare_histogram(specs(), "speed", bins=5)

    assert result["kind"] == "numeric"
    assert result["edges"] == [0, 10, 20, 30, 40, 50]
    assert [cohort["name"] for cohort in result["cohorts"]] == ["A", "B"]
    assert result["cohorts"][0]["dataset_count"] == 2
    assert result["cohorts"][0]["total_points"] == 8
    assert sum(result["cohorts"][0]["pooled_percents"]) == pytest.approx(100)
    assert sum(result["cohorts"][0]["mean_dataset_percents"]) == pytest.approx(100, abs=0.001)


def test_cohort_histogram2d_uses_common_edges_and_density(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])

    result = cohorts.compare_histogram2d(specs(), "speed", "rpm", bins_x=5, bins_y=5)

    assert result["x_edges"] == [0, 10, 20, 30, 40, 50]
    assert result["y_edges"][0] == 700
    assert result["y_edges"][-1] == 1800
    assert [cohort["total_points"] for cohort in result["cohorts"]] == [6, 6]
    for cohort in result["cohorts"]:
        assert len(cohort["counts"]) == 5
        assert all(len(row) == 5 for row in cohort["counts"])
        assert sum(map(sum, cohort["counts"])) == 6
        assert sum(map(sum, cohort["pooled_percents"])) == pytest.approx(100, abs=1e-4)


def test_cohort_transitions_compare_event_frequency(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])

    result = cohorts.compare_transitions(specs(), "gear", "time")

    assert result["rate"] == {"kind": "rows", "denominator_column": None, "scale": 1000.0}
    assert result["transitions"] == ["1→2", "2→3", "2→1"]
    assert result["cohorts"][0]["counts"] == [1, 1, 0]
    assert result["cohorts"][1]["counts"] == [2, 1, 1]
    assert result["cohorts"][0]["total_events"] == 2
    assert result["cohorts"][1]["total_events"] == 4


def test_cohort_transitions_can_normalize_by_numeric_span(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])

    result = cohorts.compare_transitions(
        specs(),
        "gear",
        "time",
        denominator_column="time",
        denominator_scale=3600,
    )

    assert result["rate"] == {"kind": "span", "denominator_column": "time", "scale": 3600}
    assert result["cohorts"][0]["pooled_rates"] == [720.0, 720.0, 0.0]
    assert result["cohorts"][1]["pooled_rates"] == [1440.0, 720.0, 720.0]


def test_cohort_api_resolves_and_aggregates(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])
    payload = {"cohorts": specs()}

    with TestClient(app) as client:
        resolved = client.post("/api/compare/cohorts/resolve", json=payload)
        histogram = client.post(
            "/api/compare/cohorts/histogram",
            json={**payload, "column": "gear", "bins": 5, "filters": []},
        )
        histogram2d = client.post(
            "/api/compare/cohorts/histogram2d",
            json={**payload, "x": "speed", "y": "rpm", "bins_x": 5, "bins_y": 5},
        )
        transitions = client.post(
            "/api/compare/cohorts/transitions",
            json={**payload, "state_column": "gear", "order_by": "time"},
        )

    assert resolved.status_code == 200
    assert [item["dataset_count"] for item in resolved.json()["cohorts"]] == [1, 1]
    assert histogram.status_code == 200
    assert [item["total_points"] for item in histogram.json()["cohorts"]] == [6, 6]
    assert histogram2d.status_code == 200
    assert [item["total_points"] for item in histogram2d.json()["cohorts"]] == [6, 6]
    assert transitions.status_code == 200
    assert [item["total_events"] for item in transitions.json()["cohorts"]] == [2, 4]


def test_cohort_api_validates_at_least_two_groups() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/compare/cohorts/resolve",
            json={"cohorts": [{"name": "A", "tags": ["A社"]}]},
        )

    assert response.status_code == 422
