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

import bisect
import math
import re
from datetime import datetime
from typing import Any

import pandas as pd

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

# 経過時間・時刻らしい列名
_TIME_NAME_RE = re.compile(r"time|date|時刻|時間", re.IGNORECASE)

# 時刻整列のズレの中央値がこれを超えたら信頼できないとみなし rowid 結合にフォールバックする (秒)
TIME_ALIGN_MAX_MEDIAN_DT_SEC = 30.0


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


# ファイル名に埋め込まれた「記録開始日時」を突き合わせキーにするための抽出。
# 例: 260518_191805 (YYMMDD_HHMMSS), busloigging_2026-05-18_19-18-05 (YYYY-MM-DD_HH-MM-SS)
# はどちらも 2026-05-18 19:18:05 を表す。書式が違ってもこの日時で自動ペアできる。
_TS_RE_YYYY = re.compile(
    r"(19|20)(\d{2})[-_./]?(\d{2})[-_./]?(\d{2})[ _tT./-]*(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})")
_TS_RE_YY = re.compile(r"(?<!\d)(\d{2})(\d{2})(\d{2})[-_ ]?(\d{2})(\d{2})(\d{2})(?!\d)")

# 記録開始が数秒ずれても同じ走行とみなす許容差 (秒)
TS_TOLERANCE_SEC = 2.0


# タグでの突き合わせ: 信号側「トヨタ」 ↔ GPS側「トヨタ_GPS」のような対応。
_TAG_GPS_SUFFIX_RE = re.compile(r"[_\-\s]*(gps|位置|pos(ition)?|loc(ation)?)$", re.IGNORECASE)


def _norm_tags(tags: list[str] | None) -> set[str]:
    return {str(t).strip().lower() for t in (tags or []) if str(t).strip()}


def _tag_link(sig_tags: list[str] | None, gps_tags: list[str] | None) -> bool:
    """GPS 側タグから GPS 接尾辞を外した基準が、信号側タグに含まれるか。

    例: 信号 {"トヨタ"} と GPS {"トヨタ_GPS"} → True。
    """
    sig = _norm_tags(sig_tags)
    if not sig:
        return False
    for g in _norm_tags(gps_tags):
        base = _TAG_GPS_SUFFIX_RE.sub("", g).strip()
        if base and base in sig:
            return True
    return False


def _valid_dt(y: int, mo: int, d: int, h: int, mi: int, s: int) -> datetime | None:
    try:
        return datetime(y, mo, d, h, mi, s)
    except ValueError:
        return None


def extract_timestamp(name: str) -> datetime | None:
    """ファイル名に含まれる日時 (記録開始時刻) を推定する。見つからなければ None。"""
    stem = re.sub(r"\.(csv|parquet|pq)$", "", str(name), flags=re.IGNORECASE)
    for m in _TS_RE_YYYY.finditer(stem):
        dtv = _valid_dt(int(m.group(1) + m.group(2)), int(m.group(3)), int(m.group(4)),
                        int(m.group(5)), int(m.group(6)), int(m.group(7)))
        if dtv:
            return dtv
    for m in _TS_RE_YY.finditer(stem):
        dtv = _valid_dt(2000 + int(m.group(1)), int(m.group(2)), int(m.group(3)),
                        int(m.group(4)), int(m.group(5)), int(m.group(6)))
        if dtv:
            return dtv
    return None


def _dataset_coords(dataset_id: str) -> tuple[str, list[str]]:
    return coord_columns(dataset_schema(dataset_id)["columns"])


def is_gps_dataset(dataset_id: str) -> bool:
    kind, _ = _dataset_coords(dataset_id)
    return kind != "none"


def _has_extra_signals(dataset_id: str) -> bool:
    """座標列以外にも波形として使える数値列を持つか。

    GPS ログ側に速度・回転数などの信号列がすべて含まれているケース
    (別ファイルとのペア突き合わせが不要な自己完結型ログ) を判定する。
    """
    kind, coord_cols = _dataset_coords(dataset_id)
    if kind == "none":
        return False
    numeric = {c["name"] for c in dataset_schema(dataset_id)["columns"] if c["kind"] == "numeric"}
    return bool(numeric - set(coord_cols))


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


