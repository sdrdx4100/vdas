"""可視化用の分析クエリ。

列名はスキーマ照合でホワイトリスト検証し、値はすべて
プレースホルダでバインドする (SQL インジェクション対策)。
"""
from __future__ import annotations

import math
from typing import Any

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


def _jsonable(v: Any) -> Any:
    if v is None or isinstance(v, (int, float, str, bool)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return v
    return str(v)
