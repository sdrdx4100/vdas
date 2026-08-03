/* ページナビゲーション (左のナビレール) */
import { $, $$, toast } from "./api.js";
import { state } from "./state.js";
import { refreshViewsPage } from "./views.js";
import { onAnalysisPageEnter } from "./analysis.js";
import { onTscomparePageEnter } from "./tscompare.js";
import { ensurePlotly } from "./plotly-loader.js";

const PLOTLY_PAGES = new Set([
  "timeseries", "stats", "explore", "compare", "tscompare", "cluster",
]);
let navigationId = 0;

$$(".nav-item[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => activatePage(btn));
});

async function activatePage(btn) {
  const pageName = btn.dataset.page;
  const currentNavigation = ++navigationId;
  $$(".nav-item[data-page]").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  $$(".page").forEach((p) => p.classList.remove("active"));
  const page = $(`#page-${pageName}`);
  page.classList.add("active");

  if (PLOTLY_PAGES.has(pageName)) {
    page.setAttribute("aria-busy", "true");
    try {
      await ensurePlotly();
    } catch (error) {
      if (currentNavigation === navigationId) {
        toast(`${error.message}。タブを開き直すと再試行します`, "error");
      }
      return;
    } finally {
      page.setAttribute("aria-busy", "false");
    }
  }
  if (currentNavigation !== navigationId) return;

  if (pageName === "views") refreshViewsPage();
  if (pageName === "compare") onAnalysisPageEnter();
  if (pageName === "map") {
    try {
      const { onMapPageEnter } = await import("./map.js");
      if (currentNavigation === navigationId) await onMapPageEnter();
    } catch (error) {
      if (currentNavigation === navigationId) {
        toast(`GPS・地図画面の読み込みに失敗しました: ${error.message}`, "error");
      }
      return;
    }
  }
  if (pageName === "tscompare") onTscomparePageEnter();
  // 単一データセットのタブ: 未選択なら最初のデータセットを自動選択して即描画。
  // 選択済みでもスキーマ未読込 (別画面で値だけ変えた場合) なら読み込んで描画
  if (["timeseries", "stats", "cluster", "explore"].includes(pageName)) {
    const selectors = {
      timeseries: "#ts-dataset",
      stats: "#st-dataset",
      cluster: "#cl-dataset",
      explore: "#ex-dataset",
    };
    const tabs = {
      timeseries: state.ts,
      stats: state.st,
      cluster: state.cl,
      explore: state.ex,
    };
    const sel = selectors[pageName];
    const tab = tabs[pageName];
    if (!$(sel).value && state.datasets.length) $(sel).value = state.datasets[0].id;
    if ($(sel).value && tab.schema?.dataset?.id !== $(sel).value) {
      $(sel).dispatchEvent(new Event("change"));
    }
  }
}

export function gotoPage(name) {
  return activatePage($(`.nav-item[data-page="${name}"]`));
}
