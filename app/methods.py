"""タググループ横断の高度な統計解析 (回帰・主成分分析・相関)。

cohorts.resolve_cohorts でタグ条件をデータセット群へ解決し、
必要な列だけを UNION ALL でプールして集計する。生の行データが
必要な PCA は等間隔サンプリングで取得する。
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy import signal as scipy_signal
from sklearn.decomposition import PCA

from . import cohorts, db, queries

MAX_SAMPLE_PER_GROUP = 3000
MAX_PCA_FEATURES = 12
MAX_CORR_COLUMNS = 20
MAX_SPECTRUM_ROWS = 300_000
SPECTRUM_GRID = 256

_trapz = getattr(np, "trapezoid", getattr(np, "trapz", None))


def _group_sources(specs: list[dict[str, Any]], needed: list[str]):
    """(cohort, プールした FROM ソース, 共通列マップ) を返す。"""
    resolution = cohorts.resolve_cohorts(specs)
    needed = [n for n in dict.fromkeys(needed) if n]
    out = []
    for cohort in resolution["cohorts"]:
        ids = cohort["dataset_ids"]
        schemas = [queries._schema_map(ds_id) for ds_id in ids]
        cols_map: dict[str, dict[str, Any]] = {}
        for name in needed:
            for _, cols in schemas:
                if name not in cols:
                    raise queries.QueryError(
                        f"列「{name}」はグループ「{cohort['name']}」の全データセットに存在しません")
            cols_map[name] = schemas[0][1][name]
        if len(ids) == 1:
            src = queries._quote(schemas[0][0])
        else:
            cols_sql = ", ".join(queries._quote(c) for c in needed)
            src = "(" + " UNION ALL ".join(
                f"SELECT {cols_sql} FROM {queries._quote(t)}" for t, _ in schemas) + ")"
        out.append((cohort, src, cols_map))
    return resolution, out


def cohort_regression(
    specs: list[dict[str, Any]],
    x: str,
    y: str,
    filters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """グループごとに Y ~ X の線形回帰を当て、傾き・切片・R² を比較する。

    回帰統計は全行で厳密に計算し (DuckDB regr_*)、散布図表示用の点は
    等間隔サンプリングする。
    """
    if x == y:
        raise queries.QueryError("X と Y には別の列を指定してください")
    resolution, sources = _group_sources(specs, [x, y] + [f.get("column") for f in (filters or [])])
    qx, qy = queries._quote(x), queries._quote(y)

    series = []
    with db.duck() as con:
        for cohort, src, cols in sources:
            if cols[x]["kind"] != "numeric" or cols[y]["kind"] != "numeric":
                raise queries.QueryError("回帰の X / Y には数値列を指定してください")
            where, params = queries._build_where(filters, cols)
            stat_where = f"{where or ' WHERE 1=1'} AND {qx} IS NOT NULL AND {qy} IS NOT NULL"
            row = con.execute(
                f"SELECT regr_slope({qy}, {qx}), regr_intercept({qy}, {qx}), "
                f"regr_r2({qy}, {qx}), regr_count({qy}, {qx}), "
                f"min({qx}), max({qx}) FROM {src}{stat_where}",
                params,
            ).fetchone()
            slope, intercept, r2, count, min_x, max_x = row
            # 表示用の点を等間隔サンプリング
            total = int(count or 0)
            stride = max(1, total // MAX_SAMPLE_PER_GROUP)
            points = con.execute(
                f"SELECT {qx}, {qy} FROM ("
                f"  SELECT {qx}, {qy}, row_number() OVER () AS __rn FROM {src}{stat_where}"
                f") WHERE (__rn - 1) % {stride} = 0",
                params,
            ).fetchall()
            fit = None
            if slope is not None and min_x is not None:
                fit = {
                    "x": [float(min_x), float(max_x)],
                    "y": [float(slope) * float(min_x) + float(intercept),
                          float(slope) * float(max_x) + float(intercept)],
                }
            series.append({
                **cohorts._cohort_summary(cohort),
                "slope": _num(slope),
                "intercept": _num(intercept),
                "r2": _num(r2),
                "n": total,
                "x": [queries._jsonable(p[0]) for p in points],
                "y": [queries._jsonable(p[1]) for p in points],
                "fit": fit,
            })
    return {"x": x, "y": y, "cohorts": series, "overlaps": resolution["overlaps"]}


def cohort_pca(
    specs: list[dict[str, Any]],
    columns: list[str],
    filters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """複数信号を標準化して主成分分析し、PC1-PC2 平面へグループ別に射影する。

    標準化と主成分は全グループ合算のサンプルで一度だけ学習し、同じ空間へ
    各グループを射影する (グループ間の位置関係が比較できる)。
    """
    columns = list(dict.fromkeys(c for c in columns if c))
    if len(columns) < 2:
        raise queries.QueryError("主成分分析には数値信号を2つ以上選んでください")
    if len(columns) > MAX_PCA_FEATURES:
        raise queries.QueryError(f"主成分分析の信号は最大 {MAX_PCA_FEATURES} 個までです")
    resolution, sources = _group_sources(specs, columns + [f.get("column") for f in (filters or [])])

    group_arrays = []
    with db.duck() as con:
        for cohort, src, cols in sources:
            for c in columns:
                if cols[c]["kind"] != "numeric":
                    raise queries.QueryError(f"主成分分析には数値列を指定してください: {c}")
            where, params = queries._build_where(filters, cols)
            select = ", ".join(queries._quote(c) for c in columns)
            notnull = " AND ".join(f"{queries._quote(c)} IS NOT NULL" for c in columns)
            full_where = f"{where or ' WHERE 1=1'} AND {notnull}"
            total = con.execute(f"SELECT count(*) FROM {src}{full_where}", params).fetchone()[0]
            stride = max(1, total // MAX_SAMPLE_PER_GROUP)
            rows = con.execute(
                f"SELECT {select} FROM ("
                f"  SELECT {select}, row_number() OVER () AS __rn FROM {src}{full_where}"
                f") WHERE (__rn - 1) % {stride} = 0",
                params,
            ).fetchall()
            arr = np.asarray(rows, dtype=float) if rows else np.empty((0, len(columns)))
            group_arrays.append((cohort, arr))

    combined = np.vstack([a for _, a in group_arrays if len(a)]) if any(
        len(a) for _, a in group_arrays) else np.empty((0, len(columns)))
    if len(combined) < 3:
        raise queries.QueryError("有効な行が少なすぎて主成分分析できません")
    mean = combined.mean(axis=0)
    std = combined.std(axis=0)
    std[std == 0] = 1.0
    pca = PCA(n_components=2, random_state=0)
    pca.fit((combined - mean) / std)

    series = []
    for cohort, arr in group_arrays:
        if len(arr):
            projected = pca.transform((arr - mean) / std)
            pc1 = projected[:, 0].tolist()
            pc2 = projected[:, 1].tolist()
        else:
            pc1, pc2 = [], []
        series.append({**cohorts._cohort_summary(cohort), "pc1": pc1, "pc2": pc2})

    # 各主成分への信号の寄与 (ローディング)
    loadings = [
        {"column": columns[i],
         "pc1": float(pca.components_[0][i]),
         "pc2": float(pca.components_[1][i])}
        for i in range(len(columns))
    ]
    return {
        "columns": columns,
        "explained_variance": [float(v) for v in pca.explained_variance_ratio_],
        "loadings": loadings,
        "cohorts": series,
        "overlaps": resolution["overlaps"],
    }


def cohort_correlation(
    specs: list[dict[str, Any]],
    columns: list[str] | None = None,
    filters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """グループごとに数値信号間の相関行列を計算する。"""
    resolution = cohorts.resolve_cohorts(specs)
    # 対象列: 指定が無ければ全グループ共通の数値列
    ids = cohorts._unique_dataset_ids(resolution["cohorts"])
    schemas = [queries._schema_map(ds_id) for ds_id in ids]
    common_numeric = [
        name for name, meta in schemas[0][1].items()
        if meta["kind"] == "numeric"
        and all(name in cols and cols[name]["kind"] == "numeric" for _, cols in schemas[1:])
    ]
    targets = [c for c in (columns or common_numeric) if c in common_numeric][:MAX_CORR_COLUMNS]
    if len(targets) < 2:
        raise queries.QueryError("相関には共通の数値列が2つ以上必要です")

    _, sources = _group_sources(specs, targets + [f.get("column") for f in (filters or [])])
    n = len(targets)
    exprs = [
        f"corr({queries._quote(targets[i])}, {queries._quote(targets[j])})"
        for i in range(n) for j in range(i + 1, n)
    ]
    series = []
    with db.duck() as con:
        for cohort, src, cols in sources:
            where, params = queries._build_where(filters, cols)
            values = con.execute(f"SELECT {', '.join(exprs)} FROM {src}{where}", params).fetchone()
            matrix = [[1.0] * n for _ in range(n)]
            k = 0
            for i in range(n):
                for j in range(i + 1, n):
                    matrix[i][j] = matrix[j][i] = _num(values[k])
                    k += 1
            series.append({**cohorts._cohort_summary(cohort), "matrix": matrix})
    return {"columns": targets, "cohorts": series, "overlaps": resolution["overlaps"]}


def cohort_spectrum(
    specs: list[dict[str, Any]],
    signal: str,
    order_by: str,
    filters: list[dict[str, Any]] | None = None,
    band: tuple[float, float] = (4.0, 8.0),
) -> dict[str, Any]:
    """信号の周波数分析 (パワースペクトル密度)。グループ間で振動特性を比較する。

    各ログを時間順に並べ、時間列の間隔からサンプリング周波数を推定して
    Welch 法で PSD を計算。ログごとの PSD を共通周波数軸へ補間して
    グループ平均する。人体が不快に感じる帯域 (既定 4-8Hz) のエネルギーも返す。
    """
    if signal == order_by:
        raise queries.QueryError("信号と時間列には別の列を指定してください")
    resolution, sources = _group_sources(specs, [signal, order_by] + [f.get("column") for f in (filters or [])])
    qs, qo = queries._quote(signal), queries._quote(order_by)

    # スキーマ取得は DuckDB ロックの外で済ませておく (ロック内で再取得すると
    # 同じ非再入ロックを二重取得してデッドロックするため)
    plans = []  # (cohort名, time_expr, [(table, where, params), ...])
    for cohort, _src, cols in sources:
        if cols[signal]["kind"] != "numeric":
            raise queries.QueryError("周波数分析には数値信号を指定してください")
        if cols[order_by]["kind"] not in ("numeric", "temporal"):
            raise queries.QueryError("時間列には数値列または日時列を指定してください")
        time_expr = f"epoch({qo})" if cols[order_by]["kind"] == "temporal" else qo
        members = []
        for ds_id in cohort["dataset_ids"]:
            table, dcols = queries._schema_map(ds_id)
            where, params = queries._build_where(filters, dcols)
            members.append((table, where, params))
        plans.append((cohort["name"], time_expr, members))

    per_dataset_psd: dict[str, list[tuple[np.ndarray, np.ndarray]]] = {}
    nyquists: list[float] = []
    with db.duck() as con:
        for cohort_name, time_expr, members in plans:
            psds = []
            for table, where, params in members:
                rows = con.execute(
                    f"SELECT {time_expr} AS t, {qs} AS v FROM {queries._quote(table)}"
                    f"{where or ' WHERE 1=1'} AND {qs} IS NOT NULL AND {qo} IS NOT NULL "
                    f"ORDER BY {qo} LIMIT {MAX_SPECTRUM_ROWS}",
                    params,
                ).fetchall()
                if len(rows) < 32:
                    continue
                arr = np.asarray(rows, dtype=float)
                t, v = arr[:, 0], arr[:, 1]
                dt = np.median(np.diff(t))
                if not np.isfinite(dt) or dt <= 0:
                    continue
                fs = 1.0 / dt
                nperseg = int(min(len(v), 1024))
                freqs, psd = scipy_signal.welch(v, fs=fs, nperseg=nperseg, detrend="constant")
                psds.append((freqs, psd))
                nyquists.append(fs / 2)
            per_dataset_psd[cohort_name] = psds

    if not nyquists:
        raise queries.QueryError("周波数分析に十分なデータがありません (等間隔サンプリングの時間列が必要です)")

    # 共通周波数グリッド (0 〜 最小ナイキスト) へ補間してグループ平均
    max_freq = float(min(nyquists))
    grid = np.linspace(0.0, max_freq, SPECTRUM_GRID)
    band_lo, band_hi = float(band[0]), float(band[1])
    band_mask = (grid >= band_lo) & (grid <= band_hi)

    series = []
    for cohort in resolution["cohorts"]:
        psds = per_dataset_psd.get(cohort["name"], [])
        if not psds:
            series.append({**cohorts._cohort_summary(cohort), "psd": [], "band_power": None})
            continue
        interpolated = [np.interp(grid, f, p, left=0.0, right=0.0) for f, p in psds]
        mean_psd = np.mean(interpolated, axis=0)
        total = float(_trapz(mean_psd, grid)) if grid.size > 1 else 0.0
        band_power = float(_trapz(mean_psd[band_mask], grid[band_mask])) if band_mask.any() else 0.0
        series.append({
            **cohorts._cohort_summary(cohort),
            "psd": [round(float(v), 8) for v in mean_psd],
            "band_power": round(band_power, 8),
            "band_ratio": round(band_power / total, 5) if total > 0 else None,
        })
    return {
        "signal": signal,
        "freqs": [round(float(f), 4) for f in grid],
        "band": [band_lo, band_hi],
        "cohorts": series,
        "overlaps": resolution["overlaps"],
    }


def _num(v: Any) -> float | None:
    if v is None:
        return None
    v = float(v)
    return None if (np.isnan(v) or np.isinf(v)) else round(v, 6)
