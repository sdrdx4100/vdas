/* VDAS フロントエンド */
"use strict";

// ---------- ユーティリティ ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* noop */ }
    throw new Error(detail);
  }
  return res.json();
}

function toast(msg, kind = "ok") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = ""; }, 3500);
}

function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString("ja-JP") : n;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

// ---------- チャートテーマ (Fluent + 検証済みパレット) ----------

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function seriesColors() {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--series-${i}`));
}

function baseLayout(extra = {}) {
  return Object.assign({
    font: { family: '"Segoe UI", system-ui, sans-serif', size: 12, color: cssVar("--text-primary") },
    paper_bgcolor: cssVar("--chart-surface"),
    plot_bgcolor: cssVar("--chart-surface"),
    colorway: seriesColors(),
    margin: { l: 56, r: 20, t: 30, b: 44 },
    xaxis: { gridcolor: cssVar("--chart-grid"), zerolinecolor: cssVar("--chart-axis"), linecolor: cssVar("--chart-axis") },
    yaxis: { gridcolor: cssVar("--chart-grid"), zerolinecolor: cssVar("--chart-axis"), linecolor: cssVar("--chart-axis") },
    hovermode: "closest",
    legend: { orientation: "h", y: 1.08, bgcolor: "transparent" },
  }, extra);
}

const PLOT_CONFIG = { responsive: true, displaylogo: false, locale: "ja" };

// テーマ切替時に再描画するため、直近の描画関数を覚えておく
const chartRegistry = new Map();
function renderChart(elId, fn) {
  chartRegistry.set(elId, fn);
  fn();
}

// ---------- 状態 ----------

const state = {
  datasets: [],
  ts: { schema: null, filters: [] },   // 時系列タブ
  st: { schema: null, filters: [] },   // 統計タブ
  labelsets: [],
};

// ---------- ナビゲーション ----------

$$(".nav-item[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".nav-item[data-page]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $$(".page").forEach((p) => p.classList.remove("active"));
    $(`#page-${btn.dataset.page}`).classList.add("active");
    if (btn.dataset.page === "views") refreshViewsPage();
  });
});

function gotoPage(name) {
  $(`.nav-item[data-page="${name}"]`).click();
}

// ---------- テーマ ----------

$("#theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  localStorage.setItem("vdas-theme", next);
  for (const fn of chartRegistry.values()) fn();
});

const savedTheme = localStorage.getItem("vdas-theme");
document.documentElement.dataset.theme =
  savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

// ---------- データセット一覧 ----------

async function refreshDatasets() {
  state.datasets = await api("/api/datasets");
  const tbody = $("#dataset-table tbody");
  tbody.innerHTML = "";
  $("#dataset-empty").style.display = state.datasets.length ? "none" : "";
  for (const ds of state.datasets) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(ds.name)}</strong></td>
      <td>${esc(ds.original_filename)}</td>
      <td class="num">${fmtNum(ds.row_count)}</td>
      <td class="num">${fmtNum(ds.column_count)}</td>
      <td class="num">${fmtSize(ds.file_size)}</td>
      <td>${esc(ds.created_at)}</td>
      <td>
        <button class="btn subtle" data-act="preview">プレビュー</button>
        <button class="btn subtle danger-text" data-act="delete">削除</button>
      </td>`;
    tr.querySelector('[data-act="preview"]').addEventListener("click", () => showPreview(ds));
    tr.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      if (!confirm(`「${ds.name}」を削除しますか? (取り込んだテーブルと原本ファイルも削除されます)`)) return;
      await api(`/api/datasets/${ds.id}`, { method: "DELETE" });
      toast("削除しました");
      refreshDatasets();
    });
    tbody.appendChild(tr);
  }
  fillDatasetSelect($("#ts-dataset"));
  fillDatasetSelect($("#st-dataset"));
}

function fillDatasetSelect(sel) {
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 選択 —</option>' +
    state.datasets.map((d) => `<option value="${d.id}">${esc(d.name)} (${fmtNum(d.row_count)}行)</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function showPreview(ds) {
  const data = await api(`/api/datasets/${ds.id}/preview?limit=100`);
  $("#preview-card").style.display = "";
  $("#preview-title").textContent = `プレビュー: ${ds.name} (先頭100行)`;
  $("#preview-table thead").innerHTML =
    `<tr>${data.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  $("#preview-table tbody").innerHTML = data.rows
    .map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`)
    .join("");
  $("#preview-card").scrollIntoView({ behavior: "smooth" });
}

