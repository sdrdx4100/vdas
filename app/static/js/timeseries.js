/* 時系列可視化タブ */
import { $, $$, api, toast, debounce, fmtNum, esc } from "./api.js";
import { state } from "./state.js";
import { loadSchema, columnOptions, renderFilters, activeFilters } from "./filters.js";
import { seriesColors, baseLayout, PLOT_CONFIG, renderChart, chartRegistry } from "./charts.js";
import { openNameDialog } from "./modals.js";
import { refreshLabelsets, refreshLabelsetSelect } from "./views.js";

const tsAutoPlot = debounce(() => plotTimeseries(true), 500);
state.ts.onChange = tsAutoPlot;
let selectedColumns = new Set();
let tsRequestId = 0;

$("#ts-dataset").addEventListener("change", async () => {
  tsRequestId += 1; // 切替前のデータセットに対する応答を無効化
  setTsLoading(false);
  state.ts.schema = await loadSchema($("#ts-dataset").value);
  state.ts.filters = [];
  selectedColumns = new Set();
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
    // ラベルセット選択中ならそれを新しいデータセットにも適用し続ける
    const ls = state.labelsets.find((l) => l.id === $("#ts-labelset").value);
    if (ls && applyLabelset(ls, true)) {
      plotTimeseries(true);
    } else {
      // 代表的な信号を自動選択して即描画 (速度・回転数らしい列 → 先頭の数値列)
      const numeric = cols.filter((c) => c.kind === "numeric" && c.name !== xSel.value);
      const picks = [];
      for (const re of [/speed|km\/?h|車速/i, /rpm|回転/i]) {
        const hit = numeric.find((c) => re.test(c.name) && !picks.includes(c.name));
        if (hit) picks.push(hit.name);
      }
      for (const c of numeric) {
        if (picks.length >= 2) break;
        if (!picks.includes(c.name)) picks.push(c.name);
      }
      setTsSelectedColumns(picks);
      plotTimeseries(true);
    }
  }
  refreshLabelsetSelect();
});

// ラベルセットを現在のデータセットに適用する。信号が1つも無ければ false
export function applyLabelset(ls, silent = false) {
  const existing = new Set((state.ts.schema?.columns || []).map((c) => c.name));
  const found = ls.columns.filter((c) => existing.has(c));
  if (!found.length) {
    if (!silent) toast(`「${ls.name}」の信号はこのデータセットに存在しません`, "error");
    else $("#ts-labelset").value = "";
    return false;
  }
  setTsSelectedColumns(found);
  const missing = ls.columns.length - found.length;
  if (!silent || missing) {
    toast(`ラベルセット「${ls.name}」を適用しました` +
      (missing ? ` (${missing} 信号はこのデータに無いためスキップ)` : ""));
  }
  return true;
}

// 信号チェック・X軸・点数の変更で自動再描画
$("#ts-cols").addEventListener("change", tsAutoPlot);
$("#ts-x").addEventListener("change", tsAutoPlot);
$("#ts-maxpoints").addEventListener("change", tsAutoPlot);

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
    label.querySelector("input").checked = selectedColumns.has(c.name);
    wrap.appendChild(label);
  }
  updateSelectionSummary();
}

$("#ts-col-search").addEventListener("input", () => {
  renderTsColumns();
});

function tsSelectedColumns() {
  // スキーマ順を保つと、検索や再描画を挟んでも凡例の並びが変わらない。
  return (state.ts.schema?.columns || [])
    .map((column) => column.name)
    .filter((name) => selectedColumns.has(name));
}

export function setTsSelectedColumns(cols) {
  selectedColumns = new Set(cols);
  $$("#ts-cols input").forEach((el) => { el.checked = selectedColumns.has(el.value); });
  updateSelectionSummary();
}

function updateSelectionSummary() {
  const summary = $("#ts-selection-summary");
  if (!summary) return;
  const visible = $$("#ts-cols input").length;
  summary.textContent = `${selectedColumns.size} 信号選択中${visible ? ` / ${visible} 件表示` : ""}`;
}

