"""タグでまとめたデータセット群（コホート）の比較集計。"""
from __future__ import annotations

from typing import Any

import numpy as np

from . import db, ingest, queries

MAX_2D_BINS = 100
COHORT_METRICS = {"avg", "q50", "q75"}
MAX_MULTI_SIGNALS = 20


def resolve_cohorts(specs: list[dict[str, Any]]) -> dict[str, Any]:
    """タグ条件をデータセットIDへ解決し、グループ間の重複も返す。"""
    if not specs:
        raise queries.QueryError("分析するタグ集合を1つ以上指定してください")

    datasets = ingest.list_datasets()
    names: set[str] = set()
    resolved = []
    membership: dict[str, list[str]] = {}

    for spec in specs:
        name = str(spec.get("name", "")).strip()
        if not name:
            raise queries.QueryError("比較グループ名を指定してください")
        if name in names:
            raise queries.QueryError(f"比較グループ名が重複しています: {name}")
        names.add(name)

        tags = _clean_tags(spec.get("tags"))
        if not tags:
            raise queries.QueryError(f"グループ「{name}」のタグを1つ以上指定してください")
        match = spec.get("match", "all")
        if match not in ("all", "any"):
            raise queries.QueryError("タグ条件 match は all / any を指定してください")

        selected = []
        for dataset in datasets:
            dataset_tags = set(dataset["tags"])
            matches = all(tag in dataset_tags for tag in tags) if match == "all" else any(
                tag in dataset_tags for tag in tags
            )
            if matches:
                selected.append(dataset)
                membership.setdefault(dataset["id"], []).append(name)

        if not selected:
            raise queries.QueryError(f"グループ「{name}」に該当するデータセットがありません")
        resolved.append(
            {
                "name": name,
                "tags": tags,
                "match": match,
                "dataset_ids": [dataset["id"] for dataset in selected],
                "dataset_count": len(selected),
                "row_count": sum(dataset["row_count"] for dataset in selected),
                "datasets": [
                    {
                        "id": dataset["id"],
                        "name": dataset["name"],
                        "tags": dataset["tags"],
                        "row_count": dataset["row_count"],
                    }
                    for dataset in selected
                ],
            }
        )

    overlaps = [
        {"dataset_id": dataset_id, "groups": groups}
        for dataset_id, groups in membership.items()
        if len(groups) > 1
    ]
    return {"cohorts": resolved, "overlaps": overlaps}


def compare_histogram(
    specs: list[dict[str, Any]],
    column: str,
    bins: int = 40,
    filters: list[dict[str, Any]] | None = None,
    as_category: bool = False,
) -> dict[str, Any]:
    """グループごとの共通ビン分布を、プール値とデータセット均等重みで返す。"""
    resolution = resolve_cohorts(specs)
    dataset_ids = _unique_dataset_ids(resolution["cohorts"])
    base = queries.compare_histogram(
        dataset_ids, column, bins, filters, minimum_datasets=1, as_category=as_category
    )
    by_dataset = {series["dataset_id"]: series for series in base["series"]}

    cohort_series = []
    for cohort in resolution["cohorts"]:
        members = [by_dataset[dataset_id] for dataset_id in cohort["dataset_ids"]]
        counts = _sum_vectors([member["counts"] for member in members])
        total = sum(counts)
        cohort_series.append(
            {
                **_cohort_summary(cohort),
                "total_points": total,
                "counts": counts,
                "pooled_percents": _percent_vector(counts, total),
                "mean_dataset_percents": _mean_vectors(
                    [member["percents"] for member in members]
                ),
            }
        )

    result = {
        "kind": base["kind"],
        "column": column,
        "cohorts": cohort_series,
        "overlaps": resolution["overlaps"],
    }
    if base["kind"] == "numeric":
        result["edges"] = base["edges"]
    else:
        result["labels"] = base["labels"]
    return result