// ---------- アップロード ----------

const dropzone = $("#dropzone");
const fileInput = $("#file-input");
dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => uploadFiles([...fileInput.files]));
["dragover", "dragenter"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
dropzone.addEventListener("drop", (e) => uploadFiles([...e.dataTransfer.files]));

async function uploadFiles(files) {
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    try {
      toast(`アップロード中: ${file.name} …`);
      const ds = await api("/api/datasets/upload", { method: "POST", body: fd });
      toast(`取り込み完了: ${ds.name} (${fmtNum(ds.row_count)}行)`);
    } catch (e) {
      toast(`エラー: ${e.message}`, "error");
    }
  }
  fileInput.value = "";
  refreshDatasets();
}

// ---------- スキーマ・フィルタ UI (共通) ----------

async function loadSchema(datasetId) {
  return datasetId ? api(`/api/datasets/${datasetId}/schema`) : null;
}

function columnOptions(schema, { numericOnly = false, blank = false } = {}) {
  let cols = schema ? schema.columns : [];
  if (numericOnly) cols = cols.filter((c) => c.kind === "numeric");
  return (blank ? '<option value="">なし</option>' : "") +
    cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
}

const FILTER_OPS = [
  ["eq", "="], ["ne", "≠"], ["gt", ">"], ["ge", "≥"], ["lt", "<"], ["le", "≤"],
  ["contains", "を含む"], ["notnull", "が非NULL"], ["isnull", "がNULL"],
];

function renderFilters(containerId, tabState) {
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
      el.addEventListener("change", () => { f[el.dataset.k] = el.value; }));
    row.querySelector("button").addEventListener("click", () => {
      tabState.filters.splice(idx, 1);
      renderFilters(containerId, tabState);
    });
    wrap.appendChild(row);
  });
}

function activeFilters(tabState) {
  return tabState.filters
    .filter((f) => f.column && f.op)
    .map((f) => ({ column: f.column, op: f.op, value: f.value ?? null }));
}

// ---------- 時系列タブ ----------

$("#ts-dataset").addEventListener("change", async () => {
  state.ts.schema = await loadSchema($("#ts-dataset").value);
  state.ts.filters = [];
  renderFilters("#ts-filters", state.ts);
  renderTsColumns();
  const xSel = $("#ts-x");
  xSel.innerHTML = columnOptions(state.ts.schema);
  if (state.ts.schema) {
    // 時間軸らしい列を自動選択 (temporal 型 → 名前に time/date を含む列 → 先頭列)
    const cols = state.ts.schema.columns;
    const guess = cols.find((c) => c.kind === "temporal") ||
      cols.find((c) => /time|date|timestamp|時刻|時間/i.test(c.name)) || cols[0];
    if (guess) xSel.value = guess.name;
  }
  refreshLabelsetSelect();
});

function renderTsColumns() {
  const wrap = $("#ts-cols");
  wrap.innerHTML = "";
  if (!state.ts.schema) return;
  const q = $("#ts-col-search").value.trim().toLowerCase();
  for (const c of state.ts.schema.columns) {
    if (c.kind !== "numeric") continue;
    if (q && !c.name.toLowerCase().includes(q)) continue;
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${esc(c.name)}"><span>${esc(c.name)}</span><span class="col-type">${esc(c.type)}</span>`;
    wrap.appendChild(label);
  }
}

$("#ts-col-search").addEventListener("input", () => {
  // 検索で再描画する前に現在のチェック状態を保持
  const checked = tsSelectedColumns();
  renderTsColumns();
  setTsSelectedColumns(checked);
});

