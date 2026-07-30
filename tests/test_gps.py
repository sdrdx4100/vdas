"""GPS 検出・ペア判定・地図トラック結合のテスト。"""
from __future__ import annotations

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import gps, ingest, queries
from app.main import app

SIG_CSV = """time,speed,rpm
0,10,1000
1,20,1500
2,30,2000
3,40,2500
4,50,3000
"""

# 信号と同じ行数・同じ時間の流れで並ぶ GPS ログ
GPS_CSV = """latitude,longitude
35.00,139.00
35.01,139.01
35.02,139.02
35.03,139.03
35.04,139.04
"""


def test_detect_latlon_variants() -> None:
    cols = [
        {"name": "Latitude", "kind": "numeric"},
        {"name": "Longitude", "kind": "numeric"},
    ]
    assert gps.detect_latlon(cols) == ("Latitude", "Longitude")
    cols2 = [
        {"name": "GPS_Lat_deg", "kind": "numeric"},
        {"name": "GPS_Lon_deg", "kind": "numeric"},
        {"name": "speed", "kind": "numeric"},
    ]
    lat, lon = gps.detect_latlon(cols2)
    assert lat == "GPS_Lat_deg" and lon == "GPS_Lon_deg"


def test_detect_latlon_ignores_non_numeric() -> None:
    cols = [
        {"name": "latitude", "kind": "other"},
        {"name": "longitude", "kind": "other"},
    ]
    assert gps.detect_latlon(cols) == (None, None)


def test_find_gps_pair_by_filename(ingest_csv) -> None:
    sig = ingest_csv(SIG_CSV, filename="drive001.csv")
    ingest_csv(GPS_CSV, filename="drive001.csv")  # 同名の GPS ファイル
    pair = gps.find_gps_pair(sig["id"])
    assert pair is not None
    assert pair["lat_col"] == "latitude"
    assert pair["lon_col"] == "longitude"


def test_extract_timestamp_formats() -> None:
    # YYMMDD_HHMMSS と YYYY-MM-DD_HH-MM-SS はどちらも同じ日時を表す
    assert gps.extract_timestamp("260518_191805.parquet") == datetime(2026, 5, 18, 19, 18, 5)
    assert gps.extract_timestamp("busloigging_2026-05-18_19-18-05.parquet") == datetime(2026, 5, 18, 19, 18, 5)
    assert gps.extract_timestamp("20260518_191805.csv") == datetime(2026, 5, 18, 19, 18, 5)
    assert gps.extract_timestamp("no_timestamp_here.csv") is None
    assert gps.extract_timestamp("drive001.csv") is None  # 誤検出しない


def test_find_gps_pair_by_timestamp(ingest_csv) -> None:
    # 命名規則が違っても、ファイル名の記録開始日時が一致すれば自動ペア (B社ケース)
    sig = ingest_csv(SIG_CSV, filename="260518_191805.csv")
    ingest_csv(GPS_CSV, filename="busloigging_2026-05-18_19-18-05.csv")
    pair = gps.find_gps_pair(sig["id"])
    assert pair is not None
    assert pair["match"] == "timestamp"
    assert pair["lat_col"] == "latitude"


def test_name_match_takes_priority_over_timestamp(ingest_csv) -> None:
    sig = ingest_csv(SIG_CSV, filename="drive_260518_191805.csv")
    ingest_csv(GPS_CSV, filename="drive_260518_191805.csv")        # 同じ基準名
    ingest_csv(GPS_CSV, filename="other_2026-05-18_19-18-05.csv")  # 時刻は一致だが別名
    pair = gps.find_gps_pair(sig["id"])
    assert pair["match"] == "name"


def test_timestamp_pair_via_api(ingest_csv) -> None:
    with TestClient(app) as client:
        sig = client.post("/api/datasets/upload",
                          files={"file": ("260518_191805.csv", SIG_CSV.encode(), "text/csv")}).json()
        client.post("/api/datasets/upload",
                    files={"file": ("busloigging_2026-05-18_19-18-05.csv", GPS_CSV.encode(), "text/csv")})
        pairs = client.get("/api/gps/pairs").json()
        assert len(pairs) == 1
        assert pairs[0]["signal"]["id"] == sig["id"]
        assert pairs[0]["match"] == "timestamp"