$("#ts-cols").addEventListener("change", (event) => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  input.checked ? selectedColumns.add(input.value) : selectedColumns.delete(input.value);
  updateSelectionSummary();
});

$("#ts-select-visible").addEventListener("click", () => {
  $$("#ts-cols input").forEach((input) => selectedColumns.add(input.value));
  setTsSelectedColumns([...selectedColumns]);
  plotTimeseries(true);
});

$("#ts-clear-selection").addEventListener("click", () => {
  tsRequestId += 1;
  setTsLoading(false);
  setTsSelectedColumns([]);
  chartRegistry.delete("ts-chart");
  Plotly.purge("ts-chart");
  $("#ts-meta").innerHTML = '<span class="chip">信号を選択するとグラフを表示します</span>';
});

$("#ts-add-filter").addEventListener("click", () => {
  if (!state.ts.schema) return toast("先にデータセットを選択してください", "error");
  state.ts.filters.push({ column: state.ts.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#ts-filters", state.ts);
});

$("#ts-plot").addEventListener("click", () => plotTimeseries());

export async function plotTimeseries(auto = false) {
  const dsId = $("#ts-dataset").value;
  const x = $("#ts-x").value;
  const ys = tsSelectedColumns();
  // 自動更新時は選択不足を黙ってスキップ (手動時のみ案内)
  if (!dsId) return auto || toast("データセットを選択してください", "error");
  if (!x) return auto || toast("X軸を選択してください", "error");
  if (!ys.length) return auto || toast("表示する信号を1つ以上選択してください", "error");

  const requestId = ++tsRequestId;
  setTsLoading(true);
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
    // 自動更新が連続した場合、遅れて返った古い結果では上書きしない。
    if (requestId !== tsRequestId) return;
    $("#ts-meta").innerHTML =
      `<span class="chip accent">${fmtNum(res.returned_rows)} 点表示</span> ` +
      `<span class="chip">全 ${fmtNum(res.total_rows)} 行${res.stride > 1 ? ` / ${res.stride} 行ごとに間引き` : ""}</span>`;
    const mode = $("#ts-mode").value;
    renderChart("ts-chart", () => {
      if (mode === "split" && res.ys.length > 1) {
        renderTsSplit(res);
      } else {
        renderTsOverlay(res);
      }
    });
  } catch (e) {
    if (requestId === tsRequestId) toast(`エラー: ${e.message}`, "error");
  } finally {
    if (requestId === tsRequestId) setTsLoading(false);
  }
}

function setTsLoading(loading) {
  const button = $("#ts-plot");
  button.disabled = loading;
  button.textContent = loading ? "更新中…" : "🔄 更新";
  $("#ts-chart").setAttribute("aria-busy", String(loading));
}

// 重ね書き: 全信号を1つのY軸に描く
function renderTsOverlay(res) {
  const traces = res.ys.map((y) => ({
    type: "scattergl", mode: "lines", name: y,
    x: res.data[res.x], y: res.data[y],
    line: { width: 2 },
    hovertemplate: `%{fullData.name}: %{y}<extra>${esc(res.x)}=%{x}</extra>`,
  }));
  Plotly.react("ts-chart", traces, baseLayout({
    height: 480,
    xaxis: Object.assign(baseLayout().xaxis, { title: { text: res.x } }),
    hovermode: "x unified",
    showlegend: res.ys.length >= 2,
  }), PLOT_CONFIG);
}

// 個別軸: 信号ごとに帯を積み重ね、X軸 (時間) は共有 (ズームも連動)
function renderTsSplit(res) {
  const ys = res.ys;
  const k = ys.length;
  const colors = seriesColors();
  const labelLines = Math.max(...ys.map((y) => Math.ceil(Array.from(y).length / 48)), 1);
  const rowHeight = 150 + Math.max(0, labelLines - 1) * 18;
  const chartHeight = Math.max(480, rowHeight * k + 90);
  const gap = Math.min(0.03, 0.12 / k);
  const bandH = (1 - gap * (k - 1)) / k;
  const headerH = Math.min((22 * labelLines + 4) / chartHeight, bandH * 0.32);

  const layout = baseLayout({
    height: chartHeight,
    showlegend: false,
    hovermode: "x unified",
    margin: { l: 64, r: 20, t: 24, b: 44 },
    annotations: [],
  });
  const gridStyle = layout.yaxis;
  delete layout.yaxis;

  const traces = ys.map((y, i) => ({
    type: "scattergl", mode: "lines", name: y,
    x: res.data[res.x], y: res.data[y],
    yaxis: i === 0 ? "y" : `y${i + 1}`,
    line: { width: 2, color: colors[i % colors.length] },
    hovertemplate: `%{y}<extra>${esc(y)}</extra>`,
  }));

  ys.forEach((y, i) => {
    const top = 1 - i * (bandH + gap);
    const bottom = Math.max(0, top - bandH);
    layout[i === 0 ? "yaxis" : `yaxis${i + 1}`] = Object.assign({}, gridStyle, {
      domain: [bottom, Math.max(bottom + 0.01, top - headerH)],
      tickfont: { size: 10 },
    });
    // 長い名前を縦向きの軸タイトルにすると隣の段へ重なるため、
    // 各段の上部に横書き・折り返し可能な見出しとして表示する。
    layout.annotations.push({
      xref: "paper", yref: "paper", x: 0, y: top,
      xanchor: "left", yanchor: "top", showarrow: false, align: "left",
      text: wrapTsAxisLabel(y),
      font: { size: 11, color: colors[i % colors.length] },
    });
  });
  // X軸 (時間) は1本を全帯で共有し、目盛りは最下段に付ける
  layout.xaxis = Object.assign(layout.xaxis, {
    domain: [0, 1],
    anchor: k === 1 ? "y" : `y${k}`,
    title: { text: res.x },
  });
  Plotly.react("ts-chart", traces, layout, PLOT_CONFIG);
}

function wrapTsAxisLabel(label, lineLength = 48) {
  const chars = Array.from(label);
  const lines = [];
  for (let i = 0; i < chars.length; i += lineLength) {
    lines.push(esc(chars.slice(i, i + lineLength).join("")));
  }
  return `<b>${lines.join("<br>")}</b>`;
}

$("#ts-mode").addEventListener("change", tsAutoPlot);

// ---------- ラベルセット適用 ----------

$("#ts-labelset").addEventListener("change", () => {
  const ls = state.labelsets.find((l) => l.id === $("#ts-labelset").value);
  if (!ls) return;
  $("#ts-col-search").value = "";
  renderTsColumns();
  if (applyLabelset(ls)) plotTimeseries(true);
});

$("#ts-save-labelset").addEventListener("click", async () => {
  const cols = tsSelectedColumns();
  if (!cols.length) return toast("信号を選択してからセット保存してください", "error");
  const name = await openNameDialog(`ラベルセットを保存 (${cols.length} 信号)`);
  if (!name) return;
  try {
    const res = await api("/api/labelsets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, dataset_id: $("#ts-dataset").value || null, columns: cols }),
    });
    await refreshLabelsets();
    $("#ts-labelset").value = res.id;  // 保存した実感が持てるよう即選択状態に
    toast(`ラベルセット「${name}」を保存しました (${cols.length} 信号)`);
  } catch (e) {
    toast(`保存に失敗しました: ${e.message}`, "error");
  }
});

// ---------- ビュー保存 ----------

$("#ts-save-view").addEventListener("click", async () => {
  const dsId = $("#ts-dataset").value;
  if (!dsId) return toast("データセットを選択してください", "error");
  const name = await openNameDialog("時系列ビューを保存");
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
        mode: $("#ts-mode").value,
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});
