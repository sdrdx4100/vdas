from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_comparison_workspace_and_modules_are_served() -> None:
    with TestClient(app) as client:
        index = client.get("/")
        assert index.status_code == 200
        html = index.text
        for element_id in (
            "cmp-cohort-selector",
            "cmp-cohort-results",
            "cmp-cohort-hist-chart",
            "cmp-cohort-2d-chart",
            "cmp-transition-chart",
        ):
            assert f'id="{element_id}"' in html
        assert '<script type="module" src="/static/js/main.js"></script>' in html

        for module in (
            "api.js",
            "charts.js",
            "compare.js",
            "datasets.js",
            "main.js",
            "state.js",
            "views.js",
        ):
            response = client.get(f"/static/js/{module}")
            assert response.status_code == 200
            assert response.headers["content-type"].split(";", 1)[0] in {
                "application/javascript",
                "text/javascript",
            }
