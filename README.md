# VDAS — 車両データ可視化ダッシュボード

車両データ (CSV / Parquet) をローカルに永続化し、高速に可視化するダッシュボードプラットフォームです。

- **バックエンド**: FastAPI + DuckDB (分析クエリ) + SQLite (メタデータ)
- **フロントエンド**: Plotly.js + Fluent Design (Microsoft) 基調の UI
- **完全ローカル動作**: 外部 CDN 不要 (plotly.js もローカル配信)

## 機能

| タブ | 内容 |
|---|---|
| データ管理 | CSV / Parquet のドラッグ&ドロップアップロード。原本は `data/uploads/` に保存、DuckDB テーブルとして取り込み。**タグ付け** (A社 / B社 / J1939 など): アップロード時の自動付与、チップ式エディタ (既存タグをクリックで追加・入力補完)、複数データセットへの一括追加/削除、タグ絞り込み。プレビュー・削除。 |
| 時系列可視化 | X軸(時間軸) + 複数信号。**信号ごとに個別軸で積み重ねるストリップ表示** (計測ツール風、時間軸は共有でズーム連動) と1軸重ね書きを切替可能。フィルタ条件、自動間引き (最大表示点数指定)、信号名検索。 |
| 全体統計可視化 | 基本統計量 (SUMMARIZE)、ヒストグラム、散布図 (カテゴリ色分け)、相関行列ヒートマップ。 |
| グラフ作成 | **万能チャートビルダー**。グラフ種類 (散布図 / 折れ線 / 棒 / 箱ひげ / ヒストグラム / 密度マップ) を Excel のように選び、X・Y・**色分け** (ギア段・モードなど)・集計 (平均/合計/件数/**割合%**…)・フィルタ条件を自由に組み合わせ。対象は**データセット単体**と**タググループ比較** (タグごとにプールした集合が系列になり、箱ひげ・割合%・分布・動作領域等高線などをグループ間で比較) を切替可能。グループ別統計チップを常時表示。すべて自動更新。 |
| 自由分析 | 個別ファイルではなく、タグで1つ以上のデータ集合を定義。1グループなら単体集計、2グループ以上ならログ単位の集合統計、共通ビンの1D分布、2D動作領域、状態遷移頻度を同じ指標で比較可能。**構成比比較 (割合%)**: ギア段・モードなどの使用割合を各集合内 100% に正規化して比較でき、N数 (走行量) や走り方が違う車両同士でも公平に比較可能。 |
| クラスタリング | 選択した信号を K-means で自動クラスタリング (走行状態の自動ラベリング)。結果はデータセットに列として書き戻され、フィルタ・色分け・分布比較にそのまま使える。クラスタプロファイル・色分け散布図・色分け時系列を表示。 |
| 保存ビュー | 可視化状態 (選択列・フィルタ条件・チャート設定) を名前を付けて保存・復元。**ラベルセット** (見たい信号のセット) も保存可能。 |

**操作は「選ぶだけ」**: データセットや信号・条件を変えると、チャートは自動で再描画されます (ボタン押し不要)。データセット選択時は時間軸・代表信号が自動選択され、データ一覧の「📈 時系列」「📊 統計」ボタンから1クリックで可視化に飛べます。自由分析はタググループを追加し、条件を選ぶと集計・比較が始まります。

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
python run.py --lan              # LAN内の別端末から http://<このPCのIP>:8710
python run.py --port 8000        # ポート変更
python run.py --reload           # 開発用オートリロード
```

`--lan` は `0.0.0.0` で待ち受け、起動時にアクセス先のIPアドレス候補を表示します。Windowsで初回にファイアウォールの確認が出た場合は、信頼できるプライベートネットワークに限って許可してください。

> **注意:** 現在は認証機能がありません。LANから接続できる利用者は、データの閲覧・アップロード・削除を行えます。信頼できないネットワークやインターネットへ直接公開しないでください。

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
- `POST /api/datasets/tags/bulk` — 複数データセットへのタグ一括追加/削除
- `POST /api/datasets/{id}/timeseries` — 時系列データ取得 (フィルタ・間引き対応)
- `GET  /api/datasets/{id}/summary` — 全列の基本統計量
- `POST /api/datasets/{id}/histogram` / `correlation` / `scatter`
- `POST /api/compare/histogram` — 複数データセットを共通ビンで分布比較
- `POST /api/compare/groupstats` — グループ列 (ギア段など) で層別した統計量比較
- `POST /api/compare/diff` — 共通信号の自動スキャン (KS 統計量 + 平均Δ% ランキング)
- `POST /api/compare/cdf` — 累積分布 (1% 刻みパーセンタイル) 比較
- `POST /api/compare/curve` — 特性カーブ比較 (X ビン × Y 平均 + P10-P90 帯)
- `POST /api/compare/summary` — 選択信号の統計量比較 (フィルタ適用可)
- `POST /api/compare/cohorts/resolve` — タグ条件から比較グループを解決
- `POST /api/datasets/{id}/chart` — 汎用チャート集計 (scatter / line / bar / box / histogram / heatmap、色分け・割合%集計・フィルタ対応)
- `POST /api/chart/groups` — タググループ横断の汎用チャート集計 (系列=グループ、プールは UNION ALL)
- `POST /api/compare/histogram` — `as_category` で構成比 (割合%) 比較
- `POST /api/compare/cohorts/histogram` — タググループ別の1次元分布比較 (`as_category` 対応)
- `POST /api/compare/cohorts/histogram2d` — タググループ別の2次元密度比較
- `POST /api/compare/cohorts/transitions` — タググループ別の状態遷移頻度比較
- `POST /api/datasets/{id}/cluster` — K-means クラスタリング (結果列の書き戻し)
- `GET/POST/DELETE /api/views` — 保存ビュー (時系列 / 統計 / 比較)
- `GET/POST/DELETE /api/labelsets` — ラベルセット

## 開発・テスト

開発用依存関係をインストールします。

```bash
pip install -r requirements-dev.txt
```

テストと静的チェックは次のコマンドで実行できます。テスト用DBは一時ディレクトリに作成され、通常の `data/` は変更しません。

```bash
pytest --cov=app --cov-report=term-missing
ruff check app scripts tests run.py
```

GitHub Actionsでは Python 3.12 / 3.13 の両方で静的チェックとテストを実行し、バックエンドのカバレッジ75%以上を必須としています。