def test_tag_link_detects_gps_companion() -> None:
    assert gps._tag_link(["トヨタ"], ["トヨタ_GPS"])
    assert gps._tag_link(["トヨタ"], ["トヨタ-gps"])
    assert gps._tag_link(["A社", "高速"], ["A社_位置"])
    assert not gps._tag_link(["トヨタ"], ["ホンダ_GPS"])
    assert not gps._tag_link([], ["トヨタ_GPS"])  # 信号側にタグが無ければ不成立


def test_find_gps_pair_by_tag_only(ingest_csv) -> None:
    # ファイル名では一致しないが、タグ トヨタ ↔ トヨタ_GPS で一意に決まる
    sig = ingest_csv(SIG_CSV, filename="aaa.csv", tags=["トヨタ"])
    ingest_csv(GPS_CSV, filename="bbb.csv", tags=["トヨタ_GPS"])
    pair = gps.find_gps_pair(sig["id"])
    assert pair is not None
    assert pair["match"] == "tag"


def test_tag_disambiguates_timestamp_matches(ingest_csv) -> None:
    # 同時刻の GPS が2つあるとき、タグが一致する方 (トヨタ_GPS) を選ぶ
    sig = ingest_csv(SIG_CSV, filename="260518_191805.csv", tags=["トヨタ"])
    honda = ingest_csv(GPS_CSV, filename="honda_2026-05-18_19-18-05.csv", tags=["ホンダ_GPS"])
    toyota = ingest_csv(GPS_CSV, filename="toyota_2026-05-18_19-18-05.csv", tags=["トヨタ_GPS"])
    pair = gps.find_gps_pair(sig["id"])
    assert pair["dataset"]["id"] == toyota["id"]
    assert pair["dataset"]["id"] != honda["id"]


GPS_TOKYO = "latitude,longitude\n35.60,139.60\n35.61,139.61\n35.62,139.62\n"
GPS_TOKYO2 = "latitude,longitude\n35.605,139.605\n35.615,139.615\n"  # 東京圏で重なる
GPS_TOKYO_PARALLEL = "latitude,longitude\n35.63,139.63\n35.64,139.64\n"  # 非重複だが近い
GPS_OSAKA = "latitude,longitude\n34.60,135.50\n34.61,135.51\n"       # 遠い


def test_similar_runs_ranks_by_proximity(ingest_csv) -> None:
    ref = ingest_csv(SIG_CSV, filename="ref.csv")
    ingest_csv(GPS_TOKYO, filename="ref.csv")
    near = ingest_csv(SIG_CSV, filename="near.csv")
    ingest_csv(GPS_TOKYO2, filename="near.csv")
    far = ingest_csv(SIG_CSV, filename="far.csv")
    ingest_csv(GPS_OSAKA, filename="far.csv")
    res = gps.similar_runs(ref["id"])
    assert res["has_reference"]
    ids = [r["signal"]["id"] for r in res["runs"]]
    assert ids[0] == near["id"]  # bbox が重なる方が先頭
    assert set(ids) == {near["id"], far["id"]}  # 自分自身は除外
    assert res["runs"][0]["overlaps"] and res["runs"][0]["recommended"]
    far_run = next(r for r in res["runs"] if r["signal"]["id"] == far["id"])
    assert far_run["overlaps"] is False
    assert res["runs"][0]["distance_unit"] == "km"
    assert res["runs"][0]["distance"] < far_run["distance"]


def test_similar_runs_recognizes_near_non_overlapping_route(ingest_csv) -> None:
    ref = ingest_csv(SIG_CSV, filename="ref.csv")
    ingest_csv(GPS_TOKYO, filename="ref.csv")
    near = ingest_csv(SIG_CSV, filename="parallel.csv")
    ingest_csv(GPS_TOKYO_PARALLEL, filename="parallel.csv")
    res = gps.similar_runs(ref["id"])
    run = next(r for r in res["runs"] if r["signal"]["id"] == near["id"])
    assert not run["overlaps"]
    assert run["nearby"] and run["recommended"]
    assert run["relative_distance"] <= 1.5


