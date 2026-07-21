from __future__ import annotations

import run


def test_parser_supports_local_and_lan_modes() -> None:
    parser = run.build_parser()

    assert parser.parse_args([]).host == "127.0.0.1"
    assert parser.parse_args(["--lan"]).lan is True


def test_local_ipv4_addresses_excludes_loopback(monkeypatch) -> None:
    monkeypatch.setattr(run.socket, "gethostname", lambda: "vdas-host")
    monkeypatch.setattr(
        run.socket,
        "getaddrinfo",
        lambda *_args: [
            (run.socket.AF_INET, 0, 0, "", ("127.0.0.1", 0)),
            (run.socket.AF_INET, 0, 0, "", ("192.168.1.25", 0)),
        ],
    )

    assert run.local_ipv4_addresses() == ["192.168.1.25"]
