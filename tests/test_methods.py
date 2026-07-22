"""回帰・PCA・相関・有意差検定のテスト。"""
from __future__ import annotations

import pytest

from app import cohorts, methods, queries

# X と Y に明確な線形関係を持たせる
CSV_A = """time,x,y,z
0,1,2.0,5
1,2,4.1,4
2,3,6.0,3
3,4,8.1,2
4,5,10.0,1
5,6,12.1,0
"""

CSV_B = """time,x,y,z
0,1,1.0,9
1,2,2.1,8
2,3,3.0,7
3,4,4.1,6
4,5,5.0,5
5,6,6.1,4
"""


def specs():
    return [
        {"name": "A", "tags": ["A社"], "match": "all"},
        {"name": "B", "tags": ["B社"], "match": "all"},
    ]


def test_regression_slopes_differ_between_groups(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])
    res = methods.cohort_regression(specs(), "x", "y")
    by = {c["name"]: c for c in res["cohorts"]}
    # A: y≈2x, B: y≈x
    assert by["A"]["slope"] == pytest.approx(2.0, abs=0.05)
    assert by["B"]["slope"] == pytest.approx(1.0, abs=0.05)
    assert by["A"]["r2"] > 0.99
    assert by["A"]["fit"]["x"] == [1.0, 6.0]


def test_regression_rejects_same_axis(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])
    with pytest.raises(queries.QueryError):
        methods.cohort_regression(specs(), "x", "x")


def test_pca_projects_and_reports_variance(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])
    res = methods.cohort_pca(specs(), ["x", "y", "z"])
    assert len(res["explained_variance"]) == 2
    assert sum(res["explained_variance"]) <= 1.0 + 1e-6
    assert {c["name"] for c in res["cohorts"]} == {"A", "B"}
    assert len(res["cohorts"][0]["pc1"]) == len(res["cohorts"][0]["pc2"])
    assert len(res["loadings"]) == 3


def test_pca_requires_two_signals(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])
    with pytest.raises(queries.QueryError):
        methods.cohort_pca(specs(), ["x"])


def test_correlation_matrix_per_group(ingest_csv) -> None:
    ingest_csv(CSV_A, filename="a.csv", tags=["A社"])
    ingest_csv(CSV_B, filename="b.csv", tags=["B社"])
    res = methods.cohort_correlation(specs(), ["x", "y", "z"])
    assert res["columns"] == ["x", "y", "z"]
    a = next(c for c in res["cohorts"] if c["name"] == "A")
    # x と y は強い正相関、x と z は強い負相関
    xi, yi, zi = 0, 1, 2
    assert a["matrix"][xi][yi] > 0.99
    assert a["matrix"][xi][zi] < -0.99


def test_summary_includes_significance_tests(ingest_csv) -> None:
    # 各グループ3ログ、値が明確に異なるようにする
    for i, v in enumerate([10, 11, 12]):
        ingest_csv(f"time,speed\n0,{v}\n1,{v}\n", filename=f"a{i}.csv", tags=["A社"])
    for i, v in enumerate([20, 21, 22]):
        ingest_csv(f"time,speed\n0,{v}\n1,{v}\n", filename=f"b{i}.csv", tags=["B社"])
    res = cohorts.compare_dataset_summary(specs(), "speed", "avg")
    cmp = res["comparison"]
    assert cmp["t_test_p"] is not None
    assert cmp["t_test_p"] < 0.05  # 明確な差
    assert cmp["mann_whitney_p"] is not None