def test_similar_runs_same_tag_recommended(ingest_csv) -> None:
    ref = ingest_csv(SIG_CSV, filename="r.csv", tags=["トヨタ"])
    ingest_csv(GPS_TOKYO, filename="r.csv", tags=["トヨタ_GPS"])
    cand = ingest_csv(SIG_CSV, filename="c.csv", tags=["トヨタ"])
    ingest_csv(GPS_OSAKA, filename="c.csv", tags=["トヨタ_GPS"])  # 遠いが同じ会社タグ
    res = gps.similar_runs(ref["id"])
    run = next(r for r in res["runs"] if r["signal"]["id"] == cand["id"])
    assert run["same_tag"] and run["recommended"]


def test_find_gps_pair_with_suffix(ingest_csv) -> None:
    sig = ingest_csv(SIG_CSV, filename="drive002.csv")
    ingest_csv(GPS_CSV, filename="drive002_gps.csv")  # 接尾辞つき
    pair = gps.find_gps_pair(sig["id"])
    assert pair is not None
    assert gps.is_gps_dataset(pair["dataset"]["id"])


def test_gps_pairs_excludes_gps_as_signal(ingest_csv) -> None:
    ingest_csv(SIG_CSV, filename="run.csv")
    ingest_csv(GPS_CSV, filename="run.csv")
    pairs = gps.gps_pairs()
    assert len(pairs) == 1
    assert pairs[0]["signal"]["original_filename"] == "run.csv"
    assert pairs[0]["lat_col"] == "latitude"
    assert gps.is_gps_dataset(pairs[0]["gps"]["id"])


def test_map_track_aligns_by_rowindex(ingest_csv) -> None:
    sig = ingest_csv(SIG_CSV, filename="d.csv")
    ingest_csv(GPS_CSV, filename="d.csv")
    res = gps.map_track(sig["id"], signals=["speed", "rpm"], color_signal="speed")
    assert res["lat_col"] == "latitude"
    assert res["total_rows"] == 5
    assert res["lat"] == [35.0, 35.01, 35.02, 35.03, 35.04]
    assert res["signals"]["speed"] == [10, 20, 30, 40, 50]
    assert res["x"] == "time"
    assert res["x_values"] == [0, 1, 2, 3, 4]
    assert res["color_values"] == [10, 20, 30, 40, 50]
    # 中心は軌跡の平均あたり
    assert 35.0 <= res["center"]["lat"] <= 35.04


def test_map_track_aligns_by_time_when_row_position_disagrees(ingest_csv) -> None:
    """B社ケース: 行数が一致せず記録開始も数秒ずれているが、GPS側にも
    経過時間列があり双方のファイル名から実開始時刻が分かる場合は、
    rowid の位置ではなく実際の時刻が近い行同士を対応づける。"""
    sig = ingest_csv(
        "time,speed\n0,10\n1,20\n2,30\n3,40\n4,50\n",
        filename="260518_191805.csv")  # 開始 19:18:05, 5行
    gpx = ingest_csv(
        "time,latitude,longitude\n"
        "0,35.00,139.00\n1,35.01,139.01\n2,35.02,139.02\n"
        "3,35.03,139.03\n4,35.04,139.04\n5,35.05,139.05\n",
        filename="gps_2026-05-18_19-18-08.csv")  # 開始 19:18:08 (3秒後), 6行
    res = gps.map_track(sig["id"], signals=["speed"], gps_id=gpx["id"])
    assert res["align_mode"] == "time"
    # rowid のままなら [35.00,35.01,35.02,35.03,35.04] になるはずだが、
    # 実時刻では信号側の各行はGPS開始(19:18:08)より前 or 同時刻の点に
    # 最も近く、最後の行だけが次の点(35.01)に対応する。
    assert res["lat"] == [35.00, 35.00, 35.00, 35.00, 35.01]
    assert res["signals"]["speed"] == [10, 20, 30, 40, 50]


