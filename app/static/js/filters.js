/* スキーマ取得・列選択・フィルタ条件UI (時系列/統計/比較タブ共通) */
import { $, api, esc } from "./api.js";

export async function loadSchema(datasetId) {
  return datasetId ? api(`/api/datasets/${datasetId}/schema`) : null;
}

export function columnOptions(schema, { numericOnly = false, blank = false } = {}) {
  let cols = schema ? schema.columns : [];
  if (numericOnly) cols = cols.filter((c) => c.kind === "numeric");
  return (blank ? '<option value="">なし</option>' : "") +
    cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
}

export const FILTER_OPS = [
  ["eq", "="], ["ne", "≠"], ["gt", ">"], ["ge", "≥"], ["lt", "<"], ["le", "≤"],
  ["contains", "を含む"], ["notnull", "が非NULL"], ["isnull", "がNULL"],
];

export function renderFilters(containerId, tabState) {
  const wrap = $(containerId);
  wrap.innerHTML = "";
  tabState.filters.forEach((f, idx) => {
    const row = document.createElement("div");
    row.className = "filter-row";
    row.innerHTML = `
      <select data-k="column" style="min-width:150px;">${columnOptions(tabState.schema)}</select>
      <select data-k="op">${FILTER_OPS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
      <input type="text" data-k="value" placeholder="値" style="width:130px;">
      <button class="btn subtle danger-text" title="削除">✕</button>`;
    row.querySelector('[data-k="column"]').value = f.column || "";
    row.querySelector('[data-k="op"]').value = f.op || "eq";
    row.querySelector('[data-k="value"]').value = f.value ?? "";
    row.querySelectorAll("[data-k]").forEach((el) =>
      el.addEventListener("change", () => {
        f[el.dataset.k] = el.value;
        tabState.onChange?.();  // 条件変更で自動再描画
      }));
    row.querySelector("button").addEventListener("click", () => {
      tabState.filters.splice(idx, 1);
      renderFilters(containerId, tabState);
      tabState.onChange?.();
    });
    wrap.appendChild(row);
  });
}

export function activeFilters(tabState) {
  return tabState.filters
    .filter((f) => f.column && f.op)
    .map((f) => ({ column: f.column, op: f.op, value: f.value ?? null }));
}
