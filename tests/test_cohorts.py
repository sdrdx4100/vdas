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


def test_single_tag_cohort_can_be_analyzed_without_comparison(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])

    single = [{"name": "A", "tags": ["A社"], "match": "all"}]
    histogram = cohorts.compare_histogram(single, "speed", bins=5)
    summary = cohorts.compare_dataset_summary(single, "speed", metric="avg")
    density = cohorts.compare_histogram2d(single, "speed", "rpm", bins_x=5, bins_y=5)
    transitions = cohorts.compare_transitions(single, "gear", "time")

    assert [item["name"] for item in histogram["cohorts"]] == ["A"]
    assert histogram["cohorts"][0]["total_points"] == 6
    assert summary["cohorts"][0]["summary"]["n"] == 1
    assert summary["comparison"] is None
    assert len(density["cohorts"]) == 1
    assert transitions["cohorts"][0]["total_events"] == 2


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


def test_cohort_dataset_summary_treats_each_dataset_as_one_sample(ingest_csv) -> None:
    ingest_csv("speed\n0\n10\n", filename="a1.csv", tags=["A社"])
    ingest_csv("speed\n10\n20\n", filename="a2.csv", tags=["A社"])
    ingest_csv("speed\n20\n30\n", filename="b1.csv", tags=["B社"])
    ingest_csv("speed\n30\n40\n", filename="b2.csv", tags=["B社"])

    result = cohorts.compare_dataset_summary(specs(), "speed", metric="avg")

    assert sorted(result["cohorts"][0]["values"]) == [5.0, 15.0]
    assert sorted(result["cohorts"][1]["values"]) == [25.0, 35.0]
    assert result["cohorts"][0]["summary"]["mean"] == 10.0
    assert result["cohorts"][1]["summary"]["mean"] == 30.0
    assert result["comparison"]["difference"] == 20.0
    assert result["comparison"]["cliffs_delta"] == 1.0
    assert result["comparison"]["hedges_g"] is not None


def test_cohort_dataset_summary_compares_multiple_groups_to_first(ingest_csv) -> None:
    ingest_csv("speed\n0\n10\n", filename="base.csv", tags=["基準"])
    ingest_csv("speed\n10\n20\n", filename="group2.csv", tags=["条件2"])
    ingest_csv("speed\n20\n30\n", filename="group3.csv", tags=["条件3"])
    groups = [
        {"name": "基準群", "tags": ["基準"], "match": "all"},
        {"name": "条件2群", "tags": ["条件2"], "match": "all"},
        {"name": "条件3群", "tags": ["条件3"], "match": "all"},
    ]

    result = cohorts.compare_dataset_summary(groups, "speed", metric="avg")
    multi = cohorts.compare_multi_summary(groups, ["speed"], metric="avg")

    assert [cohort["name"] for cohort in result["cohorts"]] == ["基準群", "条件2群", "条件3群"]
    assert [item["comparison"] for item in result["comparisons"]] == ["条件2群", "条件3群"]
    assert [item["difference"] for item in result["comparisons"]] == [10.0, 20.0]
    assert multi["columns"] == ["speed"]
    assert len(multi["results"][0]["cohorts"]) == 3


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
        summary = client.post(
            "/api/compare/cohorts/summary",
            json={**payload, "column": "speed", "metric": "q50", "filters": []},
        )
        multi_summary = client.post(
            "/api/compare/cohorts/multisummary",
            json={**payload, "columns": ["speed", "rpm"], "metric": "avg", "filters": []},
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
    assert summary.status_code == 200
    assert [item["summary"]["n"] for item in summary.json()["cohorts"]] == [1, 1]
    assert multi_summary.status_code == 200
    assert multi_summary.json()["columns"] == ["speed", "rpm"]
    assert transitions.status_code == 200
    assert [item["total_events"] for item in transitions.json()["cohorts"]] == [2, 4]


def test_cohort_api_validates_at_least_one_group() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/compare/cohorts/resolve",
            json={"cohorts": []},
        )

    assert response.status_code == 422


EVENT_CSV_A = """time,shiftinprocess,rpm
0,0,800
1,1,1000
2,1,1200
3,0,1400
4,0,1500
5,1,2000
6,0,2100
"""

EVENT_CSV_B = """time,shiftinprocess,rpm
0,0,700
1,1,900
2,1,1000
3,1,1100
4,0,1300
"""


def test_cohort_events_extracts_runs_and_durations(ingest_csv) -> None:
    ingest_csv(EVENT_CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(EVENT_CSV_B, filename="b.csv", tags=["B社"])
    result = cohorts.compare_events(specs(), "shiftinprocess", "1", "time", time_column="time")

    by_name = {c["name"]: c for c in result["cohorts"]}
    # A: shiftinprocess=1 の区間は time 1-2 (duration 1) と time 5 (duration 0) の2件
    assert by_name["A"]["event_count"] == 2
    assert sorted(by_name["A"]["durations"]) == [0.0, 1.0]
    # B: time 1-3 の1区間 (duration 2)
    assert by_name["B"]["event_count"] == 1
    assert by_name["B"]["durations"] == [2.0]
    assert by_name["B"]["summary"]["p90"] == 2.0


def test_cohort_events_secondary_signal_average(ingest_csv) -> None:
    ingest_csv(EVENT_CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(EVENT_CSV_B, filename="b.csv", tags=["B社"])
    result = cohorts.compare_events(
        specs(), "shiftinprocess", "1", "time", time_column="time", secondary_column="rpm"
    )
    a = next(c for c in result["cohorts"] if c["name"] == "A")
    # 最初の区間 (rpm 1000,1200 の平均=1100) が含まれる
    assert 1100.0 in a["secondary_values"]


def test_cohort_events_rejects_empty_value(ingest_csv) -> None:
    ingest_csv(EVENT_CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(EVENT_CSV_B, filename="b.csv", tags=["B社"])
    with pytest.raises(queries.QueryError):
        cohorts.compare_events(specs(), "shiftinprocess", "", "time")


def test_cohort_events_endpoint(ingest_csv) -> None:
    ingest_csv(EVENT_CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(EVENT_CSV_B, filename="b.csv", tags=["B社"])
    with TestClient(app) as client:
        response = client.post(
            "/api/compare/cohorts/events",
            json={
                "cohorts": specs(),
                "state_column": "shiftinprocess",
                "value": "1",
                "order_by": "time",
                "time_column": "time",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert {c["name"] for c in data["cohorts"]} == {"A", "B"}