def test_map_track_falls_back_to_rowid_when_times_disagree_too_much(ingest_csv) -> None:
    """時刻情報はあっても月単位でズレている (パース失敗などで信頼できない)
    場合は、時刻整列を諦めて従来の rowid 結合にフォールバックする。"""
    sig = ingest_csv(
        "time,speed\n0,10\n1,20\n2,30\n3,40\n4,50\n",
        filename="260101_000000.csv")
    gpx = ingest_csv(
        "time,latitude,longitude\n"
        "0,35.00,139.00\n1,35.01,139.01\n2,35.02,139.02\n"
        "3,35.03,139.03\n4,35.04,139.04\n",
        filename="gps_2026-06-01_00-00-00.csv")
    res = gps.map_track(sig["id"], signals=["speed"], gps_id=gpx["id"])
    assert res["align_mode"] == "rowid"
    assert res["lat"] == [35.00, 35.01, 35.02, 35.03, 35.04]


def test_stitched_signal_and_gps_logs_pair_and_plot(ingest_csv) -> None:
    """3分割された信号/GPSを同じ順で結合すれば、1走行として自動ペアできる。"""
    signal_parts = [
        ingest_csv(f"time,speed\n{i * 2},{10 + i * 20}\n{i * 2 + 1},{20 + i * 20}\n",
                   filename=f"split_signal_{i}.csv")
        for i in range(3)
    ]
    gps_parts = [
        ingest_csv(
            "latitude,longitude\n"
            f"{35 + i * 0.02:.2f},{139 + i * 0.02:.2f}\n"
            f"{35.01 + i * 0.02:.2f},{139.01 + i * 0.02:.2f}\n",
            filename=f"split_gps_{i}.csv",
        )
        for i in range(3)
    ]
    stitched_signal = ingest.concat_datasets(
        [part["id"] for part in signal_parts], name="分割走行_結合済み")
    stitched_gps = ingest.concat_datasets(
        [part["id"] for part in gps_parts], name="分割走行_結合済み")

    pair = gps.find_gps_pair(stitched_signal["id"])
    assert pair is not None
    assert pair["dataset"]["id"] == stitched_gps["id"]
    result = gps.map_track(stitched_signal["id"], signals=["speed"])
    assert result["total_rows"] == 6
    assert result["signals"]["speed"] == [10, 20, 30, 40, 50, 60]
    assert result["lat"] == [35.0, 35.01, 35.02, 35.03, 35.04, 35.05]


def test_map_track_downsamples(ingest_csv) -> None:
    n = 2000
    sig = "time,speed\n" + "\n".join(f"{i},{i%60}" for i in range(n)) + "\n"
    gpx = "lat,lon\n" + "\n".join(f"{35+i*1e-5},{139+i*1e-5}" for i in range(n)) + "\n"
    s = ingest_csv(sig, filename="big.csv")
    ingest_csv(gpx, filename="big.csv")
    res = gps.map_track(s["id"], signals=["speed"], max_points=500)
    assert res["total_rows"] == n
    assert res["stride"] >= 4
    assert res["returned_rows"] <= 520
    assert len(res["lat"]) == len(res["signals"]["speed"]) == res["returned_rows"]


def test_map_track_missing_gps_raises(ingest_csv) -> None:
    sig = ingest_csv(SIG_CSV, filename="lonely.csv")
    with pytest.raises(queries.QueryError):
        gps.map_track(sig["id"], signals=["speed"])


def test_map_track_filter_keeps_alignment(ingest_csv) -> None:
    sig = ingest_csv(SIG_CSV, filename="f.csv")
    ingest_csv(GPS_CSV, filename="f.csv")
    res = gps.map_track(sig["id"], signals=["speed"],
                        filters=[{"column": "speed", "op": "ge", "value": 30}])
    assert res["total_rows"] == 3
    assert res["signals"]["speed"] == [30, 40, 50]
    # フィルタ後も GPS 側が行位置で一致している
    assert res["lat"] == [35.02, 35.03, 35.04]


