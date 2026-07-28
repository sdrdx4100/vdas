/* GPS・地図タブ: 上部に走行軌跡の地図、下部に信号波形。行位置で連動する */
import { $, $$, api, toast, debounce, fmtNum, esc } from "./api.js";
import { state } from "./state.js";
import { loadSchema, columnOptions, renderFilters, activeFilters } from "./filters.js";
import { seriesColors, baseLayout, PLOT_CONFIG, renderChart, chartRegistry, cssVar } from "./charts.js";
import { openNameDialog } from "./modals.js";

const mapAutoPlot = debounce(() => plotMap(true), 500);
state.mp.onChange = mapAutoPlot;
let selectedSignals = new Set();
let gpsDatasets = [];
let pairs = [];
let mpRequestId = 0;
const playback = {
  res: null,
  index: 0,
  indexB: 0,
  playing: false,
  frameId: null,
  lastFrame: 0,
  fractionalStep: 0,
};
const PLAYBACK_POINTS_PER_SECOND = 30;

// ---------- データセット選択肢の同期 ----------

document.addEventListener("datasets-refreshed", () => {
  refreshMapSelects();
});

async function refreshMapSelects() {
  try {
    [gpsDatasets, pairs] = await Promise.all([
      api("/api/gps/datasets"),
      api("/api/gps/pairs"),
    ]);
  } catch (_) {
    gpsDatasets = [];
    pairs = [];
  }
  const gpsIds = new Set(gpsDatasets.map((g) => g.dataset.id));
  // 信号候補は GPS 以外のデータセット (GPS ログ自体は信号側に出さない)
  const signals = state.datasets.filter((d) => !gpsIds.has(d.id));
  fillSelect($("#mp-dataset"), signals, "— 信号データを選択 —");
  fillSelect($("#mp-dataset-b"), signals, "— 比較しない —");
  const gpsOptions = gpsDatasets.map((g) => g.dataset);
  const gpsHtml = '<option value="">自動 (同名から判定)</option>' +
    gpsOptions.map((d) => `<option value="${d.id}">${esc(d.name)} (${fmtNum(d.row_count)}行)</option>`).join("");
  $("#mp-gps").innerHTML = gpsHtml;
  $("#mp-gps-b").innerHTML = gpsHtml;
}

