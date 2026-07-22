/* アプリ全体で共有する状態 */

export const state = {
  datasets: [],
  activeDatasetId: null,              // 単一データセット分析タブで共有する分析対象
  ts: { schema: null, filters: [] },   // 時系列タブ
  st: { schema: null, filters: [] },   // 統計タブ
  an: {
    tags: new Set(),           // 選択中のタググループ (タグ1つ = 1グループ)
    kind: "summary",
    filters: [],
    schemas: {},
    schema: null,
  },  // 自由分析タブ
  cl: { schema: null, result: null },          // クラスタリングタブ
  ex: { schema: null, filters: [], kind: "scatter" },  // グラフ作成タブ
  labelsets: [],
  tags: [],
  dsSelection: new Set(),      // データ管理タブの一括操作用チェック
  dataTagFilter: new Set(),    // データ管理タブのタグ絞り込み
};