# 実データの慣習: GPS_x=東経(経度), GPS_y=北緯(緯度), GPS_z=高度(メートル)
GPS_XYZ_DEG_CSV = """GPS_x,GPS_y,GPS_z
139.00,35.00,12.0
139.01,35.01,14.0
139.02,35.02,11.0
139.03,35.03,18.0
139.04,35.04,21.0
"""

# 座標がローカル座標 (メートル) のケース (GPS_x, GPS_z のみ)
GPS_XZ_M_CSV = """GPS_x,GPS_z
0,0
1200,300
2500,600
3600,1500
4000,2600
"""


def test_detect_coord_axes() -> None:
    cols = [
        {"name": "GPS_x", "kind": "numeric"},
        {"name": "GPS_y", "kind": "numeric"},
        {"name": "GPS_z", "kind": "numeric"},
    ]
    assert gps.detect_coord_axes(cols) == {"x": "GPS_x", "y": "GPS_y", "z": "GPS_z"}
    kind, coords = gps.coord_columns(cols)
    assert kind == "axes"
    assert coords == ["GPS_x", "GPS_y", "GPS_z"]


def test_gps_dataset_recognized_by_axes(ingest_csv) -> None:
    g = ingest_csv(GPS_XZ_M_CSV, filename="xz.csv")
    assert gps.is_gps_dataset(g["id"])


def test_map_track_axes_degrees_geographic(ingest_csv) -> None:
    sig = ingest_csv(SIG_CSV, filename="jp.csv")
    ingest_csv(GPS_XYZ_DEG_CSV, filename="jp.csv")
    res = gps.map_track(sig["id"], signals=["speed"])
    assert res["mode"] == "geographic"
    # 慣習どおり GPS_x=経度, GPS_y=緯度。高度 GPS_z は水平面に使わない
    assert res["lat_col"] == "GPS_y"
    assert res["lon_col"] == "GPS_x"
    assert res["lat"] == [35.0, 35.01, 35.02, 35.03, 35.04]
    assert res["lon"][0] == 139.0


def test_map_track_axes_prefers_xy_over_altitude(ingest_csv) -> None:
    # 高度 GPS_z の値が小さく緯度に見えても、慣習どおり水平面は x, y を使う
    sig = ingest_csv(SIG_CSV, filename="jp2.csv")
    ingest_csv(GPS_XYZ_DEG_CSV, filename="jp2.csv")
    res = gps.map_track(sig["id"], signals=["speed"])
    assert (res["lon_col"], res["lat_col"]) == ("GPS_x", "GPS_y")


def test_map_track_axes_meters_planar(ingest_csv) -> None:
    sig = ingest_csv(SIG_CSV, filename="loc.csv")
    ingest_csv(GPS_XZ_M_CSV, filename="loc.csv")
    res = gps.map_track(sig["id"], signals=["speed"])
    assert res["mode"] == "planar"
    assert res["px_col"] == "GPS_x"
    assert res["py_col"] == "GPS_z"
    assert res["px"] == [0, 1200, 2500, 3600, 4000]
    assert res["py"] == [0, 300, 600, 1500, 2600]


def test_map_track_returns_altitude(ingest_csv) -> None:
    # 水平面に使わなかった高度 GPS_z を色分け用に返す
    sig = ingest_csv(SIG_CSV, filename="alt.csv")
    ingest_csv(GPS_XYZ_DEG_CSV, filename="alt.csv")
    res = gps.map_track(sig["id"], signals=["speed"])
    assert res["alt_col"] == "GPS_z"
    assert res["alt_values"] == [12.0, 14.0, 11.0, 18.0, 21.0]