function fillSelect(sel, datasets, placeholder) {
  const prev = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    datasets.map((d) => `<option value="${d.id}">${esc(d.name)} (${fmtNum(d.row_count)}行)</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

export function onMapPageEnter() {
  const sel = $("#mp-dataset");
  if (!sel.value) {
    const gpsIds = new Set(gpsDatasets.map((g) => g.dataset.id));
    const first = state.datasets.find((d) => !gpsIds.has(d.id));
    if (first) sel.value = first.id;
  }
  if (sel.value && state.mp.schema?.dataset?.id !== sel.value) {
    sel.dispatchEvent(new Event("change"));
  }
}

// ---------- 信号データセットの選択 ----------

$("#mp-dataset").addEventListener("change", async () => {
  mpRequestId += 1;
  const dsId = $("#mp-dataset").value;
  state.mp.schema = await loadSchema(dsId);
  state.mp.filters = [];
  selectedSignals = new Set();
  renderFilters("#mp-filters", state.mp);
  renderSignalColumns();
  const colorSel = $("#mp-color");
  colorSel.innerHTML = '<option value="">なし (単色の軌跡)</option>' +
    columnOptions(state.mp.schema, { numericOnly: true });

  // GPS ペアを自動選択して案内する
  const pair = pairs.find((p) => p.signal.id === dsId);
  if (pair) {
    $("#mp-gps").value = pair.gps.id;
    await loadGpsSchema(pair.lat_col, pair.lon_col);
    const cols = pair.lat_col && pair.lon_col
      ? ` (${esc(pair.lat_col)} / ${esc(pair.lon_col)})`
      : ` (座標列: ${(pair.coord_cols || []).map(esc).join(", ")} — 値から自動判定)`;
    setPairStatus(`✅ GPS データ「${esc(pair.gps.name)}」を自動ペア${cols}`, "ok");
  } else {
    $("#mp-gps").value = "";
    await loadGpsSchema();
    setPairStatus("⚠️ 同名の GPS データが見つかりません。GPS データセットを手動で選んでください。", "warn");
  }

  // 代表信号を自動選択して即描画 (速度・回転数らしい列 → 先頭の数値列)
  if (state.mp.schema) {
    const numeric = state.mp.schema.columns.filter((c) => c.kind === "numeric");
    const picks = [];
    for (const re of [/speed|km\/?h|車速/i, /rpm|回転/i]) {
      const hit = numeric.find((c) => re.test(c.name) && !picks.includes(c.name));
      if (hit) picks.push(hit.name);
    }
    for (const c of numeric) {
      if (picks.length >= 2) break;
      if (!picks.includes(c.name)) picks.push(c.name);
    }
    setSelectedSignals(picks);
    if (colorSel.querySelector(`option[value="${CSS.escape(picks[0] || "")}"]`)) {
      colorSel.value = picks[0] || "";
    }
  }
  plotMap(true);
});

function setPairStatus(html, kind) {
  const el = $("#mp-pair-status");
  el.innerHTML = html;
  el.style.color = kind === "warn" ? "var(--warn, #b8860b)" : "var(--text-secondary)";
}

async function loadGpsSchema(preLat, preLon) {
  const gpsId = $("#mp-gps").value;
  const latSel = $("#mp-lat");
  const lonSel = $("#mp-lon");
  if (!gpsId) {
    latSel.innerHTML = '<option value="">自動</option>';
    lonSel.innerHTML = '<option value="">自動</option>';
    return;
  }
  const schema = await loadSchema(gpsId);
  const opts = '<option value="">自動</option>' + columnOptions(schema, { numericOnly: true });
  latSel.innerHTML = opts;
  lonSel.innerHTML = opts;
  if (preLat) latSel.value = preLat;
  if (preLon) lonSel.value = preLon;
}

$("#mp-gps").addEventListener("change", async () => {
  await loadGpsSchema();
  const gpsId = $("#mp-gps").value;
  const g = gpsDatasets.find((d) => d.dataset.id === gpsId);
  if (g) {
    if (g.lat_col) $("#mp-lat").value = g.lat_col;
    if (g.lon_col) $("#mp-lon").value = g.lon_col;
    const cols = g.lat_col && g.lon_col
      ? ` (${esc(g.lat_col)} / ${esc(g.lon_col)})`
      : ` (座標列: ${(g.coord_cols || []).map(esc).join(", ")} — 値から自動判定)`;
    setPairStatus(`GPS データ「${esc(g.dataset.name)}」を使用${cols}`, "ok");
  }
  plotMap(true);
});

$("#mp-dataset-b").addEventListener("change", async () => {
  mpRequestId += 1;
  const dsId = $("#mp-dataset-b").value;
  state.mp.schemaB = dsId ? await loadSchema(dsId) : null;
  $("#mp-gps-b").disabled = !dsId;
  $("#mp-align-offset").value = "0";
  if (!dsId) {
    $("#mp-gps-b").value = "";
    setPairStatusB("");
    plotMap(true);
    return;
  }
  const pair = pairs.find((p) => p.signal.id === dsId);
  if (pair) {
    $("#mp-gps-b").value = pair.gps.id;
    setPairStatusB(`✅ GPS データ「${esc(pair.gps.name)}」を走行 B に自動ペア`, "ok");
  } else {
    $("#mp-gps-b").value = "";
    setPairStatusB("⚠️ 走行 B と同名の GPS データがありません。手動で選択してください。", "warn");
  }
  plotMap(true);
});

$("#mp-gps-b").addEventListener("change", () => {
  const gpsId = $("#mp-gps-b").value;
  const g = gpsDatasets.find((d) => d.dataset.id === gpsId);
  setPairStatusB(g ? `GPS データ「${esc(g.dataset.name)}」を走行 B に使用` : "");
  plotMap(true);
});

function setPairStatusB(html, kind) {
  const el = $("#mp-pair-status-b");
  el.innerHTML = html;
  el.style.color = kind === "warn" ? "var(--warn, #b8860b)" : "var(--text-secondary)";
}

$("#mp-lat").addEventListener("change", mapAutoPlot);
$("#mp-lon").addEventListener("change", mapAutoPlot);
$("#mp-color").addEventListener("change", mapAutoPlot);
$("#mp-maxpoints").addEventListener("change", mapAutoPlot);

// ---------- 波形に出す信号の選択 ----------

function renderSignalColumns() {
  const wrap = $("#mp-cols");
  wrap.innerHTML = "";
  if (!state.mp.schema) return;
  const q = $("#mp-col-search").value.trim().toLowerCase();
  for (const c of state.mp.schema.columns) {
    if (c.kind !== "numeric") continue;
    if (q && !c.name.toLowerCase().includes(q)) continue;
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${esc(c.name)}"><span>${esc(c.name)}</span><span class="col-type">${esc(c.type)}</span>`;
    label.querySelector("input").checked = selectedSignals.has(c.name);
    wrap.appendChild(label);
  }
  updateSelectionSummary();
}

$("#mp-col-search").addEventListener("input", renderSignalColumns);

$("#mp-cols").addEventListener("change", (event) => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  input.checked ? selectedSignals.add(input.value) : selectedSignals.delete(input.value);
  updateSelectionSummary();
  mapAutoPlot();
});

