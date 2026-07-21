"""VDASサーバー起動スクリプト。ローカル限定またはLAN公開で起動できる。"""
import argparse
import socket

import uvicorn


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="VDAS 車両データ可視化ダッシュボード")
    network = parser.add_mutually_exclusive_group()
    network.add_argument("--host", default="127.0.0.1", help="待受アドレス (既定: 127.0.0.1)")
    network.add_argument(
        "--lan", action="store_true", help="同一ネットワークへ公開 (0.0.0.0で待受)"
    )
    parser.add_argument("--port", type=int, default=8710)
    parser.add_argument("--reload", action="store_true", help="開発用オートリロード")
    return parser


def local_ipv4_addresses() -> list[str]:
    """LANから到達し得る、このPCのIPv4アドレス候補を返す。"""
    try:
        addresses = {
            info[4][0]
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
            if not info[4][0].startswith("127.")
        }
    except socket.gaierror:
        return []
    return sorted(addresses)


def main() -> None:
    args = build_parser().parse_args()
    host = "0.0.0.0" if args.lan else args.host
    if args.lan:
        print("LAN公開モード: このネットワーク上の端末から次のURLを開けます")
        addresses = local_ipv4_addresses()
        if addresses:
            for address in addresses:
                print(f"  http://{address}:{args.port}")
        else:
            print(f"  http://<このPCのIPアドレス>:{args.port}")
        print("注意: 認証機能はありません。信頼できるネットワーク内だけで使用してください。")
    uvicorn.run("app.main:app", host=host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
