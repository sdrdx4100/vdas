"""VDAS — Vehicle Data Analysis Studio.

ローカルまたはLAN内サーバーとして起動する車両データ可視化ダッシュボード。
  python run.py        →  http://127.0.0.1:8710
  python run.py --lan  →  http://<このPCのIP>:8710
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from . import db
from .api import router
from .config import STATIC_DIR

app = FastAPI(title="VDAS", description="車両データ可視化ダッシュボード")
# Plotly 本体と GPS 軌跡の JSON は大きいため、LAN 越しでも転送が詰まらないよう圧縮する。
# 圧縮レベルは配信時の CPU 負荷とのバランスを取り、中程度に留める。
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)


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
    return FileResponse(
        path,
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=604800, stale-while-revalidate=86400"},
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
