from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.main import app


CSV = b"time,speed,mode\n0,0,idle\n1,10,drive\n2,20,drive\n"


def test_upload_query_and_delete_through_api() -> None:
    with TestClient(app) as client:
        upload = client.post(
            "/api/datasets/upload",
            files={"file": ("drive.csv", CSV, "text/csv")},
            data={"name": "API走行", "tags": json.dumps(["API", "評価"])},
        )
        assert upload.status_code == 200
        dataset = upload.json()

        listing = client.get("/api/datasets")
        assert listing.status_code == 200
        assert listing.json()[0]["tags"] == ["API", "評価"]

        timeseries = client.post(
            f"/api/datasets/{dataset['id']}/timeseries",
            json={"x": "time", "ys": ["speed"], "filters": [], "max_points": 100},
        )
        assert timeseries.status_code == 200
        assert timeseries.json()["data"] == {"time": [0, 1, 2], "speed": [0, 10, 20]}

        deleted = client.delete(f"/api/datasets/{dataset['id']}")
        assert deleted.status_code == 200
        assert client.get("/api/datasets").json() == []


def test_api_turns_query_errors_into_bad_request(ingest_csv) -> None:
    dataset = ingest_csv(CSV.decode("utf-8"))

    with TestClient(app) as client:
        response = client.post(
            f"/api/datasets/{dataset['id']}/histogram",
            json={"column": "missing", "bins": 40, "filters": []},
        )

    assert response.status_code == 400
    assert "列が存在しません" in response.json()["detail"]


def test_saved_view_and_labelset_round_trip(ingest_csv) -> None:
    dataset = ingest_csv(CSV.decode("utf-8"))

    with TestClient(app) as client:
        view = client.post(
            "/api/views",
            json={
                "name": "速度ビュー",
                "kind": "timeseries",
                "dataset_id": dataset["id"],
                "config": {"x": "time", "ys": ["speed"]},
            },
        )
        labelset = client.post(
            "/api/labelsets",
            json={"name": "基本信号", "dataset_id": dataset["id"], "columns": ["speed"]},
        )

        assert view.status_code == 200
        assert labelset.status_code == 200
        assert client.get("/api/views").json()[0]["config"] == {"x": "time", "ys": ["speed"]}
        assert client.get("/api/labelsets").json()[0]["columns"] == ["speed"]


def test_bulk_tag_and_delete_endpoints(ingest_csv) -> None:
    first = ingest_csv(CSV.decode("utf-8"), filename="first.csv")
    second = ingest_csv(CSV.decode("utf-8"), filename="second.csv")
    ids = [first["id"], second["id"]]

    with TestClient(app) as client:
        tagged = client.post("/api/datasets/tags/bulk", json={"dataset_ids": ids, "add": ["共通"]})
        assert tagged.status_code == 200
        assert client.get("/api/tags").json() == ["共通"]

        deleted = client.post("/api/datasets/bulk-delete", json={"dataset_ids": ids})
        assert deleted.status_code == 200
        assert deleted.json() == {"deleted": 2}
        assert client.get("/api/datasets").json() == []
