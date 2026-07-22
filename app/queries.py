"""可視化用の分析クエリ。

列名はスキーマ照合でホワイトリスト検証し、値はすべて
プレースホルダでバインドする (SQL インジェクション対策)。
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np

from . import db
from .ingest import dataset_schema

MAX_POINTS_DEFAULT = 5000
MAX_POINTS_LIMIT = 50000

FILTER_OPS = {
    "eq": "=", "ne": "!=", "gt": ">", "ge": ">=", "lt": "<", "le": "<=",
}


class QueryError(Exception):
    pass


def _quote(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def _schema_map(dataset_id: str) -> tuple[str, dict[str, dict[str, Any]]]:
    schema = dataset_schema(dataset_id)
    table = schema["dataset"]["table_name"]
    return table, {c["name"]: c for c in schema["columns"]}


def _check_columns(cols: dict[str, dict[str, Any]], *names: str) -> None:
    for n in names:
        if n not in cols:
            raise QueryError(f"列が存在しません: {n}")


def _build_where(filters: list[dict[str, Any]] | None,
                 cols: dict[str, dict[str, Any]]) -> tuple[str, list[Any]]:
    """フィルタ条件 [{column, op, value}] から WHERE 句を組み立てる。"""
    if not filters:
        return "", []
    clauses: list[str] = []
    params: list[Any] = []
    for f in filters:
        col, op = f.get("column"), f.get("op")
        _check_columns(cols, col)
        q = _quote(col)
        if op in FILTER_OPS:
            value = f.get("value")
            if cols[col]["kind"] == "numeric":
                try:
                    value = float(value)
                except (TypeError, ValueError):
                    raise QueryError(f"数値列 {col} の条件値が数値ではありません: {value!r}")
                clauses.append(f"{q} {FILTER_OPS[op]} ?")
            elif cols[col]["kind"] == "temporal":
                clauses.append(f"CAST({q} AS VARCHAR) {FILTER_OPS[op]} ?")
                value = str(value)
            else:
                clauses.append(f"{q} {FILTER_OPS[op]} ?")
                value = str(value)
            params.append(value)
        elif op == "contains":
            clauses.append(f"CAST({q} AS VARCHAR) LIKE ?")
            params.append(f"%{f.get('value', '')}%")
        elif op == "notnull":
            clauses.append(f"{q} IS NOT NULL")
        elif op == "isnull":
            clauses.append(f"{q} IS NULL")
        else:
            raise QueryError(f"未対応の演算子です: {op}")
    return " WHERE " + " AND ".join(clauses), params


def _clamp_points(max_points: int | None) -> int:
    if not max_points or max_points <= 0:
        return MAX_POINTS_DEFAULT
    return min(int(max_points), MAX_POINTS_LIMIT)


def timeseries(dataset_id: str, x: str, ys: list[str],
               filters: list[dict[str, Any]] | None = None,
               max_points: int | None = None) -> dict[str, Any]:
    """x で並べた時系列。点数が多い場合は等間隔ストライドで間引く。"""
    table, cols = _schema_map(dataset_id)
    if not ys:
        raise QueryError("Y軸の列を1つ以上選択してください")
    _check_columns(cols, x, *ys)
    where, params = _build_where(filters, cols)
    limit = _clamp_points(max_points)

    with db.duck() as con:
        total = con.execute(f'SELECT count(*) FROM {_quote(table)}{where}', params).fetchone()[0]
        stride = max(1, math.ceil(total / limit))
        select_cols = ", ".join(_quote(c) for c in [x] + list(ys))
        sql = (
            f"SELECT {select_cols} FROM ("
            f"  SELECT {select_cols}, row_number() OVER (ORDER BY {_quote(x)}) AS __rn"
            f"  FROM {_quote(table)}{where}"
            f") WHERE (__rn - 1) % {stride} = 0 ORDER BY __rn"
        )
        rows = con.execute(sql, params).fetchall()

    series: dict[str, list[Any]] = {c: [] for c in [x] + list(ys)}
    order = [x] + list(ys)
    for row in rows:
        for i, c in enumerate(order):
            series[c].append(_jsonable(row[i]))
    return {"total_rows": total, "returned_rows": len(rows), "stride": stride,
            "x": x, "ys": ys, "data": series}


def preview(dataset_id: str, limit: int = 100) -> dict[str, Any]:
    table, cols = _schema_map(dataset_id)
    with db.duck() as con:
        rel = con.execute(f'SELECT * FROM {_quote(table)} LIMIT {int(limit)}')
        names = [d[0] for d in rel.description]
        rows = [[_jsonable(v) for v in row] for row in rel.fetchall()]
    return {"columns": names, "rows": rows}


def summary(dataset_id: str) -> dict[str, Any]:
    """DuckDB の SUMMARIZE で全列の統計を一括取得する。"""
    table, _ = _schema_map(dataset_id)
    with db.duck() as con:
        rel = con.execute(f'SUMMARIZE {_quote(table)}')
        names = [d[0] for d in rel.description]
        rows = [dict(zip(names, (_jsonable(v) for v in row))) for row in rel.fetchall()]
    return {"stats": rows}


def histogram(dataset_id: str, column: str, bins: int = 40,
              filters: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    table, cols = _schema_map(dataset_id)
    _check_columns(cols, column)
    where, params = _build_where(filters, cols)
    q = _quote(column)
    bins = max(5, min(int(bins), 200))

    if cols[column]["kind"] != "numeric":
        # カテゴリ列は上位カテゴリの度数分布
        sql = (f"SELECT CAST({q} AS VARCHAR) AS v, count(*) AS c FROM {_quote(table)}{where} "
               f"GROUP BY v ORDER BY c DESC LIMIT 40")
        with db.duck() as con:
            rows = con.execute(sql, params).fetchall()
        return {"kind": "categorical",
                "labels": [r[0] for r in rows], "counts": [r[1] for r in rows]}

    with db.duck() as con:
        mn, mx = con.execute(
            f"SELECT min({q}), max({q}) FROM {_quote(table)}{where}", params).fetchone()
        if mn is None or mx is None:
            return {"kind": "numeric", "edges": [], "counts": []}
        mn, mx = float(mn), float(mx)
        if mn == mx:
            mx = mn + 1
        width = (mx - mn) / bins
        sql = (
            f"SELECT least(cast(floor(({q} - ?) / ?) as int), ?) AS b, count(*) AS c "
            f"FROM {_quote(table)}{where or ' WHERE 1=1'} AND {q} IS NOT NULL "
            f"GROUP BY b ORDER BY b"
        )
        rows = con.execute(sql, [mn, width, bins - 1] + params).fetchall()
    counts = [0] * bins
    for b, c in rows:
        if b is not None and 0 <= b < bins:
            counts[b] = c
    edges = [mn + width * i for i in range(bins + 1)]
    return {"kind": "numeric", "edges": edges, "counts": counts}


def correlation(dataset_id: str, columns: list[str] | None = None,
                filters: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    table, cols = _schema_map(dataset_id)
    numeric = [c for c, m in cols.items() if m["kind"] == "numeric"]
    targets = [c for c in (columns or numeric) if c in numeric][:30]
    if len(targets) < 2:
        raise QueryError("相関には数値列が2つ以上必要です")
    where, params = _build_where(filters, cols)

    exprs = []
    for i, a in enumerate(targets):
        for b_col in targets[i + 1:]:
            exprs.append(f"corr({_quote(a)}, {_quote(b_col)})")
    with db.duck() as con:
        values = con.execute(
            f"SELECT {', '.join(exprs)} FROM {_quote(table)}{where}", params).fetchone()

    n = len(targets)
    matrix = [[1.0] * n for _ in range(n)]
    k = 0
    for i in range(n):
        for j in range(i + 1, n):
            v = values[k]
            v = None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 4)
            matrix[i][j] = matrix[j][i] = v
            k += 1
    return {"columns": targets, "matrix": matrix}


def scatter(dataset_id: str, x: str, y: str, color: str | None = None,
            filters: list[dict[str, Any]] | None = None,
            max_points: int | None = None) -> dict[str, Any]:
    table, cols = _schema_map(dataset_id)
    _check_columns(cols, x, y)
    if color:
        _check_columns(cols, color)
    where, params = _build_where(filters, cols)
    limit = _clamp_points(max_points)

    select = [x, y] + ([color] if color else [])
    select_sql = ", ".join(_quote(c) for c in select)
    with db.duck() as con:
        total = con.execute(f"SELECT count(*) FROM {_quote(table)}{where}", params).fetchone()[0]
        stride = max(1, math.ceil(total / limit))
        sql = (
            f"SELECT {select_sql} FROM ("
            f"  SELECT {select_sql}, row_number() OVER () AS __rn FROM {_quote(table)}{where}"
            f") WHERE (__rn - 1) % {stride} = 0"
        )
        rows = con.execute(sql, params).fetchall()
    out: dict[str, list[Any]] = {c: [] for c in select}
    for row in rows:
        for i, c in enumerate(select):
            out[c].append(_jsonable(row[i]))
    return {"total_rows": total, "returned_rows": len(rows), "data": out}


def _compare_tables(
    dataset_ids: list[str], *needed: str, minimum: int = 2
) -> list[tuple[str, str, dict[str, dict[str, Any]]]]:
    """比較対象の (dataset_id, table, cols) を検証付きで揃える。"""
    if len(dataset_ids) < minimum:
        message = "分析対象のデータセットがありません" if minimum == 1 else \
            "比較には2つ以上のデータセットを選択してください"
        raise QueryError(message)
    tables = []
    for ds_id in dataset_ids:
        table, cols = _schema_map(ds_id)
        _check_columns(cols, *needed)
        tables.append((ds_id, table, cols))
    return tables


def compare_histogram(dataset_ids: list[str], column: str, bins: int = 40,
                      filters: list[dict[str, Any]] | None = None,
                      minimum_datasets: int = 2,
                      as_category: bool = False) -> dict[str, Any]:
    """複数データセットを共通のビン境界で集計し、分布を比較可能にする。

    データセットごとの行数差を吸収するため、割合 (%) も返す。
    """
    bins = max(5, min(int(bins), 200))
    tables = _compare_tables(dataset_ids, column, minimum=minimum_datasets)

    if as_category or any(cols[column]["kind"] != "numeric" for _, _, cols in tables):
        # カテゴリ列: 全データセット合算の上位カテゴリを共通ラベルにする
        totals: dict[str, int] = {}
        per_ds: dict[str, dict[str, int]] = {}
        with db.duck() as con:
            for ds_id, table, cols in tables:
                where, params = _build_where(filters, cols)
                rows = con.execute(
                    f'SELECT CAST({_quote(column)} AS VARCHAR) AS v, count(*) FROM {_quote(table)}{where} GROUP BY v',
                    params,
                ).fetchall()
                per_ds[ds_id] = {r[0]: r[1] for r in rows}
                for k, c in per_ds[ds_id].items():
                    totals[k] = totals.get(k, 0) + c
        labels = [k for k, _ in sorted(totals.items(), key=lambda x: -x[1])[:40]]
        try:
            labels.sort(key=lambda v: float(v))  # ギア段などの数値カテゴリは数値順に
        except (TypeError, ValueError):
            pass
        series = []
        for ds_id, _, _ in tables:
            counts = [per_ds[ds_id].get(label, 0) for label in labels]
            n = sum(per_ds[ds_id].values()) or 1
            series.append({"dataset_id": ds_id, "counts": counts,
                           "percents": [round(c * 100 / n, 3) for c in counts]})
        return {"kind": "categorical", "labels": labels, "series": series}

    # 数値列: 全データセット共通の min/max からビン境界を決める
    q = _quote(column)
    with db.duck() as con:
        mns, mxs = [], []
        for _, table, cols in tables:
            where, params = _build_where(filters, cols)
            mn, mx = con.execute(
                f"SELECT min({q}), max({q}) FROM {_quote(table)}{where}", params).fetchone()
            if mn is not None:
                mns.append(float(mn))
                mxs.append(float(mx))
        if not mns:
            return {"kind": "numeric", "edges": [], "series": []}
        mn, mx = min(mns), max(mxs)
        if mn == mx:
            mx = mn + 1
        width = (mx - mn) / bins
        series = []
        for ds_id, table, cols in tables:
            where, params = _build_where(filters, cols)
            rows = con.execute(
                f"SELECT least(cast(floor(({q} - ?) / ?) as int), ?) AS b, count(*) "
                f"FROM {_quote(table)}{where or ' WHERE 1=1'} AND {q} IS NOT NULL GROUP BY b ORDER BY b",
                [mn, width, bins - 1] + params,
            ).fetchall()
            counts = [0] * bins
            for b, c in rows:
                if b is not None and 0 <= b < bins:
                    counts[b] = c
            n = sum(counts) or 1
            series.append({"dataset_id": ds_id, "counts": counts,
                           "percents": [round(c * 100 / n, 3) for c in counts]})
    edges = [mn + width * i for i in range(bins + 1)]
    return {"kind": "numeric", "edges": edges, "series": series}


MAX_GROUPS = 30


def compare_groupstats(dataset_ids: list[str], column: str, group_by: str,
                       filters: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """グループ列 (ギア段・走行モードなど) で層別し、データセット間で
    信号の統計量 (箱ひげ図用の五数要約 + 平均) を比較する。"""
    if column == group_by:
        raise QueryError("信号とグループ列には別の列を指定してください")

    per_ds: dict[str, dict[str, dict[str, Any]]] = {}
    totals: dict[str, int] = {}
    for ds_id, table, cols in _compare_tables(dataset_ids, column, group_by):
        if cols[column]["kind"] != "numeric":
            raise QueryError(f"信号には数値列を指定してください: {column}")
        q = _quote(column)
        g = _quote(group_by)
        where, params = _build_where(filters, cols)
        sql = (
            f"SELECT CAST({g} AS VARCHAR) AS grp, count({q}), avg({q}), min({q}), max({q}), "
            f"quantile_cont({q}, 0.25), quantile_cont({q}, 0.5), quantile_cont({q}, 0.75) "
            f"FROM {_quote(table)}{where or ' WHERE 1=1'} AND {q} IS NOT NULL AND {g} IS NOT NULL GROUP BY grp"
        )
        with db.duck() as con:
            rows = con.execute(sql, params).fetchall()
        if len(rows) > 200:
            raise QueryError(f"グループ列「{group_by}」の値が多すぎます ({len(rows)} 種類)。"
                             "ギア段・モードなどの離散列を指定してください")
        stats = {}
        for grp, cnt, avg, mn, mx, q1, med, q3 in rows:
            iqr = (q3 - q1) if q1 is not None and q3 is not None else 0
            stats[grp] = {
                "count": cnt, "avg": _jsonable(avg), "min": _jsonable(mn), "max": _jsonable(mx),
                "q1": _jsonable(q1), "median": _jsonable(med), "q3": _jsonable(q3),
                "lowerfence": _jsonable(max(mn, q1 - 1.5 * iqr)) if q1 is not None else None,
                "upperfence": _jsonable(min(mx, q3 + 1.5 * iqr)) if q3 is not None else None,
            }
            totals[grp] = totals.get(grp, 0) + cnt
        per_ds[ds_id] = stats

    # 共通のグループ軸: 件数上位 MAX_GROUPS を数値順 (不可なら辞書順) に並べる
    groups = sorted(totals, key=lambda k: -totals[k])[:MAX_GROUPS]
    try:
        groups.sort(key=float)
    except (TypeError, ValueError):
        groups.sort()

    series = []
    for ds_id in dataset_ids:
        series.append({
            "dataset_id": ds_id,
            "groups": [per_ds[ds_id].get(grp) for grp in groups],
        })
    return {"column": column, "group_by": group_by, "groups": groups, "series": series}


def compare_summary(dataset_ids: list[str], column: str,
                    filters: list[dict[str, Any]] | None = None,
                    minimum_datasets: int = 2) -> dict[str, Any]:
    """選択信号の基本統計量をデータセット間で比較する (フィルタ適用可)。"""
    series = []
    for ds_id, table, cols in _compare_tables(
        dataset_ids, column, minimum=minimum_datasets
    ):
        if cols[column]["kind"] != "numeric":
            raise QueryError(f"信号には数値列を指定してください: {column}")
        q = _quote(column)
        where, params = _build_where(filters, cols)
        row = None
        with db.duck() as con:
            row = con.execute(
                f"SELECT count({q}), avg({q}), stddev({q}), min({q}), max({q}), "
                f"quantile_cont({q}, 0.25), quantile_cont({q}, 0.5), quantile_cont({q}, 0.75) "
                f"FROM {_quote(table)}{where}", params).fetchone()
        keys = ["count", "avg", "std", "min", "max", "q25", "q50", "q75"]
        series.append({"dataset_id": ds_id, **{k: _jsonable(v) for k, v in zip(keys, row)}})
    return {"column": column, "series": series}


def compare_curve(dataset_ids: list[str], x: str, y: str, bins: int = 40,
                  filters: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """特性カーブ比較: X をビン分割し、ビンごとの Y の平均と P10-P90 帯を返す。

    例: 車速×エンジン回転数、スロットル×加速度など、時間軸に依存しない
    物理特性をデータセット間で比較する。
    """
    if x == y:
        raise QueryError("X と Y には別の列を指定してください")
    bins = max(5, min(int(bins), 200))
    tables = _compare_tables(dataset_ids, x, y)
    qx, qy = _quote(x), _quote(y)

    with db.duck() as con:
        mns, mxs = [], []
        for _, table, cols in tables:
            if cols[x]["kind"] != "numeric" or cols[y]["kind"] != "numeric":
                raise QueryError("特性カーブの X / Y には数値列を指定してください")
            where, params = _build_where(filters, cols)
            mn, mx = con.execute(
                f"SELECT min({qx}), max({qx}) FROM {_quote(table)}{where}", params).fetchone()
            if mn is not None:
                mns.append(float(mn))
                mxs.append(float(mx))
        if not mns:
            return {"centers": [], "series": []}
        mn, mx = min(mns), max(mxs)
        if mn == mx:
            mx = mn + 1
        width = (mx - mn) / bins

        series = []
        for ds_id, table, cols in tables:
            where, params = _build_where(filters, cols)
            rows = con.execute(
                f"SELECT least(cast(floor(({qx} - ?) / ?) as int), ?) AS b, "
                f"count({qy}), avg({qy}), quantile_cont({qy}, 0.1), quantile_cont({qy}, 0.9) "
                f"FROM {_quote(table)}{where or ' WHERE 1=1'} "
                f"AND {qx} IS NOT NULL AND {qy} IS NOT NULL GROUP BY b ORDER BY b",
                [mn, width, bins - 1] + params,
            ).fetchall()
            mean = [None] * bins
            p10 = [None] * bins
            p90 = [None] * bins
            count = [0] * bins
            for b, cnt, avg, lo, hi in rows:
                if b is not None and 0 <= b < bins:
                    count[b] = cnt
                    mean[b] = _jsonable(avg)
                    p10[b] = _jsonable(lo)
                    p90[b] = _jsonable(hi)
            series.append({"dataset_id": ds_id, "mean": mean, "p10": p10, "p90": p90, "count": count})
    centers = [mn + width * (i + 0.5) for i in range(bins)]
    return {"x": x, "y": y, "centers": centers, "series": series}


_CDF_PS = [i / 100 for i in range(101)]


def compare_cdf(dataset_ids: list[str], column: str,
                filters: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """累積分布 (CDF) 比較: 1% 刻みのパーセンタイル値を返す。"""
    series = []
    for ds_id, table, cols in _compare_tables(dataset_ids, column):
        if cols[column]["kind"] != "numeric":
            raise QueryError(f"信号には数値列を指定してください: {column}")
        where, params = _build_where(filters, cols)
        with db.duck() as con:
            (values,) = con.execute(
                f"SELECT quantile_cont({_quote(column)}, {_CDF_PS}) FROM {_quote(table)}{where}",
                params).fetchone()
        series.append({"dataset_id": ds_id,
                       "values": [_jsonable(v) for v in values] if values is not None else None})
    return {"column": column, "percents": [p * 100 for p in _CDF_PS], "series": series}


MAX_DIFF_SIGNALS = 100
_DIFF_PS = [i / 100 for i in range(1, 100)]


def compare_diff(dataset_ids: list[str], baseline: str | None = None,
                 filters: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """彼我差分サマリ: 共通する数値信号を全スキャンし、基準データセットとの
    差を KS 統計量 (分布のずれ 0〜1) と平均差でランキングする。"""
    tables = _compare_tables(dataset_ids)
    baseline = baseline or dataset_ids[0]
    if baseline not in dataset_ids:
        raise QueryError("基準データセットが比較対象に含まれていません")

    # 全データセットに共通する数値列
    common = [c for c, m in tables[0][2].items()
              if m["kind"] == "numeric" and
              all(c in cols and cols[c]["kind"] == "numeric" for _, _, cols in tables[1:])]
    truncated = len(common) > MAX_DIFF_SIGNALS
    common = common[:MAX_DIFF_SIGNALS]
    if not common:
        raise QueryError("共通する数値列がありません")

    # データセットごとに1クエリで全信号の平均と 1〜99% 分位点を取得
    stats: dict[str, dict[str, tuple[Any, Any]]] = {}
    for ds_id, table, cols in tables:
        where, params = _build_where(filters, cols)
        exprs = ", ".join(
            f"avg({_quote(c)}), quantile_cont({_quote(c)}, {_DIFF_PS})" for c in common)
        with db.duck() as con:
            row = con.execute(f"SELECT {exprs} FROM {_quote(table)}{where}", params).fetchone()
        stats[ds_id] = {c: (row[i * 2], row[i * 2 + 1]) for i, c in enumerate(common)}

    def ks(qa: Any, qb: Any) -> float | None:
        if qa is None or qb is None:
            return None
        a = np.asarray(qa, dtype=np.float64)
        b = np.asarray(qb, dtype=np.float64)
        if np.isnan(a).any() or np.isnan(b).any():
            return None
        grid = np.union1d(a, b)
        ps = np.asarray(_DIFF_PS)
        fa = np.interp(grid, a, ps, left=0.0, right=1.0)
        fb = np.interp(grid, b, ps, left=0.0, right=1.0)
        return round(float(np.max(np.abs(fa - fb))), 4)

    signals = []
    others = [d for d in dataset_ids if d != baseline]
    for c in common:
        base_avg, base_q = stats[baseline][c]
        comps = []
        for d in others:
            avg, q = stats[d][c]
            delta_pct = None
            if base_avg is not None and avg is not None and abs(float(base_avg)) > 1e-12:
                delta_pct = round((float(avg) - float(base_avg)) * 100 / abs(float(base_avg)), 2)
            comps.append({"dataset_id": d, "avg": _jsonable(avg),
                          "delta_pct": delta_pct, "ks": ks(base_q, q)})
        max_ks = max((x["ks"] for x in comps if x["ks"] is not None), default=None)
        signals.append({"name": c, "base_avg": _jsonable(base_avg), "comps": comps, "max_ks": max_ks})

    signals.sort(key=lambda s: -(s["max_ks"] if s["max_ks"] is not None else -1))
    return {"baseline": baseline, "signals": signals, "truncated": truncated}


# ---------- 自由分析 (万能チャート) ----------

CHART_KINDS = {"scatter", "line", "bar", "box", "histogram", "heatmap"}
AGG_FUNCS = {"avg": "avg", "sum": "sum", "count": "count", "min": "min",
             "max": "max", "median": "median", "share": "count"}
MAX_BAR_GROUPS = 40
MAX_COLOR_GROUPS = 8


def chart(dataset_id: str, kind: str, x: str | None = None, y: str | None = None,
          color: str | None = None, agg: str = "avg", bins: int = 40,
          filters: list[dict[str, Any]] | None = None,
          max_points: int | None = None) -> dict[str, Any]:
    """チャートビルダー用の汎用集計。kind に応じて必要なデータを返す。"""
    if kind not in CHART_KINDS:
        raise QueryError(f"未対応のチャート種別です: {kind}")
    table, cols = _schema_map(dataset_id)
    where, params = _build_where(filters, cols)
    bins = max(5, min(int(bins), 200))

    def need(col: str | None, label: str, numeric: bool = False):
        if not col:
            raise QueryError(f"{label} の列を選択してください")
        _check_columns(cols, col)
        if numeric and cols[col]["kind"] != "numeric":
            raise QueryError(f"{label} には数値列を指定してください: {col}")

    result: dict[str, Any]
    if kind in ("scatter", "line"):
        need(x, "X")
        need(y, "Y", numeric=True)
        if color:
            need(color, "色分け")
        select = [x, y] + ([color] if color and color not in (x, y) else [])
        select_sql = ", ".join(_quote(c) for c in select)
        limit = _clamp_points(max_points)
        with db.duck() as con:
            total = con.execute(f"SELECT count(*) FROM {_quote(table)}{where}", params).fetchone()[0]
            stride = max(1, math.ceil(total / limit))
            order = f"ORDER BY {_quote(x)}" if kind == "line" else "ORDER BY 1"
            rows = con.execute(
                f"SELECT {select_sql} FROM ("
                f"  SELECT {select_sql}, row_number() OVER ({order}) AS __rn FROM {_quote(table)}{where}"
                f") WHERE (__rn - 1) % {stride} = 0 ORDER BY __rn", params).fetchall()
        data: dict[str, list[Any]] = {c: [] for c in select}
        for row in rows:
            for i, c in enumerate(select):
                data[c].append(_jsonable(row[i]))
        result = {"kind": kind, "data": data, "total_rows": total, "returned_rows": len(rows)}

    elif kind == "bar":
        need(x, "X")
        if agg not in AGG_FUNCS:
            raise QueryError(f"未対応の集計です: {agg}")
        if agg not in ("count", "share"):
            need(y, "Y", numeric=True)
        expr = "count(*)" if agg in ("count", "share") else f"{AGG_FUNCS[agg]}({_quote(y)})"
        gx = f"CAST({_quote(x)} AS VARCHAR)"
        gc = f"CAST({_quote(color)} AS VARCHAR)" if color else "''"
        if color:
            need(color, "色分け")
        with db.duck() as con:
            rows = con.execute(
                f"SELECT {gx}, {gc}, {expr}, count(*) FROM {_quote(table)}"
                f"{where or ' WHERE 1=1'} AND {_quote(x)} IS NOT NULL GROUP BY 1, 2",
                params).fetchall()
        totals: dict[str, int] = {}
        for g, _c, _v, n in rows:
            totals[g] = totals.get(g, 0) + n
        groups = sorted(totals, key=lambda k: -totals[k])[:MAX_BAR_GROUPS]
        try:
            groups.sort(key=float)
        except (TypeError, ValueError):
            groups.sort()
        color_groups = sorted({c for _g, c, _v, _n in rows}) if color else [""]
        color_groups = color_groups[:MAX_COLOR_GROUPS]
        lookup = {(g, c): _jsonable(v) for g, c, v, _n in rows}
        series = []
        for c in color_groups:
            values = [lookup.get((g, c)) for g in groups]
            if agg == "share":
                # 割合%: 色グループ内で正規化する (N数の違いを吸収して比較できる)
                total = sum(v for _g, c2, v, _n in rows if c2 == c) or 1
                values = [round(v * 100 / total, 3) if v is not None else None for v in values]
            series.append({"label": c, "values": values})
        result = {"kind": "bar", "groups": groups, "series": series, "agg": agg}

    elif kind == "box":
        need(x, "X (グループ)")
        need(y, "Y", numeric=True)
        if color:
            need(color, "色分け")
        q = _quote(y)
        gx = f"CAST({_quote(x)} AS VARCHAR)"
        gc = f"CAST({_quote(color)} AS VARCHAR)" if color else "''"
        with db.duck() as con:
            rows = con.execute(
                f"SELECT {gx}, {gc}, count({q}), avg({q}), min({q}), max({q}), "
                f"quantile_cont({q}, 0.25), quantile_cont({q}, 0.5), quantile_cont({q}, 0.75) "
                f"FROM {_quote(table)}{where or ' WHERE 1=1'} "
                f"AND {q} IS NOT NULL AND {_quote(x)} IS NOT NULL GROUP BY 1, 2",
                params).fetchall()
        if len(rows) > 400:
            raise QueryError(f"グループが多すぎます ({len(rows)})。X には離散的な列を指定してください")
        totals = {}
        for r in rows:
            totals[r[0]] = totals.get(r[0], 0) + r[2]
        groups = sorted(totals, key=lambda k: -totals[k])[:MAX_BAR_GROUPS]
        try:
            groups.sort(key=float)
        except (TypeError, ValueError):
            groups.sort()
        color_groups = sorted({r[1] for r in rows})[:MAX_COLOR_GROUPS] if color else [""]
        stat = {}
        for g, c, cnt, avg, mn, mx, q1, med, q3 in rows:
            iqr = (q3 - q1) if q1 is not None and q3 is not None else 0
            stat[(g, c)] = {
                "count": cnt, "avg": _jsonable(avg), "q1": _jsonable(q1),
                "median": _jsonable(med), "q3": _jsonable(q3),
                "lowerfence": _jsonable(max(mn, q1 - 1.5 * iqr)) if q1 is not None else None,
                "upperfence": _jsonable(min(mx, q3 + 1.5 * iqr)) if q3 is not None else None,
            }
        series = [{"label": c, "groups": [stat.get((g, c)) for g in groups]}
                  for c in color_groups]
        result = {"kind": "box", "groups": groups, "series": series}

    elif kind == "histogram":
        need(x, "X")
        if color:
            need(color, "色分け")
        if cols[x]["kind"] != "numeric":
            gx = f"CAST({_quote(x)} AS VARCHAR)"
            gc = f"CAST({_quote(color)} AS VARCHAR)" if color else "''"
            with db.duck() as con:
                rows = con.execute(
                    f"SELECT {gx}, {gc}, count(*) FROM {_quote(table)}{where} GROUP BY 1, 2",
                    params).fetchall()
            totals = {}
            for g, _c, n in rows:
                totals[g] = totals.get(g, 0) + n
            labels = sorted(totals, key=lambda k: -totals[k])[:MAX_BAR_GROUPS]
            color_groups = sorted({c for _g, c, _n in rows})[:MAX_COLOR_GROUPS] if color else [""]
            lookup = {(g, c): n for g, c, n in rows}
            series = []
            for c in color_groups:
                counts = [lookup.get((lbl, c), 0) for lbl in labels]
                n = sum(lookup.get((l2, c), 0) for l2, c2 in lookup if c2 == c) or 1
                series.append({"label": c, "counts": counts,
                               "percents": [round(v * 100 / n, 3) for v in counts]})
            result = {"kind": "histogram", "sub": "categorical", "labels": labels, "series": series}
        else:
            q = _quote(x)
            gc = f"CAST({_quote(color)} AS VARCHAR)" if color else "''"
            with db.duck() as con:
                mn, mx = con.execute(
                    f"SELECT min({q}), max({q}) FROM {_quote(table)}{where}", params).fetchone()
                if mn is None:
                    return {"kind": "histogram", "sub": "numeric", "edges": [], "series": []}
                mn, mx = float(mn), float(mx)
                if mn == mx:
                    mx = mn + 1
                width = (mx - mn) / bins
                rows = con.execute(
                    f"SELECT least(cast(floor(({q} - ?) / ?) as int), ?) AS b, {gc}, count(*) "
                    f"FROM {_quote(table)}{where or ' WHERE 1=1'} AND {q} IS NOT NULL GROUP BY b, 2",
                    [mn, width, bins - 1] + params).fetchall()
            color_groups = sorted({c for _b, c, _n in rows})[:MAX_COLOR_GROUPS] if color else [""]
            series = []
            for c in color_groups:
                counts = [0] * bins
                for b, cg, n in rows:
                    if cg == c and b is not None and 0 <= b < bins:
                        counts[b] = n
                total = sum(counts) or 1
                series.append({"label": c, "counts": counts,
                               "percents": [round(v * 100 / total, 3) for v in counts]})
            result = {"kind": "histogram", "sub": "numeric",
                      "edges": [mn + width * i for i in range(bins + 1)], "series": series}

    else:  # heatmap (2次元密度)
        need(x, "X", numeric=True)
        need(y, "Y", numeric=True)
        qx, qy = _quote(x), _quote(y)
        with db.duck() as con:
            mnx, mxx, mny, mxy = con.execute(
                f"SELECT min({qx}), max({qx}), min({qy}), max({qy}) FROM {_quote(table)}{where}",
                params).fetchone()
            if mnx is None or mny is None:
                return {"kind": "heatmap", "x_edges": [], "y_edges": [], "matrix": []}
            mnx, mxx, mny, mxy = float(mnx), float(mxx), float(mny), float(mxy)
            if mnx == mxx:
                mxx = mnx + 1
            if mny == mxy:
                mxy = mny + 1
            wx, wy = (mxx - mnx) / bins, (mxy - mny) / bins
            rows = con.execute(
                f"SELECT least(cast(floor(({qx} - ?) / ?) as int), ?), "
                f"least(cast(floor(({qy} - ?) / ?) as int), ?), count(*) "
                f"FROM {_quote(table)}{where or ' WHERE 1=1'} "
                f"AND {qx} IS NOT NULL AND {qy} IS NOT NULL GROUP BY 1, 2",
                [mnx, wx, bins - 1, mny, wy, bins - 1] + params).fetchall()
        matrix = [[0] * bins for _ in range(bins)]
        for bx, by, n in rows:
            if bx is not None and by is not None and 0 <= bx < bins and 0 <= by < bins:
                matrix[by][bx] = n
        result = {"kind": "heatmap",
                  "x_edges": [mnx + wx * i for i in range(bins + 1)],
                  "y_edges": [mny + wy * i for i in range(bins + 1)],
                  "matrix": matrix}

    # Y (無ければ X) の基本統計をチップ表示用に添える
    stats_col = y if (y and y in cols and cols[y]["kind"] == "numeric") else \
        (x if (x and x in cols and cols[x]["kind"] == "numeric") else None)
    if stats_col:
        q = _quote(stats_col)
        with db.duck() as con:
            row = con.execute(
                f"SELECT count({q}), avg({q}), stddev({q}), min({q}), max({q}), "
                f"quantile_cont({q}, 0.5) FROM {_quote(table)}{where}", params).fetchone()
        keys = ["count", "avg", "std", "min", "max", "median"]
        result["stats"] = {"column": stats_col,
                           **{k: _jsonable(v) for k, v in zip(keys, row)}}
    return result


# ---------- タググループ横断の汎用チャート (グラフ作成タブのグループモード) ----------

MAX_CHART_GROUPS = 8


def _group_chart_sources(groups: list[dict[str, Any]], needed: list[str]) -> list[tuple[str, str, dict[str, dict[str, Any]]]]:
    """グループ定義 [{label, dataset_ids}] を (label, FROM句ソース, 列マップ) に展開する。

    必要な列だけを UNION ALL でプールするため、列数の多い J1939 ログでも軽い。
    """
    if not groups:
        raise QueryError("グループを1つ以上指定してください")
    if len(groups) > MAX_CHART_GROUPS:
        raise QueryError(f"グループは最大 {MAX_CHART_GROUPS} 個までです")
    needed = [n for n in dict.fromkeys(needed) if n]
    if not needed:
        raise QueryError("列を選択してください")
    out = []
    for g in groups:
        ids = g.get("dataset_ids") or []
        label = str(g.get("label") or "?")
        if not ids:
            raise QueryError(f"グループ「{label}」にデータセットがありません")
        schemas = [_schema_map(ds_id) for ds_id in ids]
        cols_map: dict[str, dict[str, Any]] = {}
        for n in needed:
            for _, cols in schemas:
                if n not in cols:
                    raise QueryError(f"列「{n}」はグループ「{label}」の全データセットに存在しません")
            cols_map[n] = schemas[0][1][n]
        if len(ids) == 1:
            src = _quote(schemas[0][0])
        else:
            cols_sql = ", ".join(_quote(c) for c in needed)
            src = "(" + " UNION ALL ".join(
                f"SELECT {cols_sql} FROM {_quote(t)}" for t, _ in schemas) + ")"
        out.append((label, src, cols_map))
    return out


def _sorted_category_labels(totals: dict[str, int], limit: int = MAX_BAR_GROUPS) -> list[str]:
    labels = [k for k, _ in sorted(totals.items(), key=lambda x: -x[1])[:limit]]
    try:
        labels.sort(key=lambda v: float(v))
    except (TypeError, ValueError):
        labels.sort()
    return labels


def chart_groups(groups: list[dict[str, Any]], kind: str, x: str | None = None,
                 y: str | None = None, agg: str = "avg", bins: int = 40,
                 filters: list[dict[str, Any]] | None = None,
                 max_points: int | None = None) -> dict[str, Any]:
    """グラフ作成タブのタググループモード。系列 = グループとして各種チャートを集計する。"""
    if kind not in CHART_KINDS:
        raise QueryError(f"未対応のチャート種別です: {kind}")
    bins = max(5, min(int(bins), 200))
    filter_cols = [f.get("column") for f in (filters or [])]

    def need_numeric(cols_map: dict[str, dict[str, Any]], col: str, label: str) -> None:
        if cols_map[col]["kind"] != "numeric":
            raise QueryError(f"{label} には数値列を指定してください: {col}")

    result: dict[str, Any]
    if kind in ("scatter", "line"):
        if not x or not y:
            raise QueryError("X と Y の列を選択してください")
        sources = _group_chart_sources(groups, [x, y] + filter_cols)
        limit = max(200, _clamp_points(max_points) // len(sources))
        series = []
        with db.duck() as con:
            for label, src, cols in sources:
                need_numeric(cols, y, "Y")
                where, params = _build_where(filters, cols)
                total = con.execute(f"SELECT count(*) FROM {src}{where}", params).fetchone()[0]
                stride = max(1, math.ceil(total / limit))
                order = f"ORDER BY {_quote(x)}" if kind == "line" else "ORDER BY 1"
                rows = con.execute(
                    f"SELECT {_quote(x)}, {_quote(y)} FROM ("
                    f"  SELECT {_quote(x)}, {_quote(y)}, row_number() OVER ({order}) AS __rn"
                    f"  FROM {src}{where}"
                    f") WHERE (__rn - 1) % {stride} = 0 ORDER BY __rn", params).fetchall()
                series.append({"label": label, "total_rows": total,
                               "x": [_jsonable(r[0]) for r in rows],
                               "y": [_jsonable(r[1]) for r in rows]})
        result = {"kind": kind, "series": series}

    elif kind == "bar":
        if not x:
            raise QueryError("X の列を選択してください")
        if agg not in AGG_FUNCS:
            raise QueryError(f"未対応の集計です: {agg}")
        needs_y = agg not in ("count", "share")
        if needs_y and not y:
            raise QueryError("Y の列を選択してください")
        sources = _group_chart_sources(groups, [x] + ([y] if needs_y else []) + filter_cols)
        expr = "count(*)" if not needs_y else f"{AGG_FUNCS[agg]}({_quote(y)})"
        per_group: dict[str, dict[str, Any]] = {}
        totals: dict[str, int] = {}
        with db.duck() as con:
            for label, src, cols in sources:
                if needs_y:
                    need_numeric(cols, y, "Y")
                where, params = _build_where(filters, cols)
                rows = con.execute(
                    f"SELECT CAST({_quote(x)} AS VARCHAR), {expr}, count(*) FROM {src}"
                    f"{where or ' WHERE 1=1'} AND {_quote(x)} IS NOT NULL GROUP BY 1",
                    params).fetchall()
                per_group[label] = {g: (v, n) for g, v, n in rows}
                for g, _v, n in rows:
                    totals[g] = totals.get(g, 0) + n
        categories = _sorted_category_labels(totals)
        series = []
        for label, _src, _cols in sources:
            values = [per_group[label].get(c, (None, 0))[0] for c in categories]
            if agg == "share":
                total = sum(n for _v, n in per_group[label].values()) or 1
                values = [round(v * 100 / total, 3) if v is not None else None for v in values]
            series.append({"label": label, "values": [_jsonable(v) for v in values]})
        result = {"kind": "bar", "categories": categories, "series": series, "agg": agg}

    elif kind == "box":
        if not x or not y:
            raise QueryError("X (グループ列) と Y の列を選択してください")
        sources = _group_chart_sources(groups, [x, y] + filter_cols)
        per_group = {}
        totals = {}
        q = _quote(y)
        with db.duck() as con:
            for label, src, cols in sources:
                need_numeric(cols, y, "Y")
                where, params = _build_where(filters, cols)
                rows = con.execute(
                    f"SELECT CAST({_quote(x)} AS VARCHAR), count({q}), avg({q}), min({q}), max({q}), "
                    f"quantile_cont({q}, 0.25), quantile_cont({q}, 0.5), quantile_cont({q}, 0.75) "
                    f"FROM {src}{where or ' WHERE 1=1'} "
                    f"AND {q} IS NOT NULL AND {_quote(x)} IS NOT NULL GROUP BY 1",
                    params).fetchall()
                if len(rows) > 200:
                    raise QueryError(f"グループが多すぎます ({len(rows)})。X には離散的な列を指定してください")
                stats = {}
                for g, cnt, avg, mn, mx, q1, med, q3 in rows:
                    iqr = (q3 - q1) if q1 is not None and q3 is not None else 0
                    stats[g] = {
                        "count": cnt, "avg": _jsonable(avg), "q1": _jsonable(q1),
                        "median": _jsonable(med), "q3": _jsonable(q3),
                        "lowerfence": _jsonable(max(mn, q1 - 1.5 * iqr)) if q1 is not None else None,
                        "upperfence": _jsonable(min(mx, q3 + 1.5 * iqr)) if q3 is not None else None,
                    }
                    totals[g] = totals.get(g, 0) + cnt
                per_group[label] = stats
        categories = _sorted_category_labels(totals)
        series = [{"label": label, "groups": [per_group[label].get(c) for c in categories]}
                  for label, _s, _c in sources]
        result = {"kind": "box", "categories": categories, "series": series}

    elif kind == "histogram":
        if not x:
            raise QueryError("X の列を選択してください")
        sources = _group_chart_sources(groups, [x] + filter_cols)
        q = _quote(x)
        if sources[0][2][x]["kind"] != "numeric":
            per_group = {}
            totals = {}
            with db.duck() as con:
                for label, src, cols in sources:
                    where, params = _build_where(filters, cols)
                    rows = con.execute(
                        f"SELECT CAST({q} AS VARCHAR), count(*) FROM {src}{where} GROUP BY 1",
                        params).fetchall()
                    per_group[label] = dict(rows)
                    for g, n in rows:
                        totals[g] = totals.get(g, 0) + n
            labels = _sorted_category_labels(totals)
            series = []
            for label, _s, _c in sources:
                counts = [per_group[label].get(lbl, 0) for lbl in labels]
                n = sum(per_group[label].values()) or 1
                series.append({"label": label, "counts": counts,
                               "percents": [round(c * 100 / n, 3) for c in counts]})
            result = {"kind": "histogram", "sub": "categorical", "labels": labels, "series": series}
        else:
            with db.duck() as con:
                mns, mxs = [], []
                for _label, src, cols in sources:
                    where, params = _build_where(filters, cols)
                    mn, mx = con.execute(f"SELECT min({q}), max({q}) FROM {src}{where}", params).fetchone()
                    if mn is not None:
                        mns.append(float(mn))
                        mxs.append(float(mx))
                if not mns:
                    return {"kind": "histogram", "sub": "numeric", "edges": [], "series": []}
                mn, mx = min(mns), max(mxs)
                if mn == mx:
                    mx = mn + 1
                width = (mx - mn) / bins
                series = []
                for label, src, cols in sources:
                    where, params = _build_where(filters, cols)
                    rows = con.execute(
                        f"SELECT least(cast(floor(({q} - ?) / ?) as int), ?) AS b, count(*) "
                        f"FROM {src}{where or ' WHERE 1=1'} AND {q} IS NOT NULL GROUP BY b",
                        [mn, width, bins - 1] + params).fetchall()
                    counts = [0] * bins
                    for b, c in rows:
                        if b is not None and 0 <= b < bins:
                            counts[b] = c
                    total = sum(counts) or 1
                    series.append({"label": label, "counts": counts,
                                   "percents": [round(c * 100 / total, 3) for c in counts]})
            result = {"kind": "histogram", "sub": "numeric",
                      "edges": [mn + width * i for i in range(bins + 1)], "series": series}

    else:  # heatmap → グループごとの動作領域を等高線で重ねる
        if not x or not y:
            raise QueryError("X と Y の列を選択してください")
        sources = _group_chart_sources(groups, [x, y] + filter_cols)
        qx, qy = _quote(x), _quote(y)
        with db.duck() as con:
            ranges = []
            for label, src, cols in sources:
                need_numeric(cols, x, "X")
                need_numeric(cols, y, "Y")
                where, params = _build_where(filters, cols)
                row = con.execute(
                    f"SELECT min({qx}), max({qx}), min({qy}), max({qy}) FROM {src}{where}",
                    params).fetchone()
                if row[0] is not None and row[2] is not None:
                    ranges.append(tuple(float(v) for v in row))
            if not ranges:
                return {"kind": "heatmap", "x_edges": [], "y_edges": [], "series": []}
            mnx = min(r[0] for r in ranges)
            mxx = max(r[1] for r in ranges)
            mny = min(r[2] for r in ranges)
            mxy = max(r[3] for r in ranges)
            if mnx == mxx:
                mxx = mnx + 1
            if mny == mxy:
                mxy = mny + 1
            wx, wy = (mxx - mnx) / bins, (mxy - mny) / bins
            series = []
            for label, src, cols in sources:
                where, params = _build_where(filters, cols)
                rows = con.execute(
                    f"SELECT least(cast(floor(({qx} - ?) / ?) as int), ?), "
                    f"least(cast(floor(({qy} - ?) / ?) as int), ?), count(*) "
                    f"FROM {src}{where or ' WHERE 1=1'} "
                    f"AND {qx} IS NOT NULL AND {qy} IS NOT NULL GROUP BY 1, 2",
                    [mnx, wx, bins - 1, mny, wy, bins - 1] + params).fetchall()
                matrix = [[0] * bins for _ in range(bins)]
                for bx, by, n in rows:
                    if bx is not None and by is not None and 0 <= bx < bins and 0 <= by < bins:
                        matrix[by][bx] = n
                # 母数 (行数) が違うグループを公平に重ねるため割合% も返す
                total = sum(sum(r) for r in matrix) or 1
                percents = [[round(v * 100 / total, 5) for v in r] for r in matrix]
                series.append({"label": label, "matrix": matrix, "percents": percents})
        result = {"kind": "heatmap",
                  "x_edges": [mnx + wx * i for i in range(bins + 1)],
                  "y_edges": [mny + wy * i for i in range(bins + 1)],
                  "series": series}

    # グループごとの基本統計 (Y が無ければ X) をチップ表示用に添える
    stats_col = y or x
    try:
        stat_sources = _group_chart_sources(groups, [stats_col] + filter_cols)
        if stat_sources[0][2][stats_col]["kind"] == "numeric":
            q = _quote(stats_col)
            stats = []
            with db.duck() as con:
                for label, src, cols in stat_sources:
                    where, params = _build_where(filters, cols)
                    row = con.execute(
                        f"SELECT count({q}), avg({q}), stddev({q}), min({q}), max({q}), "
                        f"quantile_cont({q}, 0.5) FROM {src}{where}", params).fetchone()
                    keys = ["count", "avg", "std", "min", "max", "median"]
                    stats.append({"label": label, "column": stats_col,
                                  **{k: _jsonable(v) for k, v in zip(keys, row)}})
            result["stats"] = stats
    except QueryError:
        pass
    return result


def _jsonable(v: Any) -> Any:
    if v is None or isinstance(v, (int, float, str, bool)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return v
    return str(v)