def test_map_track_manual_gps_and_columns(ingest_csv) -> None:
    # 自動ペアが効かない別名でも、GPS と列を手動指定すれば結合できる
    sig = ingest_csv(SIG_CSV, filename="alpha.csv")
    g = ingest_csv(GPS_CSV, filename="beta.csv")
    res = gps.map_track(sig["id"], signals=["speed"], gps_id=g["id"],
                        lat_col="latitude", lon_col="longitude")
    assert res["gps_dataset"]["id"] == g["id"]
    assert res["lon"] == [139.0, 139.01, 139.02, 139.03, 139.04]


# GPSログ自体に信号列(speed, rpm)も全部入っている自己完結型ログ
SELF_CSV = """latitude,longitude,speed,rpm
35.00,139.00,10,1000
35.01,139.01,20,1500
35.02,139.02,30,2000
35.03,139.03,40,2500
35.04,139.04,50,3000
"""


def test_self_contained_gps_log_used_without_pair(ingest_csv) -> None:
    # GPSログ自体に信号列がすべて入っているケース: 別ファイルとのペアが
    # 無くても、自分自身をGPS源として使い、そのまま地図+波形が見れる
    # (行数・記録開始時刻のズレの心配も一切ない)。
    ds = ingest_csv(SELF_CSV, filename="allinone.csv")
    pair = gps.find_gps_pair(ds["id"])
    assert pair is not None
    assert pair["match"] == "self"
    assert pair["dataset"]["id"] == ds["id"]

    res = gps.map_track(ds["id"], signals=["speed", "rpm"])
    assert res["align_mode"] == "self"
    assert res["lat"] == [35.0, 35.01, 35.02, 35.03, 35.04]
    assert res["signals"]["speed"] == [10, 20, 30, 40, 50]
    assert res["gps_dataset"]["id"] == ds["id"]
    assert res["signal_dataset"]["id"] == ds["id"]


def test_gps_pairs_includes_self_contained_log(ingest_csv) -> None:
    ds = ingest_csv(SELF_CSV, filename="allinone2.csv")
    pairs = gps.gps_pairs()
    entry = next(p for p in pairs if p["signal"]["id"] == ds["id"])
    assert entry["gps"]["id"] == ds["id"]
    assert entry["match"] == "self"


def test_pure_gps_log_excluded_from_signal_candidates(ingest_csv) -> None:
    # 座標列しかない (信号列を兼ねない) GPS専用ログは、従来どおり信号側候補にしない
    ingest_csv(GPS_CSV, filename="pureonly.csv")
    pairs = gps.gps_pairs()
    assert not any(p["signal"]["original_filename"] == "pureonly.csv" for p in pairs)


def test_gps_endpoints_through_api() -> None:
    with TestClient(app) as client:
        sig = client.post("/api/datasets/upload",
                          files={"file": ("trip.csv", SIG_CSV.encode(), "text/csv")}).json()
        client.post("/api/datasets/upload",
                    files={"file": ("trip.csv", GPS_CSV.encode(), "text/csv")})

        pairs = client.get("/api/gps/pairs")
        assert pairs.status_code == 200
        assert pairs.json()[0]["lat_col"] == "latitude"

        gps_list = client.get("/api/gps/datasets")
        assert gps_list.status_code == 200
        assert len(gps_list.json()) == 1

        similar = client.get(f"/api/gps/{sig['id']}/similar")
        assert similar.status_code == 200
        assert similar.json()["has_reference"]

        track = client.post(f"/api/gps/{sig['id']}/track",
                            json={"signals": ["speed"], "color_signal": "speed"})
        assert track.status_code == 200
        body = track.json()
        assert body["lat"] == [35.0, 35.01, 35.02, 35.03, 35.04]
        assert body["signals"]["speed"] == [10, 20, 30, 40, 50]


def test_track_missing_gps_returns_400() -> None:
    with TestClient(app) as client:
        sig = client.post("/api/datasets/upload",
                          files={"file": ("solo.csv", SIG_CSV.encode(), "text/csv")}).json()
        resp = client.post(f"/api/gps/{sig['id']}/track", json={"signals": ["speed"]})
        assert resp.status_code == 400
        assert "GPS" in resp.json()["detail"]
