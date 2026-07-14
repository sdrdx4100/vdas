# VDAS — 車両データ可視化ダッシュボード

車両データ (CSV / Parquet) をローカルに永続化し、高速に可視化するダッシュボードプラットフォームです。

- **バックエンド**: FastAPI + DuckDB (分析クエリ) + SQLite (メタデータ)
- **フロントエンド**: Plotly.js + Fluent Design (Microsoft) 基調の UI
- **完全ローカル動作**: 外部 CDN 不要 (plotly.js もローカル配信)

## 機能

| タブ | 内容 |
|---|---|
| データ管理 | CSV / Parquet のドラッグ&ドロップアップロード。原本は `data/uploads/` に保存、DuckDB テーブルとして取り込み。**タグ付け** (A社 / B社 / J1939 など)・プレビュー・削除。 |
| 時系列可視化 | X軸(時間軸) + 複数信号の重ね描き。フィルタ条件、自動間引き (最大表示点数指定)、信号名検索。 |
| 全体統計可視化 | 基本統計量 (SUMMARIZE)、ヒストグラム、散布図 (カテゴリ色分け)、相関行列ヒートマップ。 |
| 比較可視化 | タグで絞り込んだ複数データセットを**統計で**比較する彼我比較スイート (記録時刻・走行内容が違っても公平に比較可能)。**比較条件フィルタ** (全データセットに同条件を適用)、**彼我差分サマリ** (共通信号を自動スキャンし KS 統計量で差の大きい順にランキング、基準データセットとの平均Δ%付き)、全体分布比較 (割合%)、**累積分布 (CDF) 比較**、グループ別比較 (箱ひげ図)、**特性カーブ比較** (X ビン × Y 平均 + P10-P90 帯)、統計量の並列比較。 |
| クラスタリング | 選択した信号を K-means で自動クラスタリング (走行状態の自動ラベリング)。結果はデータセットに列として書き戻され、フィルタ・色分け・分布比較にそのまま使える。クラスタプロファイル・色分け散布図・色分け時系列を表示。 |
| 保存ビュー | 可視化状態 (選択列・フィルタ条件・チャート設定) を名前を付けて保存・復元。**ラベルセット** (見たい信号のセット) も保存可能。 |

ライト / ダークテーマ切替に対応しています。

## セットアップ

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 起動

```bash
python run.py                    # http://127.0.0.1:8710
python run.py --port 8000        # ポート変更
python run.py --reload           # 開発用オートリロード
```

## サンプルデータ

動作確認用の走行データ CSV を生成できます:

```bash
python scripts/generate_sample_data.py sample_drive.csv 60000
```

生成した CSV を「データ管理」タブからアップロードしてください。

## データの保存先

すべて `data/` ディレクトリ配下に永続化されます (環境変数 `VDAS_DATA_DIR` で変更可能):

```
data/
  uploads/       # アップロードされた原本ファイル
  vdas.duckdb    # 取り込み済みデータ (高速クエリ用)
  meta.sqlite    # データセット台帳・保存ビュー・ラベルセット
```

## API

`http://127.0.0.1:8710/docs` で OpenAPI (Swagger) ドキュメントを確認できます。
主要エンドポイント:

- `POST /api/datasets/upload` — ファイル取り込み
- `PUT  /api/datasets/{id}/tags` — タグ更新 / `GET /api/tags` — 全タグ一覧
- `POST /api/datasets/{id}/timeseries` — 時系列データ取得 (フィルタ・間引き対応)
- `GET  /api/datasets/{id}/summary` — 全列の基本統計量
- `POST /api/datasets/{id}/histogram` / `correlation` / `scatter`
- `POST /api/compare/histogram` — 複数データセットを共通ビンで分布比較
- `POST /api/compare/groupstats` — グループ列 (ギア段など) で層別した統計量比較
- `POST /api/compare/diff` — 共通信号の自動スキャン (KS 統計量 + 平均Δ% ランキング)
- `POST /api/compare/cdf` — 累積分布 (1% 刻みパーセンタイル) 比較
- `POST /api/compare/curve` — 特性カーブ比較 (X ビン × Y 平均 + P10-P90 帯)
- `POST /api/compare/summary` — 選択信号の統計量比較 (フィルタ適用可)
- `POST /api/datasets/{id}/cluster` — K-means クラスタリング (結果列の書き戻し)
- `GET/POST/DELETE /api/views` — 保存ビュー (時系列 / 統計 / 比較)
- `GET/POST/DELETE /api/labelsets` — ラベルセット
