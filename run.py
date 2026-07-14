"""ローカルサーバー起動スクリプト:  python run.py [--port 8710]"""
import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="VDAS 車両データ可視化ダッシュボード")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8710)
    parser.add_argument("--reload", action="store_true", help="開発用オートリロード")
    args = parser.parse_args()
    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
