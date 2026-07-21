/* 単一データセット分析タブ間で「いま見ているデータ」を共有する */
import { $, $$, esc, toast } from "./api.js";
import { state } from "./state.js";
import { gotoPage } from "./nav.js";

const SELECTORS = {
  timeseries: "#ts-dataset",
  stats: "#st-dataset",
  cluster: "#cl-dataset",
};

const PAGE_LABELS = {
  timeseries: "時系列",
  stats: "統計",
  cluster: "クラスタリング",
};

for (const [page, selector] of Object.entries(SELECTORS)) {
  $(selector).addEventListener("change", () => activateDataset($(selector).value, page));
}

function activateDataset(datasetId, sourcePage) {
  state.activeDatasetId = datasetId || null;
  if (datasetId) localStorage.setItem("vdas-active-dataset", datasetId);
  else localStorage.removeItem("vdas-active-dataset");

  // 別タブは値だけ同期し、実際に開いたとき nav.js が必要なスキーマを読み込む。
  for (const [page, selector] of Object.entries(SELECTORS)) {
    if (page === sourcePage) continue;
    const select = $(selector);
    if ([...select.options].some((option) => option.value === datasetId)) select.value = datasetId;
  }
  renderAnalysisContexts();
}

function renderAnalysisContexts() {
  const dataset = state.datasets.find((item) => item.id === state.activeDatasetId);
  $$('[data-analysis-context]').forEach((context) => {
    const currentPage = context.dataset.analysisContext;
    const actions = Object.entries(PAGE_LABELS)
      .filter(([page]) => page !== currentPage)
      .map(([page, label]) => `<button class="btn subtle" type="button" data-analysis-target="${page}">${label}で見る</button>`)
      .join("");
    context.innerHTML = dataset
      ? `<span class="analysis-context-label">現在の分析対象</span>
         <strong class="analysis-context-name">${esc(dataset.name)}</strong>
         ${actions}`
      : `<span class="analysis-context-label">分析対象が未選択です</span>
         <span class="analysis-context-name">下のデータセット欄から選択してください</span>`;
  });
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-analysis-target]");
  if (!button) return;
  if (!state.activeDatasetId) return toast("先に分析するデータセットを選択してください", "error");
  gotoPage(button.dataset.analysisTarget);
});

document.addEventListener("datasets-refreshed", () => {
  const remembered = state.activeDatasetId || localStorage.getItem("vdas-active-dataset");
  const validId = state.datasets.some((dataset) => dataset.id === remembered) ? remembered : null;
  if (!validId) localStorage.removeItem("vdas-active-dataset");
  state.activeDatasetId = validId;
  if (validId) {
    for (const selector of Object.values(SELECTORS)) $(selector).value = validId;
  }
  renderAnalysisContexts();
});

renderAnalysisContexts();