function tsSelectedColumns() {
  return $$("#ts-cols input:checked").map((el) => el.value);
}

function setTsSelectedColumns(cols) {
  $$("#ts-cols input").forEach((el) => { el.checked = cols.includes(el.value); });
}

$("#ts-add-filter").addEventListener("click", () => {
  if (!state.ts.schema) return toast("先にデータセットを選択してください", "error");
  state.ts.filters.push({ column: state.ts.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#ts-filters", state.ts);
});

$("#ts-plot").addEventListener("click", plotTimeseries);

async function plotTimeseries() {
  const dsId = $("#ts-dataset").value;
  const x = $("#ts-x").value;
  const ys = tsSelectedColumns();
  if (!dsId) return toast("データセットを選択してください", "error");
  if (!x) return toast("X軸を選択してください", "error");
  if (!ys.length) return toast("表示する信号を1つ以上選択してください", "error");

  try {
    const res = await api(`/api/datasets/${dsId}/timeseries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x, ys,
        filters: activeFilters(state.ts),
        max_points: +$("#ts-maxpoints").value || 5000,
      }),
    });
    $("#ts-meta").innerHTML =
      `<span class="chip accent">${fmtNum(res.returned_rows)} 点表示</span> ` +
      `<span class="chip">全 ${fmtNum(res.total_rows)} 行${res.stride > 1 ? ` / ${res.stride} 行ごとに間引き` : ""}</span>`;
    renderChart("ts-chart", () => {
      const traces = res.ys.map((y) => ({
        type: "scattergl", mode: "lines", name: y,
        x: res.data[res.x], y: res.data[y],
        line: { width: 2 },
        hovertemplate: `%{fullData.name}: %{y}<extra>${esc(res.x)}=%{x}</extra>`,
      }));
      Plotly.react("ts-chart", traces, baseLayout({
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: res.x } }),
        hovermode: "x unified",
        showlegend: res.ys.length >= 2,
      }), PLOT_CONFIG);
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

// ---------- ラベルセット ----------

async function refreshLabelsets() {
  state.labelsets = await api("/api/labelsets");
  refreshLabelsetSelect();
}

function refreshLabelsetSelect() {
  const dsId = $("#ts-dataset").value;
  const sel = $("#ts-labelset");
  sel.innerHTML = '<option value="">— 選択 —</option>' +
    state.labelsets
      .filter((ls) => !ls.dataset_id || ls.dataset_id === dsId)
      .map((ls) => `<option value="${ls.id}">${esc(ls.name)} (${ls.columns.length}信号)</option>`)
      .join("");
}

$("#ts-labelset").addEventListener("change", () => {
  const ls = state.labelsets.find((l) => l.id === $("#ts-labelset").value);
  if (!ls) return;
  $("#ts-col-search").value = "";
  renderTsColumns();
  setTsSelectedColumns(ls.columns);
  toast(`ラベルセット「${ls.name}」を適用しました`);
});

$("#ts-save-labelset").addEventListener("click", async () => {
  const cols = tsSelectedColumns();
  if (!cols.length) return toast("信号を選択してからセット保存してください", "error");
  const name = prompt("ラベルセット名を入力してください:");
  if (!name) return;
  await api("/api/labelsets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, dataset_id: $("#ts-dataset").value || null, columns: cols }),
  });
  toast(`ラベルセット「${name}」を保存しました`);
  refreshLabelsets();
});

// ---------- ビュー保存 ----------

$("#ts-save-view").addEventListener("click", async () => {
  const dsId = $("#ts-dataset").value;
  if (!dsId) return toast("データセットを選択してください", "error");
  const name = prompt("ビュー名を入力してください:");
  if (!name) return;
  await api("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, kind: "timeseries", dataset_id: dsId,
      config: {
        x: $("#ts-x").value,
        ys: tsSelectedColumns(),
        filters: activeFilters(state.ts),
        max_points: +$("#ts-maxpoints").value || 5000,
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});

$("#st-save-view").addEventListener("click", async () => {
  const dsId = $("#st-dataset").value;
  if (!dsId) return toast("データセットを選択してください", "error");
  const name = prompt("ビュー名を入力してください:");
  if (!name) return;
  await api("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, kind: "stats", dataset_id: dsId,
      config: {
        filters: activeFilters(state.st),
        hist_col: $("#hist-col").value,
        hist_bins: +$("#hist-bins").value || 40,
        sc_x: $("#sc-x").value, sc_y: $("#sc-y").value, sc_color: $("#sc-color").value,
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});

// ---------- 統計タブ ----------

$("#st-dataset").addEventListener("change", async () => {
  state.st.schema = await loadSchema($("#st-dataset").value);
  state.st.filters = [];
  renderFilters("#st-filters", state.st);
  $("#hist-col").innerHTML = columnOptions(state.st.schema);
  $("#sc-x").innerHTML = columnOptions(state.st.schema, { numericOnly: true });
  $("#sc-y").innerHTML = columnOptions(state.st.schema, { numericOnly: true });
  $("#sc-color").innerHTML = columnOptions(state.st.schema, { blank: true });
  const numeric = (state.st.schema?.columns || []).filter((c) => c.kind === "numeric");
  if (numeric.length >= 2) $("#sc-y").value = numeric[1].name;
});

$("#st-add-filter").addEventListener("click", () => {
  if (!state.st.schema) return toast("先にデータセットを選択してください", "error");
  state.st.filters.push({ column: state.st.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#st-filters", state.st);
});

$("#st-load").addEventListener("click", loadSummary);

async function loadSummary() {
  const dsId = $("#st-dataset").value;
  if (!dsId) return toast("データセットを選択してください", "error");
  try {
    const res = await api(`/api/datasets/${dsId}/summary`);
    const cols = ["column_name", "column_type", "count", "null_percentage",
      "min", "max", "avg", "std", "q25", "q50", "q75", "approx_unique"];
    const headers = ["列名", "型", "件数", "NULL%", "最小", "最大", "平均", "標準偏差", "Q25", "中央値", "Q75", "ユニーク数"];
    $("#summary-table thead").innerHTML =
      `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
    $("#summary-table tbody").innerHTML = res.stats.map((row) =>
      `<tr>${cols.map((c, i) => {
        let v = row[c];
        if (typeof v === "number" && !Number.isInteger(v)) v = v.toPrecision(5);
        return `<td class="${i >= 2 ? "num" : ""}">${esc(v ?? "—")}</td>`;
      }).join("")}</tr>`
    ).join("");
    $("#summary-empty").style.display = "none";
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

$("#hist-plot").addEventListener("click", async () => {
  const dsId = $("#st-dataset").value;
  const column = $("#hist-col").value;
  if (!dsId || !column) return toast("データセットと列を選択してください", "error");
  try {
    const res = await api(`/api/datasets/${dsId}/histogram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column, bins: +$("#hist-bins").value || 40, filters: activeFilters(state.st) }),
    });
    renderChart("hist-chart", () => {
      let trace;
      if (res.kind === "numeric") {
        const centers = res.edges.slice(0, -1).map((e, i) => (e + res.edges[i + 1]) / 2);
        trace = { type: "bar", x: centers, y: res.counts, marker: { color: seriesColors()[0] },
          hovertemplate: `${esc(column)}: %{x}<br>件数: %{y}<extra></extra>` };
      } else {
        trace = { type: "bar", x: res.labels, y: res.counts, marker: { color: seriesColors()[0] },
          hovertemplate: "%{x}<br>件数: %{y}<extra></extra>" };
      }
      Plotly.react("hist-chart", [trace], baseLayout({
        bargap: 0.08,
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: column } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: "件数" } }),
        showlegend: false,
      }), PLOT_CONFIG);
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
});

$("#sc-plot").addEventListener("click", async () => {
  const dsId = $("#st-dataset").value;
  const x = $("#sc-x").value, y = $("#sc-y").value, color = $("#sc-color").value || null;
  if (!dsId || !x || !y) return toast("データセットとX/Y列を選択してください", "error");
  try {
    const res = await api(`/api/datasets/${dsId}/scatter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y, color, filters: activeFilters(state.st), max_points: 5000 }),
    });
    renderChart("sc-chart", () => {
      let traces;
      if (color) {
        // 色分け列の値ごとにトレースを作成 (上位8カテゴリ + その他)
        const groups = new Map();
        res.data[color].forEach((v, i) => {
          const key = v == null ? "(null)" : String(v);
          if (!groups.has(key)) groups.set(key, { x: [], y: [] });
          groups.get(key).x.push(res.data[x][i]);
          groups.get(key).y.push(res.data[y][i]);
        });
        const entries = [...groups.entries()].sort((a, b) => b[1].x.length - a[1].x.length);
        const top = entries.slice(0, 8);
        const rest = entries.slice(8);
        if (rest.length) {
          const other = { x: [], y: [] };
          rest.forEach(([, g]) => { other.x.push(...g.x); other.y.push(...g.y); });
          top.push(["その他", other]);
        }
        traces = top.map(([name, g]) => ({
          type: "scattergl", mode: "markers", name,
          x: g.x, y: g.y, marker: { size: 5, opacity: 0.65 },
        }));
      } else {
        traces = [{ type: "scattergl", mode: "markers", x: res.data[x], y: res.data[y],
          marker: { size: 5, opacity: 0.6, color: seriesColors()[0] } }];
      }
      Plotly.react("sc-chart", traces, baseLayout({
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: x } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: y } }),
        showlegend: !!color,
      }), PLOT_CONFIG);
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
});

$("#corr-plot").addEventListener("click", async () => {
  const dsId = $("#st-dataset").value;
  if (!dsId) return toast("データセットを選択してください", "error");
  try {
    const res = await api(`/api/datasets/${dsId}/correlation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: activeFilters(state.st) }),
    });
    renderChart("corr-chart", () => {
      const dark = document.documentElement.dataset.theme === "dark";
      // 発散配色: 青 ↔ 赤、中点はニュートラルグレー
      const mid = dark ? "#383835" : "#f0efec";
      const colorscale = [
        [0, "#104281"], [0.25, "#5598e7"], [0.5, mid], [0.75, "#e88a8a"], [1, "#c03434"],
      ];
      Plotly.react("corr-chart", [{
        type: "heatmap", x: res.columns, y: res.columns, z: res.matrix,
        zmin: -1, zmax: 1, colorscale,
        colorbar: { title: { text: "r" }, outlinewidth: 0 },
        hovertemplate: "%{y} × %{x}<br>r = %{z}<extra></extra>",
        xgap: 2, ygap: 2,
      }], baseLayout({
        margin: { l: 120, r: 20, t: 30, b: 100 },
        yaxis: Object.assign(baseLayout().yaxis, { autorange: "reversed" }),
      }), PLOT_CONFIG);
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
});

// ---------- 保存ビュータブ ----------

async function refreshViewsPage() {
  const [views] = await Promise.all([api("/api/views"), refreshLabelsets()]);

  const vBody = $("#views-table tbody");
  vBody.innerHTML = "";
  $("#views-empty").style.display = views.length ? "none" : "";
  for (const v of views) {
    const ds = state.datasets.find((d) => d.id === v.dataset_id);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(v.name)}</strong></td>
      <td><span class="chip ${v.kind === "timeseries" ? "accent" : ""}">${v.kind === "timeseries" ? "時系列" : "統計"}</span></td>
      <td>${esc(ds ? ds.name : v.dataset_id || "—")}</td>
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
  const c = v.config || {};
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

// ---------- 初期化 ----------

(async function init() {
  try {
    await refreshDatasets();
    await refreshLabelsets();
  } catch (e) {
    toast(`初期化エラー: ${e.message}`, "error");
  }
})();