def compare_dataset_summary(
    specs: list[dict[str, Any]],
    column: str,
    metric: str = "avg",
    filters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """各データセットの代表値を1標本として、コホート間の差を要約する。"""
    if metric not in COHORT_METRICS:
        raise queries.QueryError("代表値は avg / q50 / q75 を指定してください")

    resolution = resolve_cohorts(specs)
    dataset_ids = _unique_dataset_ids(resolution["cohorts"])
    base = queries.compare_summary(dataset_ids, column, filters, minimum_datasets=1)
    by_dataset = {series["dataset_id"]: series for series in base["series"]}
    dataset_names = {
        dataset["id"]: dataset["name"]
        for cohort in resolution["cohorts"]
        for dataset in cohort["datasets"]
    }

    cohort_series = []
    for cohort in resolution["cohorts"]:
        datasets = []
        values = []
        for dataset_id in cohort["dataset_ids"]:
            summary = by_dataset[dataset_id]
            value = summary.get(metric)
            datasets.append(
                {
                    "dataset_id": dataset_id,
                    "dataset_name": dataset_names[dataset_id],
                    "value": value,
                    "count": summary["count"],
                }
            )
            if value is not None:
                values.append(float(value))
        cohort_series.append(
            {
                **_cohort_summary(cohort),
                "datasets": datasets,
                "values": values,
                "summary": _describe_dataset_values(values),
            }
        )

    comparisons = []
    if len(cohort_series) >= 2:
        baseline = cohort_series[0]
        for candidate in cohort_series[1:]:
            comparison = _compare_dataset_values(baseline["values"], candidate["values"])
            comparison.update(
                {
                    "baseline": baseline["name"],
                    "comparison": candidate["name"],
                }
            )
            comparisons.append(comparison)
    return {
        "column": column,
        "metric": metric,
        "cohorts": cohort_series,
        "comparison": comparisons[0] if comparisons else None,
        "comparisons": comparisons,
        "overlaps": resolution["overlaps"],
    }


def compare_multi_summary(
    specs: list[dict[str, Any]],
    columns: list[str],
    metric: str = "avg",
    filters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """複数信号のデータセット単位要約を、同じタググループ定義でまとめて返す。"""
    unique_columns = list(dict.fromkeys(column.strip() for column in columns if column.strip()))
    if not unique_columns:
        raise queries.QueryError("分析する信号を1つ以上指定してください")
    if len(unique_columns) > MAX_MULTI_SIGNALS:
        raise queries.QueryError(f"複数信号分析は{MAX_MULTI_SIGNALS}信号までです")
    return {
        "metric": metric,
        "columns": unique_columns,
        "results": [
            compare_dataset_summary(specs, column, metric, filters)
            for column in unique_columns
        ],
    }


def compare_histogram2d(
    specs: list[dict[str, Any]],
    x: str,
    y: str,
    bins_x: int = 40,
    bins_y: int = 40,
    filters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """全グループ共通のX/Yビンで2次元密度を比較する。"""
    if x == y:
        raise queries.QueryError("X と Y には別の列を指定してください")
    bins_x = max(5, min(int(bins_x), MAX_2D_BINS))
    bins_y = max(5, min(int(bins_y), MAX_2D_BINS))

    resolution = resolve_cohorts(specs)
    dataset_ids = _unique_dataset_ids(resolution["cohorts"])
    tables = queries._compare_tables(dataset_ids, x, y, minimum=1)
    for _, _, columns in tables:
        if columns[x]["kind"] != "numeric" or columns[y]["kind"] != "numeric":
            raise queries.QueryError("2次元分布の X / Y には数値列を指定してください")

    qx, qy = queries._quote(x), queries._quote(y)
    ranges = _common_ranges(tables, qx, qy, filters)
    if ranges is None:
        return {
            "x": x,
            "y": y,
            "x_edges": [],
            "y_edges": [],
            "cohorts": [],
            "overlaps": resolution["overlaps"],
        }
    min_x, max_x, min_y, max_y = ranges
    if min_x == max_x:
        max_x = min_x + 1
    if min_y == max_y:
        max_y = min_y + 1
    width_x = (max_x - min_x) / bins_x
    width_y = (max_y - min_y) / bins_y

    matrices: dict[str, list[list[int]]] = {}
    for dataset_id, table, columns in tables:
        where, filter_params = queries._build_where(filters, columns)
        sql = (
            f"SELECT least(greatest(cast(floor(({qx} - ?) / ?) as int), 0), ?) AS bin_x, "
            f"least(greatest(cast(floor(({qy} - ?) / ?) as int), 0), ?) AS bin_y, count(*) "
            f"FROM {queries._quote(table)}{where or ' WHERE 1=1'} "
            f"AND {qx} IS NOT NULL AND {qy} IS NOT NULL GROUP BY bin_x, bin_y"
        )
        params = [min_x, width_x, bins_x - 1, min_y, width_y, bins_y - 1, *filter_params]
        with db.duck() as con:
            rows = con.execute(sql, params).fetchall()
        matrix = [[0 for _ in range(bins_x)] for _ in range(bins_y)]
        for bin_x, bin_y, count in rows:
            matrix[bin_y][bin_x] = count
        matrices[dataset_id] = matrix

    cohort_series = []
    for cohort in resolution["cohorts"]:
        member_matrices = [matrices[dataset_id] for dataset_id in cohort["dataset_ids"]]
        counts = _sum_matrices(member_matrices)
        total = sum(sum(row) for row in counts)
        cohort_series.append(
            {
                **_cohort_summary(cohort),
                "total_points": total,
                "counts": counts,
                "pooled_percents": _percent_matrix(counts, total),
                "mean_dataset_percents": _mean_matrices(
                    [
                        _percent_matrix(matrix, sum(sum(row) for row in matrix))
                        for matrix in member_matrices
                    ]
                ),
            }
        )

    return {
        "x": x,
        "y": y,
        "x_edges": [min_x + width_x * index for index in range(bins_x + 1)],
        "y_edges": [min_y + width_y * index for index in range(bins_y + 1)],
        "cohorts": cohort_series,
        "overlaps": resolution["overlaps"],
    }


def compare_transitions(
    specs: list[dict[str, Any]],
    state_column: str,
    order_by: str,
    filters: list[dict[str, Any]] | None = None,
    denominator_column: str | None = None,
    denominator_scale: float = 1.0,
) -> dict[str, Any]:
    """ギア段などの状態変化を遷移イベントとしてグループ間比較する。"""
    if state_column == order_by:
        raise queries.QueryError("状態列と並び順列には別の列を指定してください")
    if denominator_scale <= 0:
        raise queries.QueryError("正規化スケールは0より大きい値を指定してください")

    resolution = resolve_cohorts(specs)
    dataset_ids = _unique_dataset_ids(resolution["cohorts"])
    required = [state_column, order_by]
    if denominator_column:
        required.append(denominator_column)
    tables = queries._compare_tables(dataset_ids, *required, minimum=1)

    per_dataset = {}
    totals: dict[str, int] = {}
    for dataset_id, table, columns in tables:
        if columns[order_by]["kind"] not in ("numeric", "temporal"):
            raise queries.QueryError("並び順には数値列または日時列を指定してください")
        if denominator_column and columns[denominator_column]["kind"] != "numeric":
            raise queries.QueryError("正規化基準には数値列を指定してください")

        where, params = queries._build_where(filters, columns)
        qstate = queries._quote(state_column)
        qorder = queries._quote(order_by)
        source_where = f"{where or ' WHERE 1=1'} AND {qstate} IS NOT NULL AND {qorder} IS NOT NULL"
        sql = (
            "WITH ordered AS ("
            f" SELECT CAST({qstate} AS VARCHAR) AS current_state, "
            f" LAG(CAST({qstate} AS VARCHAR)) OVER (ORDER BY {qorder}, rowid) AS previous_state"
            f" FROM {queries._quote(table)}{source_where}"
            ") SELECT previous_state, current_state, count(*) "
            "FROM ordered WHERE previous_state IS NOT NULL AND previous_state <> current_state "
            "GROUP BY previous_state, current_state"
        )
        with db.duck() as con:
            rows = con.execute(sql, params).fetchall()
            source_rows = con.execute(
                f"SELECT count(*) FROM {queries._quote(table)}{source_where}", params
            ).fetchone()[0]
            denominator = float(source_rows)
            if denominator_column:
                qdenominator = queries._quote(denominator_column)
                minimum, maximum = con.execute(
                    f"SELECT min({qdenominator}), max({qdenominator}) "
                    f"FROM {queries._quote(table)}{source_where}",
                    params,
                ).fetchone()
                denominator = (
                    float(maximum) - float(minimum)
                    if minimum is not None and maximum is not None
                    else 0.0
                )

        counts = {f"{previous}→{current}": count for previous, current, count in rows}
        for label, count in counts.items():
            totals[label] = totals.get(label, 0) + count
        per_dataset[dataset_id] = {
            "counts": counts,
            "source_rows": source_rows,
            "denominator": denominator,
        }

    labels = [label for label, _ in sorted(totals.items(), key=lambda item: (-item[1], item[0]))]
    cohort_series = []
    scale = denominator_scale if denominator_column else 1000.0
    for cohort in resolution["cohorts"]:
        members = [per_dataset[dataset_id] for dataset_id in cohort["dataset_ids"]]
        counts = [sum(member["counts"].get(label, 0) for member in members) for label in labels]
        denominator = sum(member["denominator"] for member in members)
        pooled_rates = [
            round(count * scale / denominator, 6) if denominator > 0 else None for count in counts
        ]
        member_rates = [
            [
                count * scale / member["denominator"] if member["denominator"] > 0 else 0.0
                for count in (member["counts"].get(label, 0) for label in labels)
            ]
            for member in members
        ]
        cohort_series.append(
            {
                **_cohort_summary(cohort),
                "source_rows": sum(member["source_rows"] for member in members),
                "total_events": sum(counts),
                "counts": counts,
                "pooled_rates": pooled_rates,
                "mean_dataset_rates": _mean_vectors(member_rates),
            }
        )

    return {
        "state_column": state_column,
        "order_by": order_by,
        "transitions": labels,
        "rate": {
            "kind": "span" if denominator_column else "rows",
            "denominator_column": denominator_column,
            "scale": scale,
        },
        "cohorts": cohort_series,
        "overlaps": resolution["overlaps"],
    }


def _common_ranges(
    tables: list[tuple[str, str, dict[str, dict[str, Any]]]],
    qx: str,
    qy: str,
    filters: list[dict[str, Any]] | None,
) -> tuple[float, float, float, float] | None:
    ranges = []
    with db.duck() as con:
        for _, table, columns in tables:
            where, params = queries._build_where(filters, columns)
            row = con.execute(
                f"SELECT min({qx}), max({qx}), min({qy}), max({qy}) "
                f"FROM {queries._quote(table)}{where}",
                params,
            ).fetchone()
            if row[0] is not None and row[2] is not None:
                ranges.append(tuple(float(value) for value in row))
    if not ranges:
        return None
    return (
        min(row[0] for row in ranges),
        max(row[1] for row in ranges),
        min(row[2] for row in ranges),
        max(row[3] for row in ranges),
    )


def _clean_tags(tags: Any) -> list[str]:
    cleaned = []
    for tag in tags or []:
        tag = str(tag).strip()
        if tag and tag not in cleaned:
            cleaned.append(tag)
    return cleaned


def _unique_dataset_ids(cohorts: list[dict[str, Any]]) -> list[str]:
    return list(dict.fromkeys(dataset_id for cohort in cohorts for dataset_id in cohort["dataset_ids"]))


def _cohort_summary(cohort: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": cohort["name"],
        "tags": cohort["tags"],
        "match": cohort["match"],
        "dataset_ids": cohort["dataset_ids"],
        "dataset_count": cohort["dataset_count"],
        "row_count": cohort["row_count"],
    }


def _sum_vectors(vectors: list[list[int]]) -> list[int]:
    return [sum(values) for values in zip(*vectors)]


def _mean_vectors(vectors: list[list[float]]) -> list[float]:
    return [round(sum(values) / len(vectors), 6) for values in zip(*vectors)]


def _percent_vector(values: list[int], total: int) -> list[float]:
    return [round(value * 100 / total, 6) if total else 0.0 for value in values]


def _sum_matrices(matrices: list[list[list[int]]]) -> list[list[int]]:
    return [
        [sum(matrix[row][column] for matrix in matrices) for column in range(len(matrices[0][0]))]
        for row in range(len(matrices[0]))
    ]


def _percent_matrix(matrix: list[list[int]], total: int) -> list[list[float]]:
    return [
        [round(value * 100 / total, 6) if total else 0.0 for value in row]
        for row in matrix
    ]


def _mean_matrices(matrices: list[list[list[float]]]) -> list[list[float]]:
    return [
        [
            round(sum(matrix[row][column] for matrix in matrices) / len(matrices), 6)
            for column in range(len(matrices[0][0]))
        ]
        for row in range(len(matrices[0]))
    ]


def _describe_dataset_values(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"n": 0, "mean": None, "std": None, "min": None, "q25": None,
                "median": None, "q75": None, "max": None}
    array = np.asarray(values, dtype=float)
    return {
        "n": len(values),
        "mean": float(np.mean(array)),
        "std": float(np.std(array, ddof=1)) if len(values) >= 2 else None,
        "min": float(np.min(array)),
        "q25": float(np.quantile(array, 0.25)),
        "median": float(np.median(array)),
        "q75": float(np.quantile(array, 0.75)),
        "max": float(np.max(array)),
    }


def _compare_dataset_values(left: list[float], right: list[float]) -> dict[str, Any]:
    if not left or not right:
        return {
            "difference": None, "difference_percent": None, "ci95": None,
            "hedges_g": None, "cliffs_delta": None,
        }
    left_array = np.asarray(left, dtype=float)
    right_array = np.asarray(right, dtype=float)
    left_mean = float(np.mean(left_array))
    right_mean = float(np.mean(right_array))
    difference = right_mean - left_mean

    ci95 = None
    if len(left) >= 2 and len(right) >= 2:
        # データセットを再標本化するため、行数ではなくログ本数の不確実性を表す。
        rng = np.random.default_rng(20260721)
        iterations = 2000
        left_boot = rng.choice(
            left_array, size=(iterations, len(left_array)), replace=True
        ).mean(axis=1)
        right_boot = rng.choice(
            right_array, size=(iterations, len(right_array)), replace=True
        ).mean(axis=1)
        low, high = np.quantile(right_boot - left_boot, [0.025, 0.975])
        ci95 = [float(low), float(high)]

    hedges_g = None
    if len(left) >= 2 and len(right) >= 2:
        degrees = len(left) + len(right) - 2
        pooled_variance = (
            (len(left) - 1) * np.var(left_array, ddof=1)
            + (len(right) - 1) * np.var(right_array, ddof=1)
        ) / degrees
        if pooled_variance > 0:
            correction = 1 - 3 / (4 * degrees - 1) if degrees > 1 else 1
            hedges_g = float(correction * difference / np.sqrt(pooled_variance))

    pair_differences = right_array[:, None] - left_array[None, :]
    cliffs_delta = float(
        (np.count_nonzero(pair_differences > 0) - np.count_nonzero(pair_differences < 0))
        / pair_differences.size
    )
    return {
        "difference": difference,
        "difference_percent": difference * 100 / abs(left_mean) if left_mean else None,
        "ci95": ci95,
        "hedges_g": hedges_g,
        "cliffs_delta": cliffs_delta,
    }
