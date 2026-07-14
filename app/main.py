"""VDAS — Vehicle Data Analysis Studio.

ローカルサーバーとして起動する車両データ可視化ダッシュボード。
  python run.py  →  http://127.0.0.1:8710
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .api import router
from .config import STATIC_DIR

app = FastAPI(title="VDAS", description="車両データ可視化ダッシュボード")


@app.on_event("startup")
def startup() -> None:
    db.init()


app.include_router(router)


@app.get("/vendor/plotly.min.js", include_in_schema=False)
def plotly_js() -> FileResponse:
    """pip でインストールした plotly パッケージ同梱の plotly.min.js を配信する。

    外部 CDN に依存しないため完全オフラインで動作する。
    """
    import plotly

    path = Path(plotly.__file__).parent / "package_data" / "plotly.min.js"
    return FileResponse(path, media_type="application/javascript")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
