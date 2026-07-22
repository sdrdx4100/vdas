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


def _sine_csv(freq_hz: float, fs: float = 100.0, seconds: float = 10.0) -> str:
    import numpy as np
    n = int(fs * seconds)
    t = np.arange(n) / fs
    v = np.sin(2 * np.pi * freq_hz * t)
    lines = ["time,accel"]
    lines += [f"{ti:.4f},{vi:.6f}" for ti, vi in zip(t, v)]
    return "\n".join(lines) + "\n"


def test_spectrum_detects_dominant_frequency(ingest_csv) -> None:
    # A社=6Hz中心の振動、B社=2Hz。ピーク周波数がグループ間で違う
    ingest_csv(_sine_csv(6.0), filename="a.csv", tags=["A社"])
    ingest_csv(_sine_csv(2.0), filename="b.csv", tags=["B社"])
    res = methods.cohort_spectrum(specs(), "accel", "time", band=(4.0, 8.0))
    freqs = res["freqs"]
    by = {c["name"]: c for c in res["cohorts"]}

    def peak_freq(psd):
        import numpy as np
        return freqs[int(np.argmax(psd))]

    assert abs(peak_freq(by["A"]["psd"]) - 6.0) < 1.0
    assert abs(peak_freq(by["B"]["psd"]) - 2.0) < 1.0
    # 4-8Hz帯のエネルギーは 6Hz振動の A社 の方が大きい
    assert by["A"]["band_power"] > by["B"]["band_power"]


def test_spectrum_rejects_same_columns(ingest_csv) -> None:
    ingest_csv(_sine_csv(6.0), filename="a.csv", tags=["A社"])
    ingest_csv(_sine_csv(2.0), filename="b.csv", tags=["B社"])
    with pytest.raises(queries.QueryError):
        methods.cohort_spectrum(specs(), "time", "time")


def test_summary_supports_std_and_max_metric(ingest_csv) -> None:
    ingest_csv("time,accel\n0,0\n1,2\n2,-2\n", filename="a.csv", tags=["A社"])
    ingest_csv("time,accel\n0,0\n1,5\n2,-5\n", filename="b.csv", tags=["B社"])
    res = cohorts.compare_dataset_summary(specs(), "accel", metric="std")
    by = {c["name"]: c for c in res["cohorts"]}
    # B社の方がばらつきが大きい
    assert by["B"]["values"][0] > by["A"]["values"][0]
