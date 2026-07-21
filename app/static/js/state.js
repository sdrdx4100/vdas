/* アプリ全体で共有する状態 */

export const state = {
  datasets: [],
  activeDatasetId: null,              // 単一データセット分析タブで共有する分析対象
  ts: { schema: null, filters: [] },   // 時系列タブ
  st: { schema: null, filters: [] },   // 統計タブ
  cmp: {
    mode: "cohorts",
    tagFilter: new Set(),
    schemas: {},
    schema: null,
    filters: [],
    last: null,
    cohortSpecs: [
      { name: "グループ1", tags: new Set(), match: "all" },
    ],
    cohortResolution: null,
    cohortResolveToken: 0,
    cohortRunToken: 0,
  },  // 比較タブ
  cl: { schema: null, result: null },          // クラスタリングタブ
  labelsets: [],
  tags: [],
  dsSelection: new Set(),      // データ管理タブの一括操作用チェック
  dataTagFilter: new Set(),    // データ管理タブのタグ絞り込み
};
