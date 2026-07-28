"""GPS 走行データと信号データを重ねて地図可視化するためのモジュール。

GPS は信号ログとは別ファイル (同名の Parquet) として記録される。両者は
同じ時間の流れ・同じ行数で並んでいるため、行位置 (rowid) で 1:1 に対応づける。

- GPS データセット = 緯度・経度列を持つデータセット (列名から自動判定)
- 信号データセット = GPS のペア相手 (同じ元ファイル名を持つ別データセット)

地図 (上部) には GPS 軌跡を、波形 (下部) には信号を描く。行位置で連動する
ため、波形上のカーソル位置を地図上の点に対応づけられる。
"""
from __future__ import annotations

import math
import re
from typing import Any

from . import db
from .ingest import dataset_schema, get_dataset, list_datasets
from .queries import (
    QueryError,
    _build_where,
    _clamp_points,
    _jsonable,
    _quote,
    _schema_map,
)

# 緯度・経度らしい列名 (英日・略称・GPS 接頭辞などを広めに拾う)
_LAT_RE = re.compile(r"(^|[_\-\s])(lat(itude)?|緯度)([_\-\s]|$)|gps.*lat|lat.*deg", re.IGNORECASE)
_LON_RE = re.compile(
    r"(^|[_\-\s])(lon(g(itude)?)?|lng|経度)([_\-\s]|$)|gps.*(lon|lng)|lon.*deg", re.IGNORECASE
)

# ペア判定でファイル名から取り除く GPS 由来の接尾辞
_GPS_SUFFIX_RE = re.compile(r"[_\-\s]*(gps|pos(ition)?|loc(ation)?|latlon|track|位置)$", re.IGNORECASE)


def _numeric_names(columns: list[dict[str, Any]]) -> set[str]:
    return {c["name"] for c in columns if c["kind"] == "numeric"}