def find_gps_pair(dataset_id: str,
                  gps_list: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    """信号データセットに対応する GPS データセットを探す。

    ①ファイル名の基準名一致 (A社のように同名で保存されている場合) を優先し、
    無ければ②ファイル名に埋め込まれた記録開始日時の一致で突き合わせる
    (B社のように GPS と信号で命名規則が違っても、同じ時刻なら自動ペア)。

    `gps_list` は呼び出し側 (gps_pairs など) が既に持っている GPS 一覧を
    使い回すための引数。省略時は自前で1回だけ計算する (毎回列スキーマを
    読み直すと、全データセットをループする呼び出し元では件数の2乗の
    コストになってしまうため)。
    """
    target = get_dataset(dataset_id)
    tname = target["original_filename"] or target["name"]
    base = _base_name(tname)
    tgt_ts = extract_timestamp(tname)
    sig_tags = target.get("tags") or []
    if gps_list is None:
        gps_list = list_gps_datasets()

    # 各キーの候補を集める。タグ整合 (信号 X ↔ GPS X_GPS) は同点時の優先に使う。
    name_hits: list[tuple[int, dict[str, Any]]] = []
    ts_hits: list[tuple[int, float, dict[str, Any]]] = []
    tag_hits: list[dict[str, Any]] = []
    for entry in gps_list:
        ds = entry["dataset"]
        if ds["id"] == dataset_id:
            continue
        cname = ds["original_filename"] or ds["name"]
        linked = _tag_link(sig_tags, ds.get("tags") or [])
        tag_rank = 0 if linked else 1  # タグが一致する候補を優先
        if _base_name(cname) == base:
            name_hits.append((tag_rank, {**entry, "match": "name"}))
        elif tgt_ts is not None:
            cts = extract_timestamp(cname)
            if cts is not None and abs((cts - tgt_ts).total_seconds()) <= TS_TOLERANCE_SEC:
                ts_hits.append((tag_rank, abs((cts - tgt_ts).total_seconds()),
                                {**entry, "match": "timestamp"}))
        if linked:
            tag_hits.append({**entry, "match": "tag"})

    # ①名前一致 → ②日時一致 → ③タグだけで一意に決まる場合
    if name_hits:
        name_hits.sort(key=lambda x: x[0])
        return name_hits[0][1]
    if ts_hits:
        ts_hits.sort(key=lambda x: (x[0], x[1]))  # タグ整合 → 時刻差の小さい順
        return ts_hits[0][2]
    if len(tag_hits) == 1:  # X ↔ X_GPS が1件ずつのときだけタグで確定
        return tag_hits[0]
    # ④ 他に候補が無くても、この信号データ自体に座標列と信号列が両方
    # 揃っている (GPS ログ側が波形データを兼ねている) なら、自分自身を
    # GPS 源として使う。別ファイルとの行対応づけが一切不要になるため、
    # 行数・記録開始時刻のズレの心配もない。
    if _has_extra_signals(dataset_id):
        kind, cols = _dataset_coords(dataset_id)
        lat = cols[0] if kind == "latlon" else None
        lon = cols[1] if kind == "latlon" else None
        return {"dataset": target, "coord_kind": kind, "coord_cols": cols,
                "lat_col": lat, "lon_col": lon, "match": "self"}
    return None


def gps_pairs(gps_list: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """信号データセット × GPS データセットの自動ペア一覧を返す。"""
    if gps_list is None:
        gps_list = list_gps_datasets()
    gps_ids = {e["dataset"]["id"] for e in gps_list}
    pairs = []
    for ds in list_datasets():
        # 座標列しかない「GPS専用」ログは信号側候補にしない。ただし信号列も
        # 兼ねている (自己完結型) ログは、自分自身とのペアとして候補に残す。
        if ds["id"] in gps_ids and not _has_extra_signals(ds["id"]):
            continue
        pair = find_gps_pair(ds["id"], gps_list=gps_list)
        if pair:
            pairs.append({
                "signal": ds,
                "gps": pair["dataset"],
                "coord_kind": pair["coord_kind"],
                "coord_cols": pair["coord_cols"],
                "lat_col": pair["lat_col"],
                "lon_col": pair["lon_col"],
                "match": pair.get("match"),
            })
    return pairs


def _horizontal_cols(gps_id: str) -> tuple[str, str, bool] | None:
    """GPS データセットの水平面2列と、緯度経度と確定できるかを返す。"""
    cols = dataset_schema(gps_id)["columns"]
    lat, lon = detect_latlon(cols)
    if lat and lon:
        return lon, lat, True
    axes = detect_coord_axes(cols)
    if "x" in axes and "y" in axes:
        return axes["x"], axes["y"], False
    _, cc = coord_columns(cols)
    return (cc[0], cc[1], False) if len(cc) >= 2 else None


def _route_extent(gps_id: str) -> dict[str, Any] | None:
    """GPS ルートの重心と外接矩形 (bbox) を1クエリで求める (全点は読まない)。"""
    hz = _horizontal_cols(gps_id)
    if not hz:
        return None
    xcol, ycol, known_geographic = hz
    table, colmap = _schema_map(gps_id)
    if xcol not in colmap or ycol not in colmap:
        return None
    qx, qy = _quote(xcol), _quote(ycol)
    with db.duck() as con:
        row = con.execute(
            f"SELECT min({qx}), max({qx}), avg({qx}), min({qy}), max({qy}), avg({qy}) "
            f"FROM {_quote(table)}").fetchone()
    if row is None or row[0] is None or row[3] is None:
        return None
    xmin, xmax, xavg, ymin, ymax, yavg = (float(v) for v in row)
    geographic = known_geographic or _looks_like_degrees([ymin, ymax], [xmin, xmax])
    return {
        "cx": xavg, "cy": yavg,
        "xmin": xmin, "xmax": xmax, "ymin": ymin, "ymax": ymax,
        "mode": "geographic" if geographic else "planar",
    }


def _bbox_overlap(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return not (a["xmax"] < b["xmin"] or a["xmin"] > b["xmax"]
                or a["ymax"] < b["ymin"] or a["ymin"] > b["ymax"])


def _haversine_km(x1: float, y1: float, x2: float, y2: float) -> float:
    """経度・緯度2点間の大円距離を km で返す。"""
    lat1, lat2 = math.radians(y1), math.radians(y2)
    dlat = lat2 - lat1
    dlon = math.radians(x2 - x1)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * math.asin(min(1.0, math.sqrt(h)))


def _extent_distance(a: dict[str, Any], b: dict[str, Any]) -> tuple[float, str, float] | None:
    """ルート重心間の距離・単位・ルート寸法で正規化した距離を返す。"""
    if a["mode"] != b["mode"]:
        return None

    def planar_distance(x1: float, y1: float, x2: float, y2: float) -> float:
        return math.hypot(x2 - x1, y2 - y1)

    if a["mode"] == "geographic":
        measure = _haversine_km
        unit = "km"
    else:
        measure = planar_distance
        unit = "座標単位"
    distance = measure(a["cx"], a["cy"], b["cx"], b["cy"])
    size_a = measure(a["xmin"], a["ymin"], a["xmax"], a["ymax"])
    size_b = measure(b["xmin"], b["ymin"], b["xmax"], b["ymax"])
    scale = max(size_a, size_b, 1e-9)
    return distance, unit, distance / scale


def similar_runs(signal_id: str, limit: int = 10) -> dict[str, Any]:
    """指定した走行 (信号データ) の GPS ルートに近い順で、比較候補の走行を返す。

    bbox の重なりに加え、ルート寸法で正規化した重心距離も使う。これにより、
    完全には重ならない平行コースや、長い走行の一部分だけを記録した候補も拾う。
    緯度経度とローカル座標は混ぜず、同じ会社タグは補助根拠として扱う。
    """
    get_dataset(signal_id)  # 存在チェック
    gps_list = list_gps_datasets()
    ref_pair = find_gps_pair(signal_id, gps_list=gps_list)
    ref = _route_extent(ref_pair["dataset"]["id"]) if ref_pair else None
    ref_tags = _norm_tags(get_dataset(signal_id).get("tags"))

    runs = []
    for pair in gps_pairs(gps_list=gps_list):
        sig = pair["signal"]
        if sig["id"] == signal_id:
            continue
        ext = _route_extent(pair["gps"]["id"])
        same_tag = bool(ref_tags & _norm_tags(sig.get("tags")))
        distance = distance_unit = relative_distance = None
        overlaps = nearby = False
        if ref is not None and ext is not None:
            measured = _extent_distance(ref, ext)
            if measured:
                raw_distance, distance_unit, relative_distance = measured
                distance = round(raw_distance, 3 if distance_unit == "km" else 2)
                relative_distance = round(relative_distance, 3)
                overlaps = _bbox_overlap(ref, ext)
                nearby = overlaps or relative_distance <= 1.5
        runs.append({
            "signal": sig, "gps": pair["gps"], "match": pair.get("match"),
            "distance": distance, "distance_unit": distance_unit,
            "relative_distance": relative_distance,
            "overlaps": overlaps, "nearby": nearby, "same_tag": same_tag,
            "coord_mode": ext["mode"] if ext else None,
            "recommended": nearby or same_tag,
        })

    # GPS範囲重複 → 近接 → その他。同区分では重心距離、同タグの順。
    runs.sort(key=lambda r: (
        0 if r["overlaps"] else 1,
        0 if r["nearby"] else 1,
        r["distance"] if r["distance"] is not None else float("inf"),
        0 if r["same_tag"] else 1,
    ))
    return {"reference_gps": ref_pair["dataset"]["name"] if ref_pair else None,
            "has_reference": ref is not None, "runs": runs[:limit]}


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


def _time_seconds_expr(dataset_id: str) -> str | None:
    """絶対時刻をエポック秒で返す SQL 式を返す。解決できなければ None。

    temporal 型の列があればそれをそのまま使う。無ければ、経過時間らしい
    数値列とファイル名から推定した記録開始日時 (extract_timestamp) を
    合成して疑似絶対時刻とする。GPS と信号で記録開始が数秒ずれていても、
    それぞれの実際の開始時刻を基準にするためズレが吸収される。
    """
    schema = dataset_schema(dataset_id)
    cols = schema["columns"]
    temporal = next((c["name"] for c in cols if c["kind"] == "temporal"), None)
    if temporal:
        return f"epoch({_quote(temporal)})"
    elapsed = next((c["name"] for c in cols
                    if c["kind"] == "numeric" and _TIME_NAME_RE.search(c["name"])), None)
    if not elapsed:
        return None
    ds = schema["dataset"]
    start = extract_timestamp(ds["original_filename"] or ds["name"])
    if not start:
        return None
    return f"{start.timestamp()!r} + {_quote(elapsed)}"


def _time_based_row_map(con: Any, sig_table: str, sig_time_expr: str, sig_where: str,
                        sig_params: tuple[Any, ...], gps_table: str,
                        gps_time_expr: str) -> list[tuple[Any, Any]] | None:
    """信号側の各行 (フィルタ後) を、実際の時刻が最も近い GPS 側の rowid に
    対応づける (行位置がずれていても、記録開始日時・サンプリング周期の
    違いを吸収できる)。ズレの中央値が大きすぎる場合は信頼できないと
    みなし None を返す (呼び出し側は rowid 結合にフォールバックする)。
    """
    sig_rows = con.execute(
        f"SELECT rowid, {sig_time_expr} FROM {_quote(sig_table)}{sig_where} ORDER BY rowid",
        sig_params).fetchall()
    gps_rows = con.execute(
        f"SELECT rowid, {gps_time_expr} FROM {_quote(gps_table)} ORDER BY 2").fetchall()
    if not sig_rows or not gps_rows:
        return None
    if any(r[1] is None for r in sig_rows) or any(r[1] is None for r in gps_rows):
        return None
    gps_rids = [r[0] for r in gps_rows]
    gps_times = [r[1] for r in gps_rows]

    mapping: list[tuple[Any, Any]] = []
    deltas: list[float] = []
    for sig_rid, sig_t in sig_rows:
        i = bisect.bisect_left(gps_times, sig_t)
        candidates = [j for j in (i - 1, i) if 0 <= j < len(gps_times)]
        best = min(candidates, key=lambda j: abs(gps_times[j] - sig_t))
        mapping.append((sig_rid, gps_rids[best]))
        deltas.append(abs(gps_times[best] - sig_t))

    deltas.sort()
    median_dt = deltas[len(deltas) // 2]
    if median_dt > TIME_ALIGN_MAX_MEDIAN_DT_SEC:
        return None
    return mapping


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
            or next((n for n in sig_cols if _TIME_NAME_RE.search(n)), None)
    if x and x not in sig_cols:
        raise QueryError(f"信号データに列がありません: {x}")

    where, params = _build_where(filters, sig_cols)
    limit = _clamp_points(max_points)

    # 水平面に使わない座標軸 (高度 GPS_z など) も色分け用に取得しておく。
    # lat/lon を明示指定した場合でも高度を落とさないよう、GPS 側で独立に探す。
    axes_all = detect_coord_axes(gps_schema["columns"])
    alt_candidate = next(
        (axes_all[a] for a in ("z", "y", "x") if axes_all.get(a) and axes_all[a] not in coord_cols),
        None)
    fetch_coords = coord_cols + ([alt_candidate] if alt_candidate else [])

    # 信号側で必要な列だけを rowid 付きで抽出 → GPS と rowid で結合 → 間引き
    sel_cols = list(dict.fromkeys([c for c in ([x] if x else []) + signals +
                                   ([color_signal] if color_signal else [])]))
    inner_sel = ", ".join(_quote(c) for c in sel_cols)
    inner_sel = (inner_sel + ", ") if inner_sel else ""

    # --- GPS と信号の対応づけ ---
    # 既定は行位置 (rowid) の 1:1 対応 (同時刻・同サンプリング周期が前提)。
    # 双方に実時刻 (temporal 列、または経過時間+ファイル名の記録開始日時)
    # が分かる場合は、実際の時刻が最も近い行同士を対応づける方式に切り替える。
    # これにより、記録開始が数秒ずれていたり行数が完全一致しない場合でも
    # 正しく対応づけられる (行位置だけを信じると静かにズレてしまうため)。
    # 信号データ自体がGPS源を兼ねている (自己完結型) 場合は、同じテーブル同士の
    # rowid結合になり常に1:1で正しく揃うため、時刻ベース整列の判定は不要。
    align_mode = "self" if gps_id == dataset_id else "rowid"
    with db.duck() as con:
        row_map = None
        if align_mode != "self":
            sig_time_expr = _time_seconds_expr(dataset_id)
            gps_time_expr = _time_seconds_expr(gps_id)
            if sig_time_expr and gps_time_expr:
                row_map = _time_based_row_map(
                    con, sig_table, sig_time_expr, where, params, gps_table, gps_time_expr)
        try:
            if row_map:
                align_mode = "time"
                con.register("__gps_align_map", pd.DataFrame(row_map, columns=["sig_r", "gps_r"]))
                join_clause = (f'JOIN __gps_align_map m ON f.__r = m.sig_r '
                              f'JOIN {_quote(gps_table)} g ON g.rowid = m.gps_r')
            else:
                join_clause = f'JOIN {_quote(gps_table)} g ON f.__r = g.rowid'

            total = con.execute(
                f"SELECT count(*) FROM (SELECT rowid AS __r FROM {_quote(sig_table)}{where}) f "
                f"{join_clause}", params).fetchone()[0]
            if not total:
                raise QueryError(
                    "結合できる行がありません (GPS と信号の行位置・時刻が一致していない可能性があります)")
            stride = max(1, math.ceil(total / limit))
            out_cols = [f"f.{_quote(c)}" for c in sel_cols] + [f"g.{_quote(c)}" for c in fetch_coords]
            rows = con.execute(
                f"SELECT f.__r, {', '.join(out_cols)} FROM ("
                f"  SELECT rowid AS __r, {inner_sel}row_number() OVER (ORDER BY rowid) AS __rn"
                f"  FROM {_quote(sig_table)}{where}"
                f") f {join_clause} "
                f"WHERE (f.__rn - 1) % {stride} = 0 ORDER BY f.__r", params).fetchall()
        finally:
            if row_map:
                con.unregister("__gps_align_map")

    # 列の並び: __r, [sel_cols...], [fetch_coords...]
    index = [r[0] for r in rows]
    col_at = {c: [_jsonable(r[i + 1]) for r in rows] for i, c in enumerate(sel_cols)}
    coord_at = {c: [_jsonable(r[len(sel_cols) + 1 + i]) for r in rows]
                for i, c in enumerate(fetch_coords)}

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
        "align_mode": align_mode,
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

    # 水平面に使わなかった座標列 (高度 GPS_z など) を色分け用に返す
    alt_col = alt_candidate or next((c for c in coord_cols if c not in (a_name, b_name)), None)
    if alt_col and alt_col in coord_at:
        result["alt_col"] = alt_col
        result["alt_values"] = coord_at[alt_col]
    return result