function selectedSignalList() {
  return (state.mp.schema?.columns || [])
    .map((c) => c.name)
    .filter((n) => selectedSignals.has(n));
}

function setSelectedSignals(cols) {
  selectedSignals = new Set(cols);
  $$("#mp-cols input").forEach((el) => { el.checked = selectedSignals.has(el.value); });
  updateSelectionSummary();
}

function updateSelectionSummary() {
  const summary = $("#mp-selection-summary");
  if (summary) summary.textContent = `${selectedSignals.size} 信号選択中`;
}

$("#mp-clear-selection").addEventListener("click", () => {
  setSelectedSignals([]);
  mapAutoPlot();
});

$("#mp-add-filter").addEventListener("click", () => {
  if (!state.mp.schema) return toast("先に信号データセットを選択してください", "error");
  state.mp.filters.push({ column: state.mp.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#mp-filters", state.mp);
});

$("#mp-plot").addEventListener("click", () => plotMap());

// ---------- 描画 ----------

export async function plotMap(auto = false) {
  const dsId = $("#mp-dataset").value;
  if (!dsId) return auto || toast("信号データセットを選択してください", "error");
  const dsIdB = $("#mp-dataset-b").value;

  const requestId = ++mpRequestId;
  stopPlayback();
  setPlaybackEnabled(false);
  setMapLoading(true);
  try {
    const filters = activeFilters(state.mp);
    const requestTrack = (id, body) => api(`/api/gps/${id}/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const requestA = requestTrack(dsId, {
      signals: selectedSignalList(),
      color_signal: dsIdB ? null : ($("#mp-color").value || null),
      gps_id: $("#mp-gps").value || null,
      lat_col: $("#mp-lat").value || null,
      lon_col: $("#mp-lon").value || null,
      filters,
      max_points: +$("#mp-maxpoints").value || 5000,
    });
    let requestB = null;
    if (dsIdB) {
      const columnsB = new Set((state.mp.schemaB?.columns || []).map((c) => c.name));
      const signalsB = selectedSignalList().filter((name) => columnsB.has(name));
      const filtersB = filters.filter((f) => columnsB.has(f.column));
      requestB = requestTrack(dsIdB, {
        signals: signalsB,
        color_signal: null,
        gps_id: $("#mp-gps-b").value || null,
        lat_col: null,
        lon_col: null,
        filters: filtersB,
        max_points: +$("#mp-maxpoints").value || 5000,
      });
    }
    const [res, resB] = await Promise.all([requestA, requestB]);
    if (resB && res.mode !== resB.mode) {
      throw new Error("走行 A と B の座標形式が異なるため重ねて表示できません。");
    }
    const view = buildTrackView(res, resB);
    if (requestId !== mpRequestId) return;
    state.mp.track = res;
    state.mp.trackB = resB;
    // 自動判定された座標列・モードを選択欄と案内に反映する
    reflectResolvedCoords(res);
    const modeChip = res.mode === "planar"
      ? `<span class="chip">平面座標 (${esc(res.px_col)} / ${esc(res.py_col)})</span>`
      : `<span class="chip">地図 (緯度 ${esc(res.lat_col)} / 経度 ${esc(res.lon_col)})</span>`;
    $("#mp-meta").innerHTML =
      `<span class="chip accent">走行 A: ${esc(res.signal_dataset.name)} / ${fmtNum(res.returned_rows)} 点</span> ` +
      (resB ? `<span class="chip">走行 B: ${esc(resB.signal_dataset.name)} / ${fmtNum(resB.returned_rows)} 点</span> ` : "") +
      `<span class="chip">GPS: ${esc(res.gps_dataset.name)}</span> ${modeChip}`;
    renderChart("mp-map", () => renderMap(view));
    renderChart("mp-wave", () => renderWave(view));
    wireLinkedCursor(view);
    resetPlayback(view);
  } catch (e) {
    if (requestId === mpRequestId) {
      clearPlayback();
      toast(`エラー: ${e.message}`, "error");
      Plotly.purge("mp-map");
      Plotly.purge("mp-wave");
      chartRegistry.delete("mp-map");
      chartRegistry.delete("mp-wave");
    }
  } finally {
    if (requestId === mpRequestId) setMapLoading(false);
  }
}

function setMapLoading(loading) {
  const button = $("#mp-plot");
  button.disabled = loading;
  button.textContent = loading ? "更新中…" : "🔄 更新";
  $("#mp-map").setAttribute("aria-busy", String(loading));
}

const HIGHLIGHT_COLOR = "#e3008c";

// バックエンドが値から決めた座標列・モードを選択欄に反映する
function reflectResolvedCoords(res) {
  if (res.mode === "geographic") {
    if (res.lat_col && $(`#mp-lat option[value="${CSS.escape(res.lat_col)}"]`)) $("#mp-lat").value = res.lat_col;
    if (res.lon_col && $(`#mp-lon option[value="${CSS.escape(res.lon_col)}"]`)) $("#mp-lon").value = res.lon_col;
  }
}

function buildTrackView(primary, secondary = null) {
  const colors = seriesColors();
  const runs = [
    { key: "a", label: "走行 A", res: primary, times: timelineSeconds(primary), color: colors[0] },
  ];
  if (secondary) {
    runs.push({ key: "b", label: "走行 B", res: secondary,
      times: timelineSeconds(secondary), color: colors[1] });
  }
  const view = {
    primary, secondary, runs, mode: primary.mode, offsetB: 0,
    timeUnit: primary.x && secondary?.x ? "秒" : "サンプル",
  };
  const alignment = $("#mp-alignment");
  alignment.hidden = !secondary;
  if (secondary) {
    const duration = Math.max(runs[0].times.at(-1) || 0, runs[1].times.at(-1) || 0, 60);
    const limit = Math.ceil(duration);
    $("#mp-align-offset").min = String(-limit);
    $("#mp-align-offset").max = String(limit);
    $("#mp-align-offset").step = view.timeUnit === "秒" ? "0.1" : "1";
    view.offsetB = Math.max(-limit, Math.min(limit, Number($("#mp-align-offset").value) || 0));
    $("#mp-align-offset").value = String(view.offsetB);
    updateAlignmentLabel(view.offsetB, view.timeUnit);
  } else {
    $("#mp-align-offset").value = "0";
    updateAlignmentLabel(0, view.timeUnit);
  }
  return view;
}

function timelineSeconds(res) {
  const values = res.x_values || res.index;
  if (!values.length) return [];
  const dateValues = values.map((value) => {
    if (typeof value !== "string" || !/[-T:/]/.test(value)) return NaN;
    return new Date(value).getTime();
  });
  if (dateValues.every(Number.isFinite)) {
    const first = dateValues[0];
    return dateValues.map((value) => (value - first) / 1000);
  }
  const numeric = values.map(Number);
  if (numeric.every(Number.isFinite)) {
    const first = numeric[0];
    const positiveDeltas = numeric.slice(1)
      .map((value, i) => value - numeric[i])
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
    const medianDelta = positiveDeltas[Math.floor(positiveDeltas.length / 2)] || 1;
    const scale = Math.abs(first) > 1e11 || medianDelta > 1000 ? 1000 : 1;
    return numeric.map((value) => (value - first) / scale);
  }
  return values.map((_, i) => i);
}

function renderMap(view) {
  if (view.mode === "planar") return renderPlanar(view);
  return renderGeographic(view);
}

// 緯度経度 → 実地図タイル上に軌跡を描く
function renderGeographic(view) {
  const comparison = view.runs.length > 1;
  const traces = [];
  for (const [runIndex, run] of view.runs.entries()) {
    const res = run.res;
    const hasColor = !comparison && res.color_signal && res.color_values;
    traces.push({
      type: "scattermap", mode: hasColor ? "markers" : "lines+markers",
      lat: res.lat, lon: res.lon, name: run.label,
      line: { width: 3, color: run.color },
      marker: hasColor
        ? { size: 7, color: res.color_values, colorscale: "Viridis", showscale: true,
            colorbar: { title: { text: res.color_signal, side: "right" }, thickness: 12 } }
        : { size: comparison ? 5 : 4, color: run.color },
      customdata: res.index.map((_, pointIndex) => ({ runIndex, pointIndex })),
      hovertemplate: `<b>${run.label}</b><br>緯度 %{lat:.5f}<br>経度 %{lon:.5f}` +
        (hasColor ? `<br>${esc(res.color_signal)} %{marker.color}` : "") + "<extra></extra>",
    });
    traces.push({
      type: "scattermap", mode: "markers",
      lat: [res.lat[0]], lon: [res.lon[0]],
      marker: { size: 16, color: run.color, line: { width: 2, color: "#fff" } },
      hoverinfo: "skip", showlegend: false, visible: false,
      meta: { highlightFor: runIndex },
    });
  }
  Plotly.react("mp-map", traces, {
    map: { style: "open-street-map", center: view.primary.center, zoom: view.primary.zoom },
    margin: { l: 0, r: 0, t: 0, b: 0 }, showlegend: comparison,
    paper_bgcolor: cssVar("--chart-surface"), font: { color: cssVar("--text-primary") },
  }, PLOT_CONFIG);
}

// ローカル座標 (メートル等) → 等尺の平面軌跡として描く
function renderPlanar(view) {
  const comparison = view.runs.length > 1;
  const traces = [];
  for (const [runIndex, run] of view.runs.entries()) {
    const res = run.res;
    const hasColor = !comparison && res.color_signal && res.color_values;
    traces.push({
      type: "scattergl", mode: hasColor ? "markers" : "lines+markers",
      x: res.px, y: res.py, name: run.label,
      line: { width: 2, color: run.color },
      marker: hasColor
        ? { size: 6, color: res.color_values, colorscale: "Viridis", showscale: true,
            colorbar: { title: { text: res.color_signal, side: "right" }, thickness: 12 } }
        : { size: comparison ? 5 : 4, color: run.color },
      customdata: res.index.map((_, pointIndex) => ({ runIndex, pointIndex })),
      hovertemplate: `<b>${run.label}</b><br>${esc(res.px_col)} %{x}<br>${esc(res.py_col)} %{y}` +
        (hasColor ? `<br>${esc(res.color_signal)} %{marker.color}` : "") + "<extra></extra>",
    });
    traces.push({
      type: "scattergl", mode: "markers", x: [res.px[0]], y: [res.py[0]],
      marker: { size: 15, color: run.color, line: { width: 2, color: "#fff" } },
      hoverinfo: "skip", showlegend: false, visible: false,
      meta: { highlightFor: runIndex },
    });
  }
  const layout = baseLayout({
    height: 420, showlegend: comparison, margin: { l: 56, r: 20, t: 10, b: 44 },
    xaxis: Object.assign(baseLayout().xaxis, { title: { text: view.primary.px_col } }),
    // 縦横を等尺にして軌跡の形が歪まないようにする
    yaxis: Object.assign(baseLayout().yaxis, { title: { text: view.primary.py_col }, scaleanchor: "x", scaleratio: 1 }),
  });
  Plotly.react("mp-map", traces, layout, PLOT_CONFIG);
}

// 波形: 信号ごとに帯を積み重ね、X軸 (時間/サンプル) を共有
function renderWave(view) {
  const el = $("#mp-wave");
  const signals = Object.keys(view.primary.signals);
  if (!signals.length) {
    Plotly.purge("mp-wave");
    el.innerHTML = '<div class="empty-note" style="padding:24px;">波形に表示する信号を選択してください。</div>';
    return;
  }
  el.innerHTML = "";
  const comparison = view.runs.length > 1;
  const xlabel = comparison ? `経過${view.timeUnit === "秒" ? "時間" : "位置"} (${view.timeUnit}・走行 B はオフセット適用)` :
    (view.primary.x || "サンプル番号");
  const k = signals.length;
  const rowHeight = 130;
  const chartHeight = Math.max(320, rowHeight * k + 80);
  const gap = Math.min(0.04, 0.14 / k);
  const bandH = (1 - gap * (k - 1)) / k;

  const layout = baseLayout({
    height: chartHeight,
    showlegend: false,
    hovermode: "x unified",
    margin: { l: 64, r: 20, t: 20, b: 44 },
    annotations: [],
    shapes: [],
  });
  const gridStyle = layout.yaxis;
  delete layout.yaxis;

  const traces = [];
  signals.forEach((name, signalIndex) => {
    view.runs.forEach((run, runIndex) => {
      if (!(name in run.res.signals)) return;
      const offset = runIndex === 1 ? view.offsetB : 0;
      const xvals = comparison
        ? run.times.map((value) => value + offset)
        : (run.res.x_values || run.res.index);
      traces.push({
        type: "scattergl", mode: "lines",
        name: comparison ? `${name} · ${run.label}` : name,
        x: xvals, y: run.res.signals[name],
        yaxis: signalIndex === 0 ? "y" : `y${signalIndex + 1}`,
        line: { width: comparison ? 1.8 : 2, color: run.color },
        customdata: run.res.index.map((_, pointIndex) => ({ runIndex, pointIndex })),
        hovertemplate: `%{y}<extra>${esc(name)}${comparison ? ` · ${run.label}` : ""}</extra>`,
      });
    });
  });

  signals.forEach((name, i) => {
    const top = 1 - i * (bandH + gap);
    const bottom = Math.max(0, top - bandH);
    const headerH = Math.min(20 / chartHeight, bandH * 0.3);
    layout[i === 0 ? "yaxis" : `yaxis${i + 1}`] = Object.assign({}, gridStyle, {
      domain: [bottom, Math.max(bottom + 0.01, top - headerH)],
      tickfont: { size: 10 },
    });
    layout.annotations.push({
      xref: "paper", yref: "paper", x: 0, y: top,
      xanchor: "left", yanchor: "top", showarrow: false, align: "left",
      text: `<b>${esc(name)}</b>`,
      font: { size: 11, color: cssVar("--text-primary") },
    });
  });
  layout.xaxis = Object.assign(layout.xaxis, {
    domain: [0, 1], anchor: k === 1 ? "y" : `y${k}`, title: { text: xlabel },
  });
  Plotly.react("mp-wave", traces, layout, PLOT_CONFIG);
}

// ---------- 地図 ⇔ 波形 の連動カーソル ----------

function wireLinkedCursor(view) {
  const mapEl = $("#mp-map");
  const waveEl = $("#mp-wave");
  mapEl.removeAllListeners?.("plotly_hover");
  mapEl.removeAllListeners?.("plotly_unhover");
  mapEl.removeAllListeners?.("plotly_click");
  waveEl.removeAllListeners?.("plotly_hover");
  waveEl.removeAllListeners?.("plotly_unhover");
  waveEl.removeAllListeners?.("plotly_click");

  // 波形にホバー → 地図の対応点を光らせる
  waveEl.on?.("plotly_hover", (ev) => {
    const point = ev.points?.[0]?.customdata;
    if (!point) return;
    showLinkedAtTime(view, masterTimeForPoint(view, point));
  });
  waveEl.on?.("plotly_unhover", restorePlaybackPosition);
  waveEl.on?.("plotly_click", (ev) => seekFromPlotEvent(view, ev));

  // 地図にホバー → 波形に縦線を引く
  mapEl.on?.("plotly_hover", (ev) => {
    const point = ev.points?.[0]?.customdata;
    if (!point) return;
    showLinkedAtTime(view, masterTimeForPoint(view, point));
  });
  mapEl.on?.("plotly_unhover", restorePlaybackPosition);
  mapEl.on?.("plotly_click", (ev) => seekFromPlotEvent(view, ev));
}

function highlightMapPoint(view, runIndex, idx) {
  const mapEl = $("#mp-map");
  if (!mapEl.data) return;
  const run = view.runs[runIndex];
  const res = run.res;
  const hi = runIndex * 2 + 1;
  const update = res.mode === "planar"
    ? { x: [[res.px[idx]]], y: [[res.py[idx]]], visible: true }
    : { lat: [[res.lat[idx]]], lon: [[res.lon[idx]]], visible: true };
  Plotly.restyle("mp-map", update, [hi]);
}

function verticalLine(x) {
  return {
    type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1,
    line: { color: HIGHLIGHT_COLOR, width: 1.5, dash: "dot" },
  };
}

// ---------- 走行再生 ----------

$("#mp-play-toggle").addEventListener("click", () => {
  if (!playback.res) return;
  playback.playing ? stopPlayback() : startPlayback();
});

$("#mp-play-reset").addEventListener("click", () => {
  stopPlayback();
  playback.indexB = 0;
  if (playback.res?.secondary) {
    setAlignmentFromSelectedPositions(0, 0);
    applyAlignment();
  }
  setPlaybackIndex(0);
});

$("#mp-play-seek").addEventListener("input", (event) => {
  stopPlayback();
  seekRunIndependently(0, Number(event.target.value));
});

$("#mp-play-seek-b").addEventListener("input", (event) => {
  stopPlayback();
  seekRunIndependently(1, Number(event.target.value));
});

const applyAlignment = debounce(() => {
  if (!playback.res?.secondary) return;
  renderWave(playback.res);
  wireLinkedCursor(playback.res);
  setPlaybackIndex(playback.index);
}, 80);

$("#mp-align-offset").addEventListener("input", (event) => {
  if (!playback.res?.secondary) return;
  playback.res.offsetB = Number(event.target.value) || 0;
  updateAlignmentLabel(playback.res.offsetB, playback.res.timeUnit);
  applyAlignment();
});

$("#mp-align-reset").addEventListener("click", () => {
  $("#mp-align-offset").value = "0";
  $("#mp-align-offset").dispatchEvent(new Event("input"));
});

function updateAlignmentLabel(offset, unit = "秒") {
  const digits = unit === "秒" ? 1 : 0;
  $("#mp-align-value").textContent = `${offset >= 0 ? "+" : ""}${offset.toFixed(digits)} ${unit}`;
}

function resetPlayback(view) {
  stopPlayback();
  playback.res = view;
  playback.index = 0;
  playback.indexB = 0;
  playback.fractionalStep = 0;
  const seek = $("#mp-play-seek");
  seek.min = "0";
  seek.max = String(Math.max(0, view.primary.index.length - 1));
  seek.value = "0";
  const seekB = $("#mp-play-seek-b");
  seekB.min = "0";
  seekB.max = String(Math.max(0, (view.secondary?.index.length || 1) - 1));
  seekB.value = "0";
  $("#mp-playback-secondary").hidden = !view.secondary;
  setPlaybackEnabled(view.primary.index.length > 0);
  setPlaybackIndex(0);
}

function clearPlayback() {
  stopPlayback();
  playback.res = null;
  playback.index = 0;
  playback.indexB = 0;
  playback.fractionalStep = 0;
  setPlaybackEnabled(false);
  $("#mp-play-seek").max = "0";
  $("#mp-play-seek").value = "0";
  $("#mp-play-position").textContent = "— / —";
  $("#mp-play-seek-b").max = "0";
  $("#mp-play-seek-b").value = "0";
  $("#mp-play-position-b").textContent = "— / —";
  $("#mp-playback-secondary").hidden = true;
  $("#mp-alignment").hidden = true;
}

function setPlaybackEnabled(enabled) {
  $("#mp-play-toggle").disabled = !enabled;
  $("#mp-play-reset").disabled = !enabled;
  $("#mp-play-seek").disabled = !enabled;
  $("#mp-play-seek-b").disabled = !enabled || !playback.res?.secondary;
}

function startPlayback() {
  if (!playback.res?.primary.index.length) return;
  if (playback.index >= playback.res.primary.index.length - 1) setPlaybackIndex(0);
  playback.playing = true;
  playback.lastFrame = 0;
  playback.fractionalStep = 0;
  $("#mp-play-toggle").textContent = "⏸ 一時停止";
  playback.frameId = requestAnimationFrame(playbackFrame);
}

function stopPlayback() {
  playback.playing = false;
  if (playback.frameId != null) cancelAnimationFrame(playback.frameId);
  playback.frameId = null;
  playback.lastFrame = 0;
  $("#mp-play-toggle").textContent = "▶ 再生";
}

function playbackFrame(timestamp) {
  if (!playback.playing || !playback.res) return;
  if (!playback.lastFrame) playback.lastFrame = timestamp;
  const elapsedSeconds = Math.min(0.25, (timestamp - playback.lastFrame) / 1000);
  playback.lastFrame = timestamp;
  const speed = Number($("#mp-play-speed").value) || 1;
  playback.fractionalStep += elapsedSeconds * PLAYBACK_POINTS_PER_SECOND * speed;
  const steps = Math.floor(playback.fractionalStep);
  if (steps > 0) {
    playback.fractionalStep -= steps;
    const last = playback.res.primary.index.length - 1;
    setPlaybackIndex(Math.min(last, playback.index + steps));
    if (playback.index >= last) {
      stopPlayback();
      return;
    }
  }
  playback.frameId = requestAnimationFrame(playbackFrame);
}

function setPlaybackIndex(index) {
  if (!playback.res?.primary.index.length) return;
  const view = playback.res;
  const last = playback.res.primary.index.length - 1;
  playback.index = Math.max(0, Math.min(last, Math.round(index)));
  const masterTime = view.runs[0].times[playback.index];
  if (view.secondary) {
    const rawTimeB = masterTime - view.offsetB;
    playback.indexB = nearestIndex(view.runs[1].times, rawTimeB);
  }
  $("#mp-play-seek").value = String(playback.index);
  $("#mp-play-seek-b").value = String(playback.indexB);
  updatePlaybackPositionLabels(view, masterTime);
  showLinkedAtTime(view, masterTime);
}

function seekRunIndependently(runIndex, index) {
  const view = playback.res;
  if (!view) return;
  if (runIndex === 0) {
    playback.index = clampIndex(index, view.primary.index.length);
  } else if (view.secondary) {
    playback.indexB = clampIndex(index, view.secondary.index.length);
  }
  if (view.secondary) {
    setAlignmentFromSelectedPositions(playback.index, playback.indexB);
    applyAlignment();
  } else {
    setPlaybackIndex(playback.index);
  }
}

function setAlignmentFromSelectedPositions(indexA, indexB) {
  const view = playback.res;
  if (!view?.secondary) return;
  view.offsetB = view.runs[0].times[indexA] - view.runs[1].times[indexB];
  const slider = $("#mp-align-offset");
  const limit = Math.max(Math.abs(Number(slider.min)), Math.abs(Number(slider.max)),
    Math.ceil(Math.abs(view.offsetB)));
  slider.min = String(-limit);
  slider.max = String(limit);
  slider.value = String(view.offsetB);
  updateAlignmentLabel(view.offsetB, view.timeUnit);
  $("#mp-play-seek").value = String(indexA);
  $("#mp-play-seek-b").value = String(indexB);
  updatePlaybackPositionLabels(view, view.runs[0].times[indexA]);
  highlightMapPoint(view, 0, indexA);
  highlightMapPoint(view, 1, indexB);
}

function clampIndex(index, length) {
  return Math.max(0, Math.min(length - 1, Math.round(index)));
}

function showLinkedAtTime(view, masterTime) {
  view.runs.forEach((run, runIndex) => {
    const rawTime = masterTime - (runIndex === 1 ? view.offsetB : 0);
    if (rawTime < run.times[0] || rawTime > run.times.at(-1)) {
      hideMapPoint(runIndex);
      return;
    }
    const idx = nearestIndex(run.times, rawTime);
    highlightMapPoint(view, runIndex, idx);
  });
  if (Object.keys(view.primary.signals).length) {
    const x = view.secondary
      ? masterTime
      : (view.primary.x_values || view.primary.index)[nearestIndex(view.runs[0].times, masterTime)];
    Plotly.relayout("mp-wave", { shapes: [verticalLine(x)] });
  }
}

function hideMapPoint(runIndex) {
  const mapEl = $("#mp-map");
  if (!mapEl.data) return;
  Plotly.restyle("mp-map", { visible: false }, [runIndex * 2 + 1]);
}

function restorePlaybackPosition() {
  if (playback.res) {
    showLinkedAtTime(playback.res, playback.res.runs[0].times[playback.index]);
  }
}

function seekFromPlotEvent(view, event) {
  const point = event.points?.[0]?.customdata;
  if (!point) return;
  stopPlayback();
  seekRunIndependently(point.runIndex, point.pointIndex);
}

function masterTimeForPoint(view, point) {
  const run = view.runs[point.runIndex];
  return run.times[point.pointIndex] + (point.runIndex === 1 ? view.offsetB : 0);
}

function nearestIndex(values, target) {
  if (!values.length) return 0;
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  if (low > 0 && Math.abs(values[low - 1] - target) <= Math.abs(values[low] - target)) {
    return low - 1;
  }
  return low;
}

function updatePlaybackPositionLabels(view, masterTime) {
  $("#mp-play-position").textContent = runPositionLabel(view.primary, playback.index);
  if (!view.secondary) return;
  const rawTimeB = masterTime - view.offsetB;
  const inRange = rawTimeB >= view.runs[1].times[0] && rawTimeB <= view.runs[1].times.at(-1);
  $("#mp-play-position-b").textContent = inRange
    ? runPositionLabel(view.secondary, playback.indexB)
    : "範囲外";
}

function runPositionLabel(res, index) {
  const value = (res.x_values || res.index)[index];
  return `${formatPositionValue(value)}  (${index + 1} / ${res.index.length})`;
}

function formatPositionValue(value) {
  if (value == null) return "—";
  if (typeof value === "number") return fmtNum(value);
  const text = String(value);
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /[-T:/]/.test(text)) {
    return parsed.toLocaleString("ja-JP");
  }
  return text;
}

export async function loadMapView(view) {
  const config = view.config || {};
  $("#mp-dataset").value = view.dataset_id || "";
  $("#mp-dataset").dispatchEvent(new Event("change"));
  await waitForMap(() => state.mp.schema?.dataset?.id === view.dataset_id);
  setSelectedSignals((config.signals || []).filter((name) =>
    state.mp.schema?.columns.some((column) => column.name === name)));
  state.mp.filters = (config.filters || []).map((filter) => ({ ...filter }));
  renderFilters("#mp-filters", state.mp);
  if (config.gps_id) $("#mp-gps").value = config.gps_id;
  if (config.lat_col) $("#mp-lat").value = config.lat_col;
  if (config.lon_col) $("#mp-lon").value = config.lon_col;
  if (config.color_signal) $("#mp-color").value = config.color_signal;
  if (config.max_points) $("#mp-maxpoints").value = config.max_points;
  if (config.dataset_id_b) {
    $("#mp-dataset-b").value = config.dataset_id_b;
    $("#mp-dataset-b").dispatchEvent(new Event("change"));
    await waitForMap(() => state.mp.schemaB?.dataset?.id === config.dataset_id_b);
    if (config.gps_id_b) $("#mp-gps-b").value = config.gps_id_b;
  }
  $("#mp-align-offset").value = String(config.offset_b || 0);
  await plotMap();
}

function waitForMap(condition, timeout = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    (function poll() {
      if (condition() || Date.now() - started > timeout) return resolve();
      setTimeout(poll, 50);
    })();
  });
}

// ---------- ビュー保存 ----------

$("#mp-save-view").addEventListener("click", async () => {
  const dsId = $("#mp-dataset").value;
  if (!dsId) return toast("信号データセットを選択してください", "error");
  const name = await openNameDialog("GPS・地図ビューを保存");
  if (!name) return;
  await api("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, kind: "map", dataset_id: dsId,
      config: {
        signals: selectedSignalList(),
        color_signal: $("#mp-color").value || null,
        gps_id: $("#mp-gps").value || null,
        dataset_id_b: $("#mp-dataset-b").value || null,
        gps_id_b: $("#mp-gps-b").value || null,
        offset_b: Number($("#mp-align-offset").value) || 0,
        lat_col: $("#mp-lat").value || null,
        lon_col: $("#mp-lon").value || null,
        filters: activeFilters(state.mp),
        max_points: +$("#mp-maxpoints").value || 5000,
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});