def detect_latlon(columns: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    """列一覧から緯度・経度列を推定する。見つからなければ (None, None)。"""
    numeric = _numeric_names(columns)
    names = [c["name"] for c in columns]
    lat = next((n for n in names if n in numeric and _LAT_RE.search(n)), None)
    lon = next((n for n in names if n in numeric and _LON_RE.search(n)), None)
    return lat, lon


def _base_name(name: str) -> str:
    """ペア判定用に、GPS 接尾辞を落とした基準名 (小文字) を返す。"""
    stem = re.sub(r"\.(csv|parquet|pq)$", "", str(name), flags=re.IGNORECASE)
    return _GPS_SUFFIX_RE.sub("", stem).strip().lower()


def _dataset_latlon(dataset_id: str) -> tuple[str | None, str | None, list[dict[str, Any]]]:
    schema = dataset_schema(dataset_id)
    columns = schema["columns"]
    lat, lon = detect_latlon(columns)
    return lat, lon, columns


def is_gps_dataset(dataset_id: str) -> bool:
    lat, lon, _ = _dataset_latlon(dataset_id)
    return bool(lat and lon)


def list_gps_datasets() -> list[dict[str, Any]]:
    """緯度・経度列を持つデータセット (= GPS ログ) を一覧する。"""
    out = []
    for ds in list_datasets():
        lat, lon, _ = _dataset_latlon(ds["id"])
        if lat and lon:
            out.append({"dataset": ds, "lat_col": lat, "lon_col": lon})
    return out


def find_gps_pair(dataset_id: str) -> dict[str, Any] | None:
    """信号データセットに対応する GPS データセットを、元ファイル名で探す。

    同じ基準名 (GPS 接尾辞を除いた元ファイル名) を持つ GPS データセットを返す。
    候補が複数あれば登録が新しいものを優先する。
    """
    target = get_dataset(dataset_id)
    base = _base_name(target["original_filename"] or target["name"])
    best = None
    for entry in list_gps_datasets():
        ds = entry["dataset"]
        if ds["id"] == dataset_id:
            continue
        if _base_name(ds["original_filename"] or ds["name"]) == base:
            if best is None:  # list_datasets は新しい順なので先頭を採用
                best = entry
    return best


def gps_pairs() -> list[dict[str, Any]]:
    """信号データセット × GPS データセットの自動ペア一覧を返す。"""
    gps_list = list_gps_datasets()
    gps_ids = {e["dataset"]["id"] for e in gps_list}
    pairs = []
    for ds in list_datasets():
        if ds["id"] in gps_ids:
            continue  # GPS そのものは信号側候補にしない
        pair = find_gps_pair(ds["id"])
        if pair:
            pairs.append({
                "signal": ds,
                "gps": pair["dataset"],
                "lat_col": pair["lat_col"],
                "lon_col": pair["lon_col"],
            })
    return pairs


def _zoom_for_span(span: float) -> float:
    """緯度経度の広がり (度) から地図のズームレベルを概算する。"""
    if span <= 0:
        return 14.0
    # 経験的: 1 タイル ≒ 360/2^zoom 度。少し余白を持たせる
    zoom = math.log2(360.0 / max(span, 1e-6)) - 0.3
    return float(max(2.0, min(18.0, zoom)))


def map_track(dataset_id: str, signals: list[str] | None = None,
              color_signal: str | None = None, x: str | None = None,
              gps_id: str | None = None, lat_col: str | None = None,
              lon_col: str | None = None,
              filters: list[dict[str, Any]] | None = None,
              max_points: int | None = None) -> dict[str, Any]:
    """信号データセットと GPS データセットを行位置で結合し、地図＋波形用の
    データを返す。地図と波形は同じサンプル点 (index) で連動する。"""
    signal_ds = get_dataset(dataset_id)
    sig_table, sig_cols = _schema_map(dataset_id)

    # --- GPS データセットの確定 (明示指定 → 自動ペア) ---
    if gps_id:
        gps_ds = get_dataset(gps_id)
    else:
        pair = find_gps_pair(dataset_id)
        if not pair:
            raise QueryError(
                "この信号データに対応する GPS データが見つかりません。"
                "GPS ファイル (緯度・経度列を持つ同名データ) を取り込むか、GPS データを手動で選択してください")
        gps_ds = pair["dataset"]
        gps_id = gps_ds["id"]
    gps_table, gps_colmap = _schema_map(gps_id)
    gps_schema = dataset_schema(gps_id)

    # --- 緯度・経度列の確定 ---
    if not (lat_col and lon_col):
        auto_lat, auto_lon = detect_latlon(gps_schema["columns"])
        lat_col = lat_col or auto_lat
        lon_col = lon_col or auto_lon
    if not (lat_col and lon_col):
        raise QueryError("GPS データの緯度・経度列を特定できませんでした。列を手動で指定してください")
    for col in (lat_col, lon_col):
        if col not in gps_colmap:
            raise QueryError(f"GPS データに列がありません: {col}")

    # --- 波形の信号列・X 軸列の確定 (すべて信号データセット側) ---
    signals = [s for s in (signals or []) if s]
    for s in signals:
        if s not in sig_cols:
            raise QueryError(f"信号データに列がありません: {s}")
        if sig_cols[s]["kind"] != "numeric":
            raise QueryError(f"波形には数値列を指定してください: {s}")
    if color_signal:
        if color_signal not in sig_cols:
            raise QueryError(f"信号データに列がありません: {color_signal}")
        if sig_cols[color_signal]["kind"] != "numeric":
            raise QueryError(f"色分けには数値列を指定してください: {color_signal}")
    if not x:
        x = next((c["name"] for c in dataset_schema(dataset_id)["columns"]
                  if c["kind"] == "temporal"), None) \
            or next((n for n in sig_cols if re.search(r"time|date|時刻|時間", n, re.IGNORECASE)), None)
    if x and x not in sig_cols:
        raise QueryError(f"信号データに列がありません: {x}")

    where, params = _build_where(filters, sig_cols)
    limit = _clamp_points(max_points)

    # 信号側で必要な列だけを rowid 付きで抽出 → GPS と rowid で結合 → 間引き
    sel_cols = list(dict.fromkeys([c for c in ([x] if x else []) + signals +
                                   ([color_signal] if color_signal else [])]))
    inner_sel = ", ".join(_quote(c) for c in sel_cols)
    inner_sel = (inner_sel + ", ") if inner_sel else ""

    with db.duck() as con:
        total = con.execute(
            f"SELECT count(*) FROM (SELECT rowid AS __r FROM {_quote(sig_table)}{where}) f "
            f"JOIN {_quote(gps_table)} g ON f.__r = g.rowid", params).fetchone()[0]
        if not total:
            raise QueryError("結合できる行がありません (GPS と信号の行位置が一致していない可能性があります)")
        stride = max(1, math.ceil(total / limit))
        out_cols = [f"f.{_quote(c)}" for c in sel_cols] + [f"g.{_quote(lat_col)}", f"g.{_quote(lon_col)}"]
        rows = con.execute(
            f"SELECT f.__r, {', '.join(out_cols)} FROM ("
            f"  SELECT rowid AS __r, {inner_sel}row_number() OVER (ORDER BY rowid) AS __rn"
            f"  FROM {_quote(sig_table)}{where}"
            f") f JOIN {_quote(gps_table)} g ON f.__r = g.rowid "
            f"WHERE (f.__rn - 1) % {stride} = 0 ORDER BY f.__r", params).fetchall()

    # 列の並び: __r, [sel_cols...], lat, lon
    index = [r[0] for r in rows]
    col_at = {c: [ _jsonable(r[i + 1]) for r in rows] for i, c in enumerate(sel_cols)}
    lat_vals = [_jsonable(r[len(sel_cols) + 1]) for r in rows]
    lon_vals = [_jsonable(r[len(sel_cols) + 2]) for r in rows]

    lat_clean = [v for v in lat_vals if isinstance(v, (int, float))]
    lon_clean = [v for v in lon_vals if isinstance(v, (int, float))]
    if lat_clean and lon_clean:
        center = {"lat": sum(lat_clean) / len(lat_clean), "lon": sum(lon_clean) / len(lon_clean)}
        span = max(max(lat_clean) - min(lat_clean), max(lon_clean) - min(lon_clean))
        zoom = _zoom_for_span(span)
    else:
        center, zoom = {"lat": 0.0, "lon": 0.0}, 2.0

    return {
        "signal_dataset": signal_ds,
        "gps_dataset": gps_ds,
        "lat_col": lat_col, "lon_col": lon_col, "x": x,
        "total_rows": total, "returned_rows": len(rows), "stride": stride,
        "index": index,
        "lat": lat_vals, "lon": lon_vals,
        "x_values": col_at.get(x) if x else None,
        "signals": {s: col_at[s] for s in signals},
        "color_signal": color_signal,
        "color_values": col_at.get(color_signal) if color_signal else None,
        "center": center, "zoom": zoom,
    }
