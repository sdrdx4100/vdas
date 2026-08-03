from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_analysis_workspace_and_modules_are_served() -> None:
    with TestClient(app) as client:
        index = client.get("/")
        assert index.status_code == 200
        html = index.text
        for element_id in (
            "ts-selection-summary",
            "ts-select-visible",
            "ts-clear-selection",
            # 自由分析 (タググループ統計分析)
            "an-tags",
            "an-kind",
            "an-kind-hint",
            "an-signal",
            "an-metric",
            "an-norm",
            "an-filters",
            "an-chart",
            "an-table",
            "an-stats",
            # グラフ作成 (チャートビルダー)
            "ex-kind",
            "ex-chart",
            "ex-group-tags",
            "ex-src-groups",
            # GPS・地図の走行再生
            "mp-play-toggle",
            "mp-play-reset",
            "mp-play-seek",
            "mp-play-position",
            "mp-play-speed",
            "mp-playback-secondary",
            "mp-play-seek-b",
            "mp-play-position-b",
            "mp-seek-hint",
            "mp-dataset-b",
            "mp-gps-b",
            "mp-cmp-hint",
            "mp-sync-mode",
            "mp-sync-hint",
            "mp-alignment",
            "mp-align-offset",
            "mp-align-value",
            "mp-align-reset",
            # 信号名エイリアス (会社ごとに列名が違う信号の対応付け)
            "mp-alias-manage",
            "tc-alias-manage",
            "alias-backdrop",
            "aliasmodal-list",
            "aliasmodal-group",
            "aliasmodal-column",
        ):
            assert f'id="{element_id}"' in html
        for context in ("timeseries", "stats", "cluster"):
            assert f'data-analysis-context="{context}"' in html
        assert '<script type="module" src="/static/js/main.js"></script>' in html
        assert '<script src="/vendor/plotly.min.js"></script>' not in html
        # 旧ワークスペースのUIは撤去済み
        assert 'data-cmp-mode="datasets"' not in html
        assert "cmp-cohort-builders" not in html
        assert "cmp-multi-signals" not in html
        # 分析ギャラリーは1種類ずつ選ぶ方式
        for kind in ("summary", "distribution", "share", "region", "transitions"):
            assert f'data-kind="{kind}"' in html

        for module in (
            "api.js",
            "aliases.js",
            "analysis.js",
            "charts.js",
            "datasets.js",
            "explore.js",
            "leaflet-loader.js",
            "main.js",
            "map.js",
            "plotly-loader.js",
            "state.js",
            "tscompare.js",
            "workspace.js",
            "views.js",
        ):
            response = client.get(f"/static/js/{module}")
            assert response.status_code == 200
            assert response.headers["content-type"].split(";", 1)[0] in {
                "application/javascript",
                "text/javascript",
            }

        main_js = client.get("/static/js/main.js").text
        nav_js = client.get("/static/js/nav.js").text
        loader_js = client.get("/static/js/plotly-loader.js").text
        assert 'import "./map.js"' not in main_js
        assert 'await import("./map.js")' in nav_js
        assert '"compare", "map", "tscompare"' not in nav_js
        assert "for (let attempt = 0; attempt < 2" in loader_js

        # 地図はローカル同梱 Leaflet、波形だけ Plotly を使う
        map_js = client.get("/static/js/map.js").text
        leaflet_loader_js = client.get("/static/js/leaflet-loader.js").text
        assert "wireLinkedCursor(view)" in map_js
        assert 'await renderChart("mp-map"' in map_js
        assert "createTrackCanvasLayer" in map_js
        assert "L.CRS.Simple" in map_js
        assert "scattermap" not in map_js
        assert "Plotly.restyle" not in map_js
        assert "ensureLeaflet" in map_js
        assert "波形ライブラリの読み込みに失敗しました。地図と走行再生は利用できます" in map_js
        assert '"/static/vendor/leaflet/leaflet.js"' in leaflet_loader_js
        assert "for (let attempt = 0; attempt < 2" in leaflet_loader_js
        assert '"vdas-mapstyle-choice"' in map_js
        assert 'localStorage.getItem("vdas-mapstyle")' not in map_js
        # 波形は最大2信号を保持して両方描画し、地図ズームは初期表示の前後2段に制限する
        assert "const MAX_WAVE_SIGNALS = 2" in map_js
        assert "cols.slice(0, MAX_WAVE_SIGNALS)" in map_js
        assert "fittedZoom - 2" in map_js
        assert "fittedZoom + 2" in map_js
        assert "下部グラフ・最大2つ" in html

        for asset in (
            "/static/vendor/leaflet/leaflet.js",
            "/static/vendor/leaflet/leaflet.css",
            "/static/vendor/leaflet/LICENSE",
        ):
            assert client.get(asset).status_code == 200

        # 走行Bの取得失敗や座標形式の不一致で画面全体が消えないこと
        # (Aだけでも表示を続け、波形比較は座標形式に関係なく維持する)
        assert "走行 B の取得に失敗しました" in map_js
        assert "mapCompatible" in map_js
        assert "座標形式が異なるため重ねて表示できません" not in map_js

        # GPSログ自体に信号列も含まれる自己完結型ログを「信号データ」候補に含める
        assert "function signalCandidates" in map_js
        assert "別ファイルとのペアは不要です" in map_js

        # 会社によって列名が違う信号 (例: speed / 車速) をエイリアスで対応づけて比較できること
        assert "resolveColumn" in map_js
        assert "loadAliases" in map_js
        tscompare_js = client.get("/static/js/tscompare.js").text
        assert "resolveColumn" in tscompare_js
        assert "loadAliases" in tscompare_js

        assert client.get("/static/js/compare.js").status_code == 404


def test_plotly_bundle_is_compressed_cached_and_compatible() -> None:
    with TestClient(app) as client:
        response = client.get(
            "/vendor/plotly.min.js",
            headers={"Accept-Encoding": "gzip"},
        )
        assert response.status_code == 200
        assert response.headers["content-encoding"] == "gzip"
        assert "max-age=" in response.headers["cache-control"]
        assert b"scattermap" in response.content


def test_leaflet_bundle_is_local_and_compressed() -> None:
    with TestClient(app) as client:
        response = client.get(
            "/static/vendor/leaflet/leaflet.js",
            headers={"Accept-Encoding": "gzip"},
        )
        assert response.status_code == 200
        assert response.headers["content-encoding"] == "gzip"
        assert b"Leaflet 1.9.4" in response.content
