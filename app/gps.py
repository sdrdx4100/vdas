"""GPS 走行データと信号データを重ねて地図可視化するためのモジュール。

GPS は信号ログとは別ファイル (同名の Parquet) として記録される。両者は
同じ時間の流れ・同じ行数で並んでいるため、行位置 (rowid) で 1:1 に対応づける。

- GPS データセット = 緯度・経度列 (または GPS_x/GPS_y/GPS_z のような座標列) を持つデータセット
- 信号データセット = GPS のペア相手 (同じ元ファイル名を持つ別データセット)

座標は「緯度・経度 (度)」の場合と「ローカル座標 (メートル等)」の場合がある。
実際の値の範囲から自動判定し、前者は実地図タイル上に、後者は等尺の平面軌跡
として描く (どちらの列を使うかは手動指定も可能)。

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

# GPS_x / GPS_y / GPS_z, pos_x, coord_z … のような座標軸列 (軸の文字を取り出す)
_COORD_AXIS_RE = re.compile(
    r"(?:^|[_\-\s])(?:gps|pos(?:ition)?|coord|xyz)[_\-\s]*([xyz])(?:[_\-\s]|$)", re.IGNORECASE
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


def detect_coord_axes(columns: list[dict[str, Any]]) -> dict[str, str]:
    """GPS_x / GPS_y / GPS_z のような座標軸列を {軸: 列名} で返す (数値列のみ)。"""
    numeric = _numeric_names(columns)
    axes: dict[str, str] = {}
    for c in columns:
        if c["name"] not in numeric:
            continue
        m = _COORD_AXIS_RE.search(c["name"])
        if m:
            axes.setdefault(m.group(1).lower(), c["name"])
    return axes


def coord_columns(columns: list[dict[str, Any]]) -> tuple[str, list[str]]:
    """データセットの座標列を返す。

    ("latlon", [lat, lon]) … 緯度経度らしい名前の列がある場合
    ("axes",   [列名...])  … GPS_x/y/z のような座標軸列が2つ以上ある場合
    ("none",   [])         … 座標列なし
    """
    lat, lon = detect_latlon(columns)
    if lat and lon:
        return "latlon", [lat, lon]
    axes = detect_coord_axes(columns)
    if len(axes) >= 2:
        # 軸の文字順 (x, y, z) で安定させる
        return "axes", [axes[a] for a in ("x", "y", "z") if a in axes]
    return "none", []


def _base_name(name: str) -> str:
    """ペア判定用に、GPS 接尾辞を落とした基準名 (小文字) を返す。"""
    stem = re.sub(r"\.(csv|parquet|pq)$", "", str(name), flags=re.IGNORECASE)
    return _GPS_SUFFIX_RE.sub("", stem).strip().lower()


def _dataset_coords(dataset_id: str) -> tuple[str, list[str]]:
    return coord_columns(dataset_schema(dataset_id)["columns"])


def is_gps_dataset(dataset_id: str) -> bool:
    kind, _ = _dataset_coords(dataset_id)
    return kind != "none"


def list_gps_datasets() -> list[dict[str, Any]]:
    """座標列 (緯度経度 または GPS_x/y/z) を持つデータセット (= GPS ログ) を一覧する。"""
    out = []
    for ds in list_datasets():
        kind, cols = _dataset_coords(ds["id"])
        if kind == "none":
            continue
        # 緯度経度らしい名前があればそれを既定に、無ければ列は値から判定する
        lat = cols[0] if kind == "latlon" else None
        lon = cols[1] if kind == "latlon" else None
        out.append({"dataset": ds, "coord_kind": kind, "coord_cols": cols,
                    "lat_col": lat, "lon_col": lon})
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
                "coord_kind": pair["coord_kind"],
                "coord_cols": pair["coord_cols"],
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


def _num(values: list[Any]) -> list[float]:
    return [float(v) for v in values if isinstance(v, (int, float))]


def _looks_like_degrees(a: list[float], b: list[float]) -> bool:
    """2列の値が緯度・経度 (度) らしいか判定する。

    - 緯度は [-90, 90]、経度は [-180, 180] に収まる
    - 1本の走行ログの広がりは高々数度 (地球規模ではない)
    - 原点近傍のローカル座標 (メートル) を誤検出しないよう、
      少なくとも一方の絶対値の中央が 1 度以上離れていることを要求する
    """
    if not a or not b:
        return False
    amax, bmax = max(map(abs, a)), max(map(abs, b))
    aspan, bspan = max(a) - min(a), max(b) - min(b)
    amean, bmean = sum(map(abs, a)) / len(a), sum(map(abs, b)) / len(b)
    fits = (amax <= 90 and bmax <= 180) or (bmax <= 90 and amax <= 180)
    modest_span = aspan <= 20 and bspan <= 20
    off_origin = max(amean, bmean) >= 1.0
    return fits and modest_span and off_origin


def _assign_latlon(name_a: str, a: list[float], name_b: str,
                   b: list[float]) -> tuple[str, str]:
    """度らしい2列のうち、どちらが緯度・経度かを値域から割り当てる。"""
    a90 = max(map(abs, a)) <= 90
    b90 = max(map(abs, b)) <= 90
    if a90 and not b90:
        return name_a, name_b  # a=緯度, b=経度
    if b90 and not a90:
        return name_b, name_a
    # 両方 90 以下 (赤道・本初子午線付近): 絶対値が小さい方を緯度とみなす
    amean = sum(map(abs, a)) / len(a)
    bmean = sum(map(abs, b)) / len(b)
    return (name_a, name_b) if amean <= bmean else (name_b, name_a)


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

    # --- 座標列の候補を決める ---
    # 明示指定 (lat/lon) → 名前ベースの緯度経度 → GPS_x/y/z 座標軸、の順。
    # 役割 (どちらが緯度/経度か・度かメートルか) は後段で値から判定する。
    axes_map: dict[str, str] = {}
    if lat_col and lon_col:
        for col in (lat_col, lon_col):
            if col not in gps_colmap:
                raise QueryError(f"GPS データに列がありません: {col}")
        coord_cols: list[str] = [lat_col, lon_col]
        roles_fixed = True
    else:
        kind, cols = coord_columns(gps_schema["columns"])
        if kind == "none":
            raise QueryError(
                "GPS データの座標列 (緯度・経度 または GPS_x/y/z) を特定できませんでした。"
                "列を手動で指定してください")
        coord_cols = cols
        roles_fixed = (kind == "latlon")
        if kind == "axes":
            axes_map = detect_coord_axes(gps_schema["columns"])  # {'x': 列, 'y': 列, 'z': 列}

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
        out_cols = [f"f.{_quote(c)}" for c in sel_cols] + [f"g.{_quote(c)}" for c in coord_cols]
        rows = con.execute(
            f"SELECT f.__r, {', '.join(out_cols)} FROM ("
            f"  SELECT rowid AS __r, {inner_sel}row_number() OVER (ORDER BY rowid) AS __rn"
            f"  FROM {_quote(sig_table)}{where}"
            f") f JOIN {_quote(gps_table)} g ON f.__r = g.rowid "
            f"WHERE (f.__rn - 1) % {stride} = 0 ORDER BY f.__r", params).fetchall()

    # 列の並び: __r, [sel_cols...], [coord_cols...]
    index = [r[0] for r in rows]
    col_at = {c: [_jsonable(r[i + 1]) for r in rows] for i, c in enumerate(sel_cols)}
    coord_at = {c: [_jsonable(r[len(sel_cols) + 1 + i]) for r in rows]
                for i, c in enumerate(coord_cols)}

    # --- 使う2軸を決める ---
    # GPS_x/y/z 軸の慣習: x=経度(東), y=緯度(北), z=高度。x と y が揃っていれば
    # それを水平面 (経度=x, 緯度=y) とし、高度 z は使わない。それ以外は値から判定。
    lon_hint = lat_hint = None
    if axes_map and "x" in axes_map and "y" in axes_map:
        a_name, b_name = axes_map["x"], axes_map["y"]
        lon_hint, lat_hint = axes_map["x"], axes_map["y"]
    elif roles_fixed:
        # 明示指定 (a=緯度, b=経度) / 緯度経度名
        a_name, b_name = coord_cols[0], coord_cols[1]
        lat_hint, lon_hint = coord_cols[0], coord_cols[1]
    else:
        # 度らしい2列の組を探し、無ければ広がりの大きい上位2軸を水平面にする
        geo_pair = None
        for i in range(len(coord_cols)):
            for j in range(i + 1, len(coord_cols)):
                ca, cb = coord_cols[i], coord_cols[j]
                if _looks_like_degrees(_num(coord_at[ca]), _num(coord_at[cb])):
                    geo_pair = (ca, cb)
                    break
            if geo_pair:
                break
        if geo_pair:
            a_name, b_name = geo_pair
        else:
            spread = {c: (max(_num(v)) - min(_num(v))) if _num(v) else 0.0
                      for c, v in coord_at.items()}
            horiz = sorted(coord_cols, key=lambda c: -spread[c])[:2]
            horiz.sort(key=lambda c: coord_cols.index(c))  # 元の軸順 (x,y,z) を保つ
            a_name, b_name = horiz[0], horiz[1]

    a_vals, b_vals = coord_at[a_name], coord_at[b_name]
    a_num, b_num = _num(a_vals), _num(b_vals)
    geographic = _looks_like_degrees(a_num, b_num)

    result: dict[str, Any] = {
        "signal_dataset": signal_ds,
        "gps_dataset": gps_ds,
        "x": x,
        "total_rows": total, "returned_rows": len(rows), "stride": stride,
        "index": index,
        "x_values": col_at.get(x) if x else None,
        "signals": {s: col_at[s] for s in signals},
        "color_signal": color_signal,
        "color_values": col_at.get(color_signal) if color_signal else None,
    }

    if geographic:
        # 緯度経度 → 実地図タイル上に描く。
        # 軸名の慣習 (x=経度, y=緯度 など) が分かっていればそれを優先し、
        # 値域と明らかに矛盾するとき (緯度側が±90を超える) だけ入れ替える。
        if lat_hint and lon_hint:
            lat_over90 = max(map(abs, _num(coord_at[lat_hint]))) > 90
            lon_ok90 = max(map(abs, _num(coord_at[lon_hint]))) <= 90
            if lat_over90 and lon_ok90:
                lat_name, lon_name = lon_hint, lat_hint  # 逆に付いていたので入れ替え
            else:
                lat_name, lon_name = lat_hint, lon_hint
        else:
            lat_name, lon_name = _assign_latlon(a_name, a_num, b_name, b_num)
        lat_vals, lon_vals = coord_at[lat_name], coord_at[lon_name]
        lat_clean, lon_clean = _num(lat_vals), _num(lon_vals)
        center = {"lat": sum(lat_clean) / len(lat_clean), "lon": sum(lon_clean) / len(lon_clean)}
        span = max(max(lat_clean) - min(lat_clean), max(lon_clean) - min(lon_clean))
        result.update({
            "mode": "geographic",
            "lat_col": lat_name, "lon_col": lon_name,
            "lat": lat_vals, "lon": lon_vals,
            "center": center, "zoom": _zoom_for_span(span),
        })
    else:
        # ローカル座標 (メートル等) → 等尺の平面軌跡として描く
        result.update({
            "mode": "planar",
            "px_col": a_name, "py_col": b_name,
            "px": a_vals, "py": b_vals,
        })
    return result
