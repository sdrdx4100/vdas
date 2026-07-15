# タググループ比較 API

タグ条件を比較グループへ解決し、グループ単位で分布を集計する。各グループはタグの全一致 (`all`) またはいずれか一致 (`any`) で指定する。

```json
{
  "cohorts": [
    {"name": "A", "tags": ["A社"], "match": "all"},
    {"name": "B", "tags": ["B社"], "match": "all"}
  ]
}
```

## エンドポイント

- `POST /api/compare/cohorts/resolve`: 対象データセット数、行数、グループ間の重複を確認する。
- `POST /api/compare/cohorts/histogram`: `column` と `bins` を加え、共通ビンの1次元分布を取得する。
- `POST /api/compare/cohorts/histogram2d`: `x`、`y`、`bins_x`、`bins_y` を加え、共通ビンの2次元密度を取得する。
- `POST /api/compare/cohorts/transitions`: `state_column` と `order_by` を加え、`1→2`などの状態遷移頻度を取得する。

分布レスポンスは、グループ内の全行をまとめた `pooled_percents` と、各データセットを均等に扱う `mean_dataset_percents` の両方を返す。データ量の影響を除いてA/Bを比較する画面では、後者を標準表示にする。

## 変速などの遷移頻度

```json
{
  "cohorts": [
    {"name": "A", "tags": ["A社"]},
    {"name": "B", "tags": ["B社"]}
  ],
  "state_column": "gear",
  "order_by": "time",
  "denominator_column": "time",
  "denominator_scale": 3600
}
```

`denominator_column`を省略すると1,000行あたりの遷移頻度になる。秒単位の時間列と`denominator_scale: 3600`を指定すれば1時間あたり、km単位の距離列と`denominator_scale: 100`を指定すれば100kmあたりの頻度になる。

各レスポンスの`overlaps`には複数グループへ同時所属するデータセットを格納する。比較画面では警告として表示する。
