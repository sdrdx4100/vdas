/* 保存ビュー・ラベルセットタブ、および各タブから使うラベルセット共通処理 */
import { $, $$, api, toast, esc } from "./api.js";
import { state } from "./state.js";
import { renderFilters } from "./filters.js";
import { gotoPage } from "./nav.js";
import { loadAnalysisView } from "./analysis.js";
import { setTsSelectedColumns, plotTimeseries } from "./timeseries.js";
import { loadSummary } from "./stats.js";

// ---------- ラベルセット ----------

export async function refreshLabelsets() {
  state.labelsets = await api("/api/labelsets");
  refreshLabelsetSelect();
}

export function refreshLabelsetSelect() {
  // ラベルセットはどのデータセットでも使える (同名信号があれば適用される)
  const sel = $("#ts-labelset");
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 選択 —</option>' +
    state.labelsets
      .map((ls) => `<option value="${ls.id}">${esc(ls.name)} (${ls.columns.length}信号)</option>`)
      .join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ---------- 保存ビュー・ラベルセット一覧ページ ----------

export async function refreshViewsPage() {
  const [views] = await Promise.all([api("/api/views"), refreshLabelsets()]);

  const vBody = $("#views-table tbody");
  vBody.innerHTML = "";
  $("#views-empty").style.display = views.length ? "none" : "";
  const kindLabel = { timeseries: "時系列", stats: "統計", compare: "自由分析", explore: "グラフ作成" };
  for (const v of views) {
    let dsNames;
    if (v.kind === "compare") {
      const tags = v.config.tags ||
        (v.config.cohorts || []).flatMap((cohort) => cohort.tags || []);
      dsNames = (tags || []).join(" / ") || "—";
    } else if (v.kind === "explore" && v.config.source === "groups") {
      dsNames = (v.config.group_tags || []).join(" / ") || "—";
    } else {
      dsNames = [v.dataset_id].map((id) => state.datasets.find((d) => d.id === id)?.name || id)
        .filter(Boolean).join(" / ") || "—";
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(v.name)}</strong></td>
      <td><span class="chip ${v.kind === "timeseries" ? "accent" : ""}">${kindLabel[v.kind] || v.kind}</span></td>
      <td>${esc(dsNames)}</td>
      <td>${esc(v.created_at)}</td>
      <td>
        <button class="btn subtle" data-act="load">読み込む</button>
        <button class="btn subtle danger-text" data-act="delete">削除</button>
      </td>`;
    tr.querySelector('[data-act="load"]').addEventListener("click", () => loadView(v));
    tr.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      if (!confirm(`ビュー「${v.name}」を削除しますか?`)) return;
      await api(`/api/views/${v.id}`, { method: "DELETE" });
      toast("削除しました");
      refreshViewsPage();
    });
    vBody.appendChild(tr);
  }

  const lBody = $("#labelsets-table tbody");
  lBody.innerHTML = "";
  $("#labelsets-empty").style.display = state.labelsets.length ? "none" : "";
  for (const ls of state.labelsets) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(ls.name)}</strong></td>
      <td class="num">${ls.columns.length}</td>
      <td style="max-width:420px; overflow:hidden; text-overflow:ellipsis;">${esc(ls.columns.join(", "))}</td>
      <td>${esc(ls.created_at)}</td>
      <td><button class="btn subtle danger-text">削除</button></td>`;
    tr.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`ラベルセット「${ls.name}」を削除しますか?`)) return;
      await api(`/api/labelsets/${ls.id}`, { method: "DELETE" });
      toast("削除しました");
      refreshViewsPage();
    });
    lBody.appendChild(tr);
  }
}

async function loadView(v) {
  if (v.kind === "explore") {
    const { EX_VISIBILITY, exUpdateControls, plotExplore, setExSource, renderExGroupTags, exRefreshSchema } =
      await import("./explore.js");
    const c = v.config || {};
    if (c.source === "groups") {
      // gotoPage より先にソースを切り替え、データセット側ハンドラの誤発火を防ぐ
      state.ex.groupTags = new Set(c.group_tags || []);
      setExSource("groups");
      gotoPage("explore");
      renderExGroupTags();
      await exRefreshSchema();
    } else {
      setExSource("dataset");
      $("#ex-dataset").value = v.dataset_id || "";
      state.ex.schema = null;
      gotoPage("explore");
      $("#ex-dataset").dispatchEvent(new Event("change"));
      await waitFor(() => state.ex.schema);
    }
    if (c.chart_kind && EX_VISIBILITY[c.chart_kind]) {
      state.ex.kind = c.chart_kind;
      $$("#ex-kind .chart-kind").forEach((b) =>
        b.classList.toggle("active", b.dataset.kind === c.chart_kind));
    }
    state.ex.filters = (c.filters || []).map((f) => ({ ...f }));
    renderFilters("#ex-filters", state.ex);
    exUpdateControls();
    const setIf = (sel, val) => {
      if (val && [...$(sel).options].some((o) => o.value === val)) $(sel).value = val;
    };
    setIf("#ex-x", c.x);
    setIf("#ex-y", c.y);
    setIf("#ex-color", c.color);
    if (c.agg) $("#ex-agg").value = c.agg;
    if (c.bins) $("#ex-bins").value = c.bins;
    if (c.max_points) $("#ex-points").value = c.max_points;
    exUpdateControls();
    plotExplore(true);
    toast(`ビュー「${v.name}」を読み込みました`);
    return;
  }
  const c = v.config || {};
  if (v.kind === "compare") {
    gotoPage("compare");
    await loadAnalysisView(v);
    toast(`ビュー「${v.name}」を読み込みました`);
    return;
  }
  if (v.kind === "timeseries") {
    gotoPage("timeseries");
    $("#ts-dataset").value = v.dataset_id || "";
    state.ts.schema = null; // change ハンドラが新しい schema を入れるまで待つ目印
    $("#ts-dataset").dispatchEvent(new Event("change"));
    await waitFor(() => state.ts.schema);
    if (c.x) $("#ts-x").value = c.x;
    setTsSelectedColumns(c.ys || []);
    state.ts.filters = (c.filters || []).map((f) => ({ ...f }));
    renderFilters("#ts-filters", state.ts);
    if (c.max_points) $("#ts-maxpoints").value = c.max_points;
    if (c.mode) $("#ts-mode").value = c.mode;
    plotTimeseries();
  } else {
    gotoPage("stats");
    $("#st-dataset").value = v.dataset_id || "";
    state.st.schema = null;
    $("#st-dataset").dispatchEvent(new Event("change"));
    await waitFor(() => state.st.schema);
    state.st.filters = (c.filters || []).map((f) => ({ ...f }));
    renderFilters("#st-filters", state.st);
    if (c.hist_col) $("#hist-col").value = c.hist_col;
    if (c.hist_bins) $("#hist-bins").value = c.hist_bins;
    if (c.sc_x) $("#sc-x").value = c.sc_x;
    if (c.sc_y) $("#sc-y").value = c.sc_y;
    if (c.sc_color != null) $("#sc-color").value = c.sc_color;
    loadSummary();
  }
  toast(`ビュー「${v.name}」を読み込みました`);
}

function waitFor(cond, timeout = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function poll() {
      if (cond() || Date.now() - t0 > timeout) return resolve();
      setTimeout(poll, 50);
    })();
  });
}
