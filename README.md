# VDAS — 車両データ可視化ダッシュボード

車両データ (CSV / Parquet) をローカルに永続化し、高速に可視化するダッシュボードプラットフォームです。

- **バックエンド**: FastAPI + DuckDB (分析クエリ) + SQLite (メタデータ)
- **フロントエンド**: Plotly.js + Fluent Design (Microsoft) 基調の UI
- **完全ローカル動作**: 外部 CDN 不要 (plotly.js もローカル配信)

## 機能

| タブ | 内容 |
|---|---|
| データ管理 | CSV / Parquet のドラッグ&ドロップアップロード。原本は `data/uploads/` に保存、DuckDB テーブルとして取り込み。プレビュー・削除。 |
| 時系列可視化 | X軸(時間軸) + 複数信号の重ね描き。フィルタ条件、自動間引き (最大表示点数指定)、信号名検索。 |
| 全体統計可視化 | 基本統計量 (SUMMARIZE)、ヒストグラム、散布図 (カテゴリ色分け)、相関行列ヒートマップ。 |
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
- `POST /api/datasets/{id}/timeseries` — 時系列データ取得 (フィルタ・間引き対応)
- `GET  /api/datasets/{id}/summary` — 全列の基本統計量
- `POST /api/datasets/{id}/histogram` / `correlation` / `scatter`
- `GET/POST/DELETE /api/views` — 保存ビュー
- `GET/POST/DELETE /api/labelsets` — ラベルセット
