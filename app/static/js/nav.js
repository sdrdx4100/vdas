/* ページナビゲーション (左のナビレール) */
import { $, $$ } from "./api.js";
import { state } from "./state.js";
import { refreshViewsPage } from "./views.js";
import { autoSelectCmpDatasets } from "./compare.js";

$$(".nav-item[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".nav-item[data-page]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $$(".page").forEach((p) => p.classList.remove("active"));
    $(`#page-${btn.dataset.page}`).classList.add("active");
    if (btn.dataset.page === "views") refreshViewsPage();
    if (btn.dataset.page === "compare") autoSelectCmpDatasets();
    // 単一データセットのタブ: 未選択なら最初のデータセットを自動選択して即描画。
    // 選択済みでもスキーマ未読込 (別画面で値だけ変えた場合) なら読み込んで描画
    if (["timeseries", "stats", "cluster", "explore"].includes(btn.dataset.page)) {
      const page = btn.dataset.page;
      const sel = { timeseries: "#ts-dataset", stats: "#st-dataset", cluster: "#cl-dataset", explore: "#ex-dataset" }[page];
      const tab = { timeseries: state.ts, stats: state.st, cluster: state.cl, explore: state.ex }[page];
      if (!$(sel).value && state.datasets.length) $(sel).value = state.datasets[0].id;
      if ($(sel).value && tab.schema?.dataset?.id !== $(sel).value) {
        $(sel).dispatchEvent(new Event("change"));
      }
    }
  });
});

export function gotoPage(name) {
  $(`.nav-item[data-page="${name}"]`).click();
}
