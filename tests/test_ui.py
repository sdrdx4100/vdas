from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_comparison_workspace_and_modules_are_served() -> None:
    with TestClient(app) as client:
        index = client.get("/")
        assert index.status_code == 200
        html = index.text
        for element_id in (
            "ts-selection-summary",
            "ts-select-visible",
            "ts-clear-selection",
            "cmp-cohort-selector",
            "cmp-cohort-results",
            "cmp-cohort-hist-chart",
            "cmp-cohort-2d-chart",
            "cmp-cohort-stat-summary",
            "cmp-cohort-stat-chart",
            "cmp-transition-chart",
        ):
            assert f'id="{element_id}"' in html
        for context in ("timeseries", "stats", "cluster"):
            assert f'data-analysis-context="{context}"' in html
        assert '<script type="module" src="/static/js/main.js"></script>' in html

        for module in (
            "api.js",
            "charts.js",
            "compare.js",
            "datasets.js",
            "main.js",
            "state.js",
            "workspace.js",
            "views.js",
        ):
            response = client.get(f"/static/js/{module}")
            assert response.status_code == 200
            assert response.headers["content-type"].split(";", 1)[0] in {
                "application/javascript",
                "text/javascript",
            }
