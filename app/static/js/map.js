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
  const gpsOptions = gpsDatasets.map((g) => g.dataset);
  $("#mp-gps").innerHTML = '<option value="">自動 (同名から判定)</option>' +
    gpsOptions.map((d) => `<option value="${d.id}">${esc(d.name)} (${fmtNum(d.row_count)}行)</option>`).join("");
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

  const requestId = ++mpRequestId;
  setMapLoading(true);
  try {
    const res = await api(`/api/gps/${dsId}/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signals: selectedSignalList(),
        color_signal: $("#mp-color").value || null,
        gps_id: $("#mp-gps").value || null,
        lat_col: $("#mp-lat").value || null,
        lon_col: $("#mp-lon").value || null,
        filters: activeFilters(state.mp),
        max_points: +$("#mp-maxpoints").value || 5000,
      }),
    });
    if (requestId !== mpRequestId) return;
    state.mp.track = res;
    // 自動判定された座標列・モードを選択欄と案内に反映する
    reflectResolvedCoords(res);
    const modeChip = res.mode === "planar"
      ? `<span class="chip">平面座標 (${esc(res.px_col)} / ${esc(res.py_col)})</span>`
      : `<span class="chip">地図 (緯度 ${esc(res.lat_col)} / 経度 ${esc(res.lon_col)})</span>`;
    $("#mp-meta").innerHTML =
      `<span class="chip accent">${fmtNum(res.returned_rows)} 点表示</span> ` +
      `<span class="chip">全 ${fmtNum(res.total_rows)} 行${res.stride > 1 ? ` / ${res.stride} 行ごとに間引き` : ""}</span> ` +
      `<span class="chip">GPS: ${esc(res.gps_dataset.name)}</span> ${modeChip}`;
    renderChart("mp-map", () => renderMap(res));
    renderChart("mp-wave", () => renderWave(res));
    wireLinkedCursor(res);
  } catch (e) {
    if (requestId === mpRequestId) {
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

function renderMap(res) {
  if (res.mode === "planar") return renderPlanar(res);
  return renderGeographic(res);
}

// 緯度経度 → 実地図タイル上に軌跡を描く
function renderGeographic(res) {
  const colors = seriesColors();
  const hasColor = res.color_signal && res.color_values;
  const track = {
    type: "scattermap", mode: hasColor ? "markers" : "lines+markers",
    lat: res.lat, lon: res.lon, name: "軌跡",
    line: { width: 3, color: colors[0] },
    marker: hasColor
      ? { size: 7, color: res.color_values, colorscale: "Viridis", showscale: true,
          colorbar: { title: { text: res.color_signal, side: "right" }, thickness: 12 } }
      : { size: 4, color: colors[0] },
    customdata: res.index.map((_, i) => i),
    hovertemplate: "緯度 %{lat:.5f}<br>経度 %{lon:.5f}" +
      (hasColor ? `<br>${esc(res.color_signal)} %{marker.color}` : "") + "<extra></extra>",
  };
  const highlight = {
    type: "scattermap", mode: "markers",
    lat: [res.lat[0]], lon: [res.lon[0]],
    marker: { size: 15, color: HIGHLIGHT_COLOR },
    hoverinfo: "skip", showlegend: false, visible: false,
  };
  Plotly.react("mp-map", [track, highlight], {
    map: { style: "open-street-map", center: res.center, zoom: res.zoom },
    margin: { l: 0, r: 0, t: 0, b: 0 }, showlegend: false,
    paper_bgcolor: cssVar("--chart-surface"), font: { color: cssVar("--text-primary") },
  }, PLOT_CONFIG);
}

// ローカル座標 (メートル等) → 等尺の平面軌跡として描く
function renderPlanar(res) {
  const colors = seriesColors();
  const hasColor = res.color_signal && res.color_values;
  const track = {
    type: "scattergl", mode: hasColor ? "markers" : "lines+markers",
    x: res.px, y: res.py, name: "軌跡",
    line: { width: 2, color: colors[0] },
    marker: hasColor
      ? { size: 6, color: res.color_values, colorscale: "Viridis", showscale: true,
          colorbar: { title: { text: res.color_signal, side: "right" }, thickness: 12 } }
      : { size: 4, color: colors[0] },
    customdata: res.index.map((_, i) => i),
    hovertemplate: `${esc(res.px_col)} %{x}<br>${esc(res.py_col)} %{y}` +
      (hasColor ? `<br>${esc(res.color_signal)} %{marker.color}` : "") + "<extra></extra>",
  };
  const highlight = {
    type: "scattergl", mode: "markers", x: [res.px[0]], y: [res.py[0]],
    marker: { size: 14, color: HIGHLIGHT_COLOR, line: { width: 1, color: "#fff" } },
    hoverinfo: "skip", showlegend: false, visible: false,
  };
  const layout = baseLayout({
    height: 420, showlegend: false, margin: { l: 56, r: 20, t: 10, b: 44 },
    xaxis: Object.assign(baseLayout().xaxis, { title: { text: res.px_col } }),
    // 縦横を等尺にして軌跡の形が歪まないようにする
    yaxis: Object.assign(baseLayout().yaxis, { title: { text: res.py_col }, scaleanchor: "x", scaleratio: 1 }),
  });
  Plotly.react("mp-map", [track, highlight], layout, PLOT_CONFIG);
}

// 波形: 信号ごとに帯を積み重ね、X軸 (時間/サンプル) を共有
function renderWave(res) {
  const el = $("#mp-wave");
  const signals = Object.keys(res.signals);
  if (!signals.length) {
    Plotly.purge("mp-wave");
    el.innerHTML = '<div class="empty-note" style="padding:24px;">波形に表示する信号を選択してください。</div>';
    return;
  }
  el.innerHTML = "";
  const xvals = res.x_values || res.index;
  const xlabel = res.x || "サンプル番号";
  const k = signals.length;
  const colors = seriesColors();
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

  const traces = signals.map((name, i) => ({
    type: "scattergl", mode: "lines", name,
    x: xvals, y: res.signals[name],
    yaxis: i === 0 ? "y" : `y${i + 1}`,
    line: { width: 2, color: colors[i % colors.length] },
    customdata: res.index.map((_, idx) => idx),
    hovertemplate: `%{y}<extra>${esc(name)}</extra>`,
  }));

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
      font: { size: 11, color: colors[i % colors.length] },
    });
  });
  layout.xaxis = Object.assign(layout.xaxis, {
    domain: [0, 1], anchor: k === 1 ? "y" : `y${k}`, title: { text: xlabel },
  });
  Plotly.react("mp-wave", traces, layout, PLOT_CONFIG);
}

// ---------- 地図 ⇔ 波形 の連動カーソル ----------

function wireLinkedCursor(res) {
  const mapEl = $("#mp-map");
  const waveEl = $("#mp-wave");
  const xvals = res.x_values || res.index;

  // 波形にホバー → 地図の対応点を光らせる
  waveEl.on?.("plotly_hover", (ev) => {
    const p = ev.points?.[0];
    const idx = p?.customdata;
    if (idx == null) return;
    highlightMapPoint(res, idx);
  });
  waveEl.on?.("plotly_unhover", () => clearMapHighlight());

  // 地図にホバー → 波形に縦線を引く
  mapEl.on?.("plotly_hover", (ev) => {
    const idx = ev.points?.[0]?.customdata;
    if (idx == null) return;
    highlightMapPoint(res, idx);
    if (Object.keys(res.signals).length) {
      Plotly.relayout("mp-wave", { shapes: [verticalLine(xvals[idx])] });
    }
  });
  mapEl.on?.("plotly_unhover", () => {
    clearMapHighlight();
    if (Object.keys(res.signals).length) Plotly.relayout("mp-wave", { shapes: [] });
  });
}

function highlightMapPoint(res, idx) {
  const mapEl = $("#mp-map");
  if (!mapEl.data) return;
  const hi = mapEl.data.length - 1; // ハイライトトレースは最後
  const update = res.mode === "planar"
    ? { x: [[res.px[idx]]], y: [[res.py[idx]]], visible: true }
    : { lat: [[res.lat[idx]]], lon: [[res.lon[idx]]], visible: true };
  Plotly.restyle("mp-map", update, [hi]);
}

function clearMapHighlight() {
  const mapEl = $("#mp-map");
  if (!mapEl.data) return;
  Plotly.restyle("mp-map", { visible: false }, [mapEl.data.length - 1]);
}

function verticalLine(x) {
  return {
    type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1,
    line: { color: HIGHLIGHT_COLOR, width: 1.5, dash: "dot" },
  };
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
        lat_col: $("#mp-lat").value || null,
        lon_col: $("#mp-lon").value || null,
        filters: activeFilters(state.mp),
        max_points: +$("#mp-maxpoints").value || 5000,
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});
