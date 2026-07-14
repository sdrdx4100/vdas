"""アプリ全体で共有するパス設定。"""
import os
from pathlib import Path

# データ置き場 (環境変数 VDAS_DATA_DIR で変更可能)
DATA_DIR = Path(os.environ.get("VDAS_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
UPLOAD_DIR = DATA_DIR / "uploads"
DUCKDB_PATH = DATA_DIR / "vdas.duckdb"
META_DB_PATH = DATA_DIR / "meta.sqlite"

STATIC_DIR = Path(__file__).resolve().parent / "static"


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
