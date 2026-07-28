"""GPS 検出・ペア判定・地図トラック結合のテスト。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import gps, queries
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


# GPS_x/GPS_z が緯度・経度 (度)、GPS_y は標高 (メートル) のケース
# (日本近辺: 緯度35, 経度139。標高は水平面より広がりが大きく水平面から外れる)
GPS_XZ_DEG_CSV = """GPS_x,GPS_y,GPS_z
139.00,100,35.00
139.01,140,35.01
139.02,90,35.02
139.03,180,35.03
139.04,210,35.04
"""

# GPS_x/GPS_z がローカル座標 (メートル) のケース
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
    ingest_csv(GPS_XZ_DEG_CSV, filename="jp.csv")
    res = gps.map_track(sig["id"], signals=["speed"])
    assert res["mode"] == "geographic"
    # GPS_x(139)=経度, GPS_z(35)=緯度 と値域から割り当てられる。
    # GPS_y は広がりが小さいので水平面から除外される
    assert res["lat_col"] == "GPS_z"
    assert res["lon_col"] == "GPS_x"
    assert res["lat"] == [35.0, 35.01, 35.02, 35.03, 35.04]
    assert res["lon"][0] == 139.0


def test_map_track_axes_meters_planar(ingest_csv) -> None:
    sig = ingest_csv(SIG_CSV, filename="loc.csv")
    ingest_csv(GPS_XZ_M_CSV, filename="loc.csv")
    res = gps.map_track(sig["id"], signals=["speed"])
    assert res["mode"] == "planar"
    assert res["px_col"] == "GPS_x"
    assert res["py_col"] == "GPS_z"
    assert res["px"] == [0, 1200, 2500, 3600, 4000]
    assert res["py"] == [0, 300, 600, 1500, 2600]


def test_map_track_manual_gps_and_columns(ingest_csv) -> None:
    # 自動ペアが効かない別名でも、GPS と列を手動指定すれば結合できる
    sig = ingest_csv(SIG_CSV, filename="alpha.csv")
    g = ingest_csv(GPS_CSV, filename="beta.csv")
    res = gps.map_track(sig["id"], signals=["speed"], gps_id=g["id"],
                        lat_col="latitude", lon_col="longitude")
    assert res["gps_dataset"]["id"] == g["id"]
    assert res["lon"] == [139.0, 139.01, 139.02, 139.03, 139.04]


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
