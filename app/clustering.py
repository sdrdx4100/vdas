"""K-means による走行状態の自動クラスタリング。

選択した数値信号を標準化して K-means にかけ、結果のクラスタ番号を
データセットのテーブルに列として書き戻す。書き戻した列は通常の
カテゴリ列として扱えるため、フィルタ・散布図の色分け・分布比較に
そのまま利用できる。
"""
from __future__ import annotations

import re
from typing import Any

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans

from . import db
from .ingest import dataset_schema, get_dataset
from .queries import QueryError, _quote

MAX_FIT_SAMPLE = 100_000


def run_clustering(dataset_id: str, features: list[str], k: int = 4,
                   column_name: str = "cluster") -> dict[str, Any]:
    schema = dataset_schema(dataset_id)
    table = schema["dataset"]["table_name"]
    cols = {c["name"]: c for c in schema["columns"]}

    if not features:
        raise QueryError("クラスタリングに使う信号を1つ以上選択してください")
    for f in features:
        if f not in cols:
            raise QueryError(f"列が存在しません: {f}")
        if cols[f]["kind"] != "numeric":
            raise QueryError(f"数値列のみ使用できます: {f}")
    k = int(k)
    if not 2 <= k <= 20:
        raise QueryError("クラスタ数 k は 2〜20 の範囲で指定してください")
    column_name = column_name.strip() or "cluster"
    if not re.fullmatch(r"[\w぀-ヿ㐀-鿿][\w぀-ヿ㐀-鿿 ()-]{0,63}", column_name):
        raise QueryError("結果列名に使えない文字が含まれています")

    feat_sql = ", ".join(_quote(f) for f in features)
    with db.duck() as con:
        rel = con.execute(f"SELECT rowid AS __rid, {feat_sql} FROM {_quote(table)}")
        data = rel.fetchnumpy()

    rids = np.asarray(data["__rid"], dtype=np.int64)
    X = np.column_stack([
        np.asarray(data[f], dtype=np.float64) for f in features
    ])
    complete = ~np.isnan(X).any(axis=1)
    n_complete = int(complete.sum())
    if n_complete < k:
        raise QueryError(f"欠損のない行が {n_complete} 行しかなく、k={k} のクラスタリングができません")

    Xc = X[complete]
    mean = Xc.mean(axis=0)
    std = Xc.std(axis=0)
    std[std == 0] = 1.0
    Xs = (Xc - mean) / std

    # 学習は最大 MAX_FIT_SAMPLE 行の等間隔サンプルで行い、割り当ては全行に適用する
    stride = max(1, -(-len(Xs) // MAX_FIT_SAMPLE))
    km = KMeans(n_clusters=k, n_init=4, random_state=42)
    km.fit(Xs[::stride])
    labels = km.predict(Xs)

    # クラスタ番号を「大きいクラスタほど 0」になるよう振り直す (見た目の安定用)
    order = np.argsort(-np.bincount(labels, minlength=k))
    remap = np.empty(k, dtype=np.int64)
    remap[order] = np.arange(k)
    labels = remap[labels]

    # --- 結果列をテーブルに書き戻す ---
    label_df = pd.DataFrame({"__rid": rids[complete], "__label": labels})
    tmp_table = f"{table}__tmp"
    exclude = ["__rid"]
    if column_name in cols:
        exclude.append(column_name)  # 同名列は上書き
    exclude_sql = ", ".join(_quote(c) for c in exclude)
    with db.duck() as con:
        con.register("__cluster_labels", label_df)
        con.execute(f'DROP TABLE IF EXISTS "{tmp_table}"')
        con.execute(
            f'CREATE TABLE "{tmp_table}" AS '
            f"SELECT t.* EXCLUDE ({exclude_sql}), l.__label AS {_quote(column_name)} "
            f"FROM (SELECT *, rowid AS __rid FROM {_quote(table)}) t "
            f"LEFT JOIN __cluster_labels l ON t.__rid = l.__rid"
        )
        con.unregister("__cluster_labels")
        con.execute(f"DROP TABLE {_quote(table)}")
        con.execute(f'ALTER TABLE "{tmp_table}" RENAME TO {_quote(table)}')
        new_col_count = len(con.execute(f"DESCRIBE {_quote(table)}").fetchall())

    db.meta_execute("UPDATE datasets SET column_count = ? WHERE id = ?",
                    (new_col_count, dataset_id))

    # --- クラスタごとのプロファイル (元の単位での平均) ---
    sizes = np.bincount(labels, minlength=k)
    centers = []
    for c in range(k):
        mask = labels == c
        center = {"cluster": int(c),
                  "count": int(sizes[c]),
                  "percent": round(float(sizes[c]) * 100 / len(labels), 2)}
        for j, f in enumerate(features):
            center[f] = round(float(Xc[mask, j].mean()), 4) if sizes[c] else None
        centers.append(center)

    return {
        "dataset": get_dataset(dataset_id),
        "column_name": column_name,
        "k": k,
        "features": features,
        "total_rows": int(len(X)),
        "clustered_rows": n_complete,
        "fit_sample_rows": int(len(Xs[::stride])),
        "centers": centers,
    }
