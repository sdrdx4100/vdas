/* 自由分析タブ: タグで定義したデータセット集合A/Bの統計比較 */
import { $, $$, api, toast, debounce, esc } from "./api.js";
import { state } from "./state.js";
import { loadSchema, renderFilters, activeFilters } from "./filters.js";
import { cssVar, seriesColors, baseLayout, PLOT_CONFIG, renderChart, chartRegistry } from "./charts.js";
import { openNameDialog } from "./modals.js";
import { tagChips } from "./datasets.js";

export function renderCmpTagFilter() {
  const wrap = $("#cmp-tag-filter");
  if (!state.tags.length) {
    wrap.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">タグ未登録 (データ管理タブの ✎ から付けられます)</span>';
    return;
  }
  wrap.innerHTML = "";
  for (const tag of state.tags) {
    const chip = document.createElement("button");
    chip.className = "chip clickable" + (state.cmp.tagFilter.has(tag) ? " on" : "");
    chip.textContent = tag;
    chip.addEventListener("click", () => {
      state.cmp.tagFilter.has(tag) ? state.cmp.tagFilter.delete(tag) : state.cmp.tagFilter.add(tag);
      renderCmpTagFilter();
      renderCmpDatasets();
    });
    wrap.appendChild(chip);
  }
}

function cohortPayload() {
  return activeCohortSpecs().map((spec) => ({
    name: spec.name,
    tags: [...spec.tags],
    match: spec.match,
  }));
}

function activeCohortSpecs() {
  if (state.cmp.cohortAnalysisMode === "a") return state.cmp.cohortSpecs.slice(0, 1);
  if (state.cmp.cohortAnalysisMode === "b") return state.cmp.cohortSpecs.slice(1, 2);
  return state.cmp.cohortSpecs;
}

function cohortsReady() {
  return activeCohortSpecs().every((spec) => spec.tags.size > 0);
}

export function renderCmpCohorts() {
  const mode = state.cmp.cohortAnalysisMode;
  $(".cohort-builder-grid").classList.toggle("single", mode !== "compare");
  $$(".cohort-builder").forEach((builder) => {
    const index = Number(builder.dataset.cohortIndex);
    const spec = state.cmp.cohortSpecs[index];
    builder.hidden = (mode === "a" && index === 1) || (mode === "b" && index === 0);
    const match = builder.querySelector(".cohort-match");
    const tags = builder.querySelector(".cohort-tags");
    match.value = spec.match;
    match.onchange = () => {
      spec.match = match.value;
      resolveCmpCohorts(true);
    };
    tags.innerHTML = "";
    if (!state.tags.length) {
      tags.innerHTML = '<span class="hint">タグがありません。データ管理でタグを登録してください。</span>';
      return;
    }
    for (const tag of state.tags) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip clickable" + (spec.tags.has(tag) ? " on" : "");
      chip.textContent = tag;
      chip.addEventListener("click", () => {
        spec.tags.has(tag) ? spec.tags.delete(tag) : spec.tags.add(tag);
        state.cmp.cohortResolution = null;
        renderCmpCohorts();
        resolveCmpCohorts(true);
      });
      tags.appendChild(chip);
    }
  });
  $("#cmp-analysis-mode").value = mode;
}

$("#cmp-analysis-mode").addEventListener("change", () => {
  state.cmp.cohortAnalysisMode = $("#cmp-analysis-mode").value;
  state.cmp.cohortResolution = null;
  renderCmpCohorts();
  resolveCmpCohorts(true);
});

export async function resolveCmpCohorts(autoRun = false) {
  const resolveToken = ++state.cmp.cohortResolveToken;
  const status = $("#cmp-cohort-status");
  if (!cohortsReady()) {
    state.cmp.cohortResolution = null;
    state.cmp.schema = null;
    status.className = "cohort-status";
    const target = state.cmp.cohortAnalysisMode === "compare"
      ? "A/Bそれぞれ"
      : `${state.cmp.cohortAnalysisMode.toUpperCase()}集合`;
    status.textContent = `${target}にタグを1つ以上選択してください。`;
    await updateCmpColumns([]);
    return null;
  }
  status.className = "cohort-status";
  status.textContent = "対象データセットを確認中…";
  try {
    const resolution = await api("/api/compare/cohorts/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cohorts: cohortPayload() }),
    });
    if (resolveToken !== state.cmp.cohortResolveToken) return null;
    state.cmp.cohortResolution = resolution;
    const summary = resolution.cohorts
      .map((cohort) => `${cohort.name}: ${cohort.dataset_count}件 / ${cohort.row_count.toLocaleString("ja-JP")}行`)
      .join("　");
    const overlap = resolution.overlaps.length
      ? `　⚠ ${resolution.overlaps.length}件がA/B両方に含まれます`
      : "";
    status.className = "cohort-status" + (overlap ? " warning" : "");
    status.textContent = summary + overlap;
    await updateCmpColumns();
    if (autoRun) cmpAutoRun();
    return resolution;
  } catch (error) {
    if (resolveToken !== state.cmp.cohortResolveToken) return null;
    state.cmp.cohortResolution = null;
    status.className = "cohort-status warning";
    status.textContent = error.message;
    await updateCmpColumns([]);
    return null;
  }
}

export function renderCmpDatasets() {
  const wrap = $("#cmp-datasets");
  const checked = cmpSelectedIds();
  const filter = state.cmp.tagFilter;
  const list = state.datasets.filter(
    (d) => !filter.size || (d.tags || []).some((t) => filter.has(t)));
  wrap.innerHTML = "";
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-note">該当するデータセットがありません</div>';
    return;
  }
  for (const ds of list) {
    const label = document.createElement("label");
    label.innerHTML =
      `<input type="checkbox" value="${esc(ds.id)}"><span><strong>${esc(ds.name)}</strong></span>` +
      `<span style="margin-left:6px;">${tagChips(ds.tags)}</span>` +
      `<span class="col-type">${ds.row_count.toLocaleString("ja-JP")}行</span>`;
    const cb = label.querySelector("input");
    cb.checked = checked.includes(ds.id);
    cb.addEventListener("change", async () => {
      await updateCmpColumns();
      cmpAutoRun();  // 2件以上そろえば自動で比較開始
    });
    wrap.appendChild(label);
  }
}

export function cmpSelectedIds() {
  return $$("#cmp-datasets input:checked").map((el) => el.value);
}

function cmpCohortIds() {
  const cohorts = state.cmp.cohortResolution?.cohorts || [];
  return [...new Set(cohorts.flatMap((cohort) => cohort.dataset_ids))];
}

function cmpActiveIds() {
  return state.cmp.mode === "cohorts" ? cmpCohortIds() : cmpSelectedIds();
}

export async function updateCmpColumns(idsOverride = null) {
  const ids = idsOverride || cmpActiveIds();
  const sigSel = $("#cmp-signal"), grpSel = $("#cmp-groupby");
  const baseSel = $("#cmp-baseline"), cxSel = $("#cmp-curve-x"), cySel = $("#cmp-curve-y");
  const cohortX = $("#cmp-cohort-x"), cohortY = $("#cmp-cohort-y");
  const transitionState = $("#cmp-transition-state"), transitionOrder = $("#cmp-transition-order");
  const transitionDenominator = $("#cmp-transition-denominator");
  if (!ids.length) {
    sigSel.innerHTML = ""; grpSel.innerHTML = '<option value="">なし (全体のみ)</option>';
    baseSel.innerHTML = ""; cxSel.innerHTML = ""; cySel.innerHTML = "";
    cohortX.innerHTML = ""; cohortY.innerHTML = "";
    transitionState.innerHTML = ""; transitionOrder.innerHTML = "";
    transitionDenominator.innerHTML = '<option value="">1,000行あたり</option>';
    state.cmp.schema = null;
    return;
  }

  for (const id of ids) {
    if (!state.cmp.schemas[id]) state.cmp.schemas[id] = await loadSchema(id);
  }
  // 現在の選択値は await 後に読む (読み込み中にユーザーが変更した値を潰さないため)
  const prevSig = sigSel.value, prevGrp = grpSel.value, prevBase = baseSel.value;
  const prevCx = cxSel.value, prevCy = cySel.value;
  const prevCohortX = cohortX.value, prevCohortY = cohortY.value;
  const prevTransitionState = transitionState.value, prevTransitionOrder = transitionOrder.value;
  const prevTransitionDenominator = transitionDenominator.value;
  // 選択された全データセットに共通する列 (名前で照合)
  const schemas = ids.map((id) => state.cmp.schemas[id]);
  const common = schemas[0].columns.filter((c) =>
    schemas.every((s) => s.columns.some((o) => o.name === c.name && o.kind === c.kind)));
  state.cmp.schema = { columns: common };
  state.cmp.filters = state.cmp.filters.filter((f) => common.some((c) => c.name === f.column));
  renderFilters("#cmp-filters", state.cmp);

  const numeric = common.filter((c) => c.kind === "numeric");
  const numOpts = numeric.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  sigSel.innerHTML = numOpts;
  cxSel.innerHTML = numOpts;
  cySel.innerHTML = numOpts;
  cohortX.innerHTML = numOpts;
  cohortY.innerHTML = numOpts;
  grpSel.innerHTML = '<option value="">なし (全体のみ)</option>' +
    common.filter((c) => c.kind !== "temporal")
      .map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  baseSel.innerHTML = ids.map((id) =>
    `<option value="${esc(id)}">${esc(state.datasets.find((d) => d.id === id)?.name || id)}</option>`).join("");

  const keep = (sel, prev) => prev && [...sel.options].some((o) => o.value === prev) && (sel.value = prev);
  keep(sigSel, prevSig);
  keep(baseSel, prevBase);
  if (prevGrp && [...grpSel.options].some((o) => o.value === prevGrp)) {
    grpSel.value = prevGrp;
  } else {
    // ギア段・モードらしい列を自動候補にする
    const guess = common.find((c) => /gear|ギア|mode|モード|cluster|状態/i.test(c.name));
    grpSel.value = guess ? guess.name : "";
  }
  // 特性カーブの初期候補: X = 車速らしい列、Y = 回転数らしい列
  if (!keep(cxSel, prevCx)) {
    const gx = numeric.find((c) => /speed|km\/?h|velocity|車速/i.test(c.name)) || numeric[0];
    if (gx) cxSel.value = gx.name;
  }
  if (!keep(cySel, prevCy)) {
    const gy = numeric.find((c) => /rpm|回転/i.test(c.name)) || numeric[1] || numeric[0];
    if (gy) cySel.value = gy.name;
  }

  if (!keep(cohortX, prevCohortX)) {
    const guess = numeric.find((c) => /speed|km\/?h|velocity|車速/i.test(c.name)) || numeric[0];
    if (guess) cohortX.value = guess.name;
  }
  if (!keep(cohortY, prevCohortY)) {
    const guess = numeric.find((c) => /rpm|回転/i.test(c.name)) || numeric[1] || numeric[0];
    if (guess) cohortY.value = guess.name;
  }

  transitionState.innerHTML = common
    .filter((c) => c.kind !== "temporal")
    .map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  transitionOrder.innerHTML = common
    .filter((c) => c.kind === "numeric" || c.kind === "temporal")
    .map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  transitionDenominator.innerHTML = '<option value="">1,000行あたり</option>' +
    numeric.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  if (!keep(transitionState, prevTransitionState)) {
    const guess = common.find((c) => /gear|ギア|shift|段|state|状態/i.test(c.name));
    if (guess) transitionState.value = guess.name;
  }
  if (!keep(transitionOrder, prevTransitionOrder)) {
    const guess = common.find((c) => /time|timestamp|時刻|時間/i.test(c.name)) ||
      common.find((c) => c.kind === "temporal") || numeric[0];
    if (guess) transitionOrder.value = guess.name;
  }
  keep(transitionDenominator, prevTransitionDenominator);
}

$("#cmp-add-filter").addEventListener("click", () => {
  if (!state.cmp.schema) return toast("先に比較対象を選択してください", "error");
  state.cmp.filters.push({ column: state.cmp.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#cmp-filters", state.cmp);
});

const cmpAutoRun = debounce(() => runCompare(true), 600);
state.cmp.onChange = cmpAutoRun;

export async function setCmpMode(_mode = "cohorts", autoRun = false) {
  // 自由分析はタグで定義した集合比較に統一する。
  state.cmp.mode = "cohorts";
  $$("[data-cmp-mode]").forEach((button) =>
    button.classList.toggle("active", button.dataset.cmpMode === state.cmp.mode));
  $("#cmp-dataset-selector").hidden = state.cmp.mode !== "datasets";
  $("#cmp-cohort-selector").hidden = state.cmp.mode !== "cohorts";
  $("#cmp-cohort-results").hidden = state.cmp.mode !== "cohorts";
  $$(".cmp-dataset-only").forEach((element) => { element.hidden = state.cmp.mode !== "datasets"; });
  renderCmpCohorts();
  await resolveCmpCohorts(autoRun);
}

$$("[data-cmp-mode]").forEach((button) => button.addEventListener("click", () =>
  setCmpMode(button.dataset.cmpMode, true)));

$("#cmp-plot").addEventListener("click", () => runCompare());
["#cmp-signal", "#cmp-groupby", "#cmp-baseline"].forEach((sel) =>
  $(sel).addEventListener("change", cmpAutoRun));
$("#cmp-curve-x").addEventListener("change", () => plotCmpCurve().catch(() => {}));
$("#cmp-curve-y").addEventListener("change", () => plotCmpCurve().catch(() => {}));
["#cmp-cohort-normalization", "#cmp-cohort-statistic", "#cmp-cohort-x", "#cmp-cohort-y",
  "#cmp-transition-state", "#cmp-transition-order", "#cmp-transition-denominator",
  "#cmp-transition-scale"].forEach((selector) =>
  $(selector).addEventListener("change", cmpAutoRun));

// 自由分析タブを開いたとき、設定済みのタグ集合を再解決する
export function autoSelectCmpDatasets() {
  // 個別ファイルの自動選択は廃止。タグ集合の解決だけを行う。
  if (cohortsReady()) resolveCmpCohorts(true);
}

const cmpDsName = (id) => state.datasets.find((d) => d.id === id)?.name || id;
const swatch = (color) =>
  `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:6px;"></span>`;

function fmtStat(v) {
  const n = Number(v);
  if (v != null && Number.isFinite(n) && !Number.isInteger(n)) return n.toPrecision(5);
  return v ?? "—";
}

export async function runCompare(auto = false) {
  if (state.cmp.mode === "cohorts") return runCohortCompare(auto);
  const ids = cmpSelectedIds();
  const signal = $("#cmp-signal").value;
  if (ids.length < 2) return auto || toast("データセットを2つ以上選択してください", "error");
  if (!signal) return auto || toast("比較する信号を選択してください", "error");
  const ctx = {
    ids, signal,
    groupBy: $("#cmp-groupby").value,
    baseline: $("#cmp-baseline").value || ids[0],
    filters: activeFilters(state.cmp),
  };
  state.cmp.last = ctx;
  try {
    await renderDiffTable(ctx);
    await renderSignalCharts(ctx);
    await plotCmpCurve();
    // レイアウト確定後にチャートをコンテナ幅へ合わせ直す
    requestAnimationFrame(() => {
      ["cmp-hist-chart", "cmp-cdf-chart", "cmp-group-chart", "cmp-curve-chart"].forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.data) Plotly.Plots.resize(el);
      });
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

function cohortPost(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cohorts: cohortPayload(), ...body }),
  });
}

async function runCohortCompare(auto = false) {
  let resolution = state.cmp.cohortResolution;
  if (!resolution) resolution = await resolveCmpCohorts(false);
  if (!resolution) return auto || toast("分析する集合のタグ条件を指定してください", "error");
  const signal = $("#cmp-signal").value;
  const x = $("#cmp-cohort-x").value;
  const y = $("#cmp-cohort-y").value;
  if (!signal) return auto || toast("比較する信号を選択してください", "error");
  if (!x || !y || x === y) return auto || toast("XとYには別の数値信号を選択してください", "error");
  const filters = activeFilters(state.cmp);
  const normalization = $("#cmp-cohort-normalization").value;
  const statistic = $("#cmp-cohort-statistic").value;
  const runToken = ++state.cmp.cohortRunToken;
  const ctx = {
    mode: "cohorts", cohorts: cohortPayload(), signal, x, y, filters, normalization, statistic,
  };
  state.cmp.last = ctx;
  try {
    const [histogram, histogram2d, datasetSummary] = await Promise.all([
      cohortPost("/api/compare/cohorts/histogram", { column: signal, bins: 40, filters }),
      cohortPost("/api/compare/cohorts/histogram2d", { x, y, bins_x: 32, bins_y: 32, filters }),
      cohortPost("/api/compare/cohorts/summary", { column: signal, metric: statistic, filters }),
    ]);
    if (runToken !== state.cmp.cohortRunToken) return;
    renderCohortSummary(resolution, histogram);
    renderCohortHistogram(histogram, normalization);
    renderCohortDatasetSummary(datasetSummary);
    renderCohortHistogram2d(histogram2d, normalization);
    await renderCohortTransitions(filters, normalization, runToken);
    if (runToken !== state.cmp.cohortRunToken) return;
    requestAnimationFrame(() => {
      ["cmp-cohort-hist-chart", "cmp-cohort-stat-chart", "cmp-cohort-2d-chart",
        "cmp-transition-chart"].forEach((id) => {
        const element = document.getElementById(id);
        if (element?.data) Plotly.Plots.resize(element);
      });
    });
  } catch (error) {
    if (runToken !== state.cmp.cohortRunToken) return;
    toast(`比較エラー: ${error.message}`, "error");
  }
}

function renderCohortDatasetSummary(result) {
  const colors = seriesColors();
  const metricLabels = { avg: "平均", q50: "中央値", q75: "Q75" };
  const comparison = result.comparison;
  const cards = result.cohorts.map((cohort, index) => `
    <div class="cohort-summary-card">
      <strong><span class="cohort-badge ${index ? "cohort-b" : "cohort-a"}">${esc(cohort.name)}</span>
        ${metricLabels[result.metric]}の集合要約</strong>
      <span>n=${cohort.summary.n} / 群平均 ${esc(fmtStat(cohort.summary.mean))} /
        群中央値 ${esc(fmtStat(cohort.summary.median))} / 標準偏差 ${esc(fmtStat(cohort.summary.std))}</span>
    </div>`).join("");
  const difference = comparison ? `
    <div class="cohort-summary-card">
      <strong>${esc(comparison.comparison)} − ${esc(comparison.baseline)}</strong>
      <span>差 ${esc(fmtStat(comparison.difference))}
        ${comparison.difference_percent == null ? "" : `(${comparison.difference_percent >= 0 ? "+" : ""}${comparison.difference_percent.toFixed(2)}%)`} /
        95%区間 ${comparison.ci95 ? `${esc(fmtStat(comparison.ci95[0]))} ～ ${esc(fmtStat(comparison.ci95[1]))}` : "—"} /
        Hedges' g ${esc(fmtStat(comparison.hedges_g))} / Cliff's δ ${esc(fmtStat(comparison.cliffs_delta))}</span>
    </div>` : "";
  $("#cmp-cohort-stat-summary").innerHTML = cards + difference;

  const traces = result.cohorts.map((cohort, index) => ({
    type: "box", name: cohort.name, y: cohort.values,
    boxpoints: "all", jitter: 0.28, pointpos: 0,
    marker: { color: colors[index % colors.length], size: 7, opacity: 0.75 },
    line: { color: colors[index % colors.length] },
    customdata: cohort.datasets.filter((dataset) => dataset.value != null)
      .map((dataset) => dataset.dataset_name),
    hovertemplate: "%{customdata}<br>代表値=%{y}<extra>%{fullData.name}</extra>",
  }));
  renderChart("cmp-cohort-stat-chart", () => Plotly.react(
    "cmp-cohort-stat-chart",
    traces,
    baseLayout({
      height: 380,
      yaxis: Object.assign(baseLayout().yaxis, {
        title: { text: `${result.column} — ログごとの${metricLabels[result.metric]}` },
      }),
      showlegend: false,
    }),
    PLOT_CONFIG,
  ));
}

function renderCohortSummary(resolution, histogram) {
  const points = new Map(histogram.cohorts.map((cohort) => [cohort.name, cohort.total_points]));
  $("#cmp-cohort-summary").innerHTML = resolution.cohorts.map((cohort, index) => `
    <div class="cohort-summary-card">
      <strong><span class="cohort-badge ${index ? "cohort-b" : "cohort-a"}">${esc(cohort.name)}</span>
        ${esc(cohort.name)}グループ</strong>
      <span>${cohort.dataset_count.toLocaleString("ja-JP")}データセット / ${cohort.row_count.toLocaleString("ja-JP")}行 /
        有効点 ${Number(points.get(cohort.name) || 0).toLocaleString("ja-JP")}</span>
    </div>`).join("") + (resolution.overlaps.length ? `
      <div class="cohort-summary-card"><strong>⚠ 重複</strong>
      <span>${resolution.overlaps.length}データセットが複数グループに所属しています。</span></div>` : "");
}

function renderCohortHistogram(histogram, normalization) {
  const colors = seriesColors();
  let x;
  if (histogram.kind === "numeric") {
    x = histogram.edges.slice(0, -1).map((edge, index) => (edge + histogram.edges[index + 1]) / 2);
  } else {
    x = histogram.labels;
  }
  const traces = histogram.cohorts.map((cohort, index) => ({
    type: "bar",
    x,
    y: cohort[normalization],
    name: cohort.name,
    opacity: histogram.kind === "numeric" ? 0.62 : 0.9,
    marker: { color: colors[index % colors.length] },
    hovertemplate: "%{x}<br>%{y:.3f}%<extra>%{fullData.name}</extra>",
  }));
  renderChart("cmp-cohort-hist-chart", () => Plotly.react(
    "cmp-cohort-hist-chart",
    traces,
    baseLayout({
      barmode: histogram.kind === "numeric" ? "overlay" : "group",
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: histogram.column } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "割合 (%)" } }),
      showlegend: true,
    }),
    PLOT_CONFIG,
  ));
}

function matrixDifference(left, right) {
  return left.map((row, rowIndex) => row.map((value, columnIndex) =>
    right[rowIndex][columnIndex] - value));
}

function renderCohortHistogram2d(result, normalization) {
  if (!result.cohorts.length) {
    chartRegistry.delete("cmp-cohort-2d-chart");
    Plotly.purge("cmp-cohort-2d-chart");
    return;
  }
  const x = result.x_edges.slice(0, -1).map((edge, index) => (edge + result.x_edges[index + 1]) / 2);
  const y = result.y_edges.slice(0, -1).map((edge, index) => (edge + result.y_edges[index + 1]) / 2);
  const first = result.cohorts[0];
  const firstZ = first[normalization];
  if (result.cohorts.length === 1) {
    renderChart("cmp-cohort-2d-chart", () => Plotly.react(
      "cmp-cohort-2d-chart",
      [{
        type: "heatmap", x, y, z: firstZ, name: first.name, colorscale: "Viridis",
        colorbar: { title: { text: "割合 (%)" }, thickness: 10 },
        hovertemplate: `${esc(first.name)}<br>${esc(result.x)}=%{x}<br>${esc(result.y)}=%{y}<br>%{z:.3f}%<extra></extra>`,
      }],
      baseLayout({
        margin: { l: 55, r: 65, t: 30, b: 50 },
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: result.x } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: result.y } }),
        showlegend: false,
      }),
      PLOT_CONFIG,
    ));
    return;
  }
  const second = result.cohorts[1];
  const secondZ = second[normalization];
  const difference = matrixDifference(firstZ, secondZ);
  const maxDensity = Math.max(...firstZ.flat(), ...secondZ.flat(), 0.000001);
  const maxDifference = Math.max(...difference.flat().map(Math.abs), 0.000001);
  const traces = [
    { type: "heatmap", x, y, z: firstZ, name: first.name, xaxis: "x", yaxis: "y",
      colorscale: "Viridis", zmin: 0, zmax: maxDensity, showscale: false,
      hovertemplate: `${esc(first.name)}<br>${esc(result.x)}=%{x}<br>${esc(result.y)}=%{y}<br>%{z:.3f}%<extra></extra>` },
    { type: "heatmap", x, y, z: secondZ, name: second.name, xaxis: "x2", yaxis: "y2",
      colorscale: "Viridis", zmin: 0, zmax: maxDensity, showscale: false,
      hovertemplate: `${esc(second.name)}<br>${esc(result.x)}=%{x}<br>${esc(result.y)}=%{y}<br>%{z:.3f}%<extra></extra>` },
    { type: "heatmap", x, y, z: difference, name: `${second.name}-${first.name}`, xaxis: "x3", yaxis: "y3",
      colorscale: "RdBu", reversescale: true, zmin: -maxDifference, zmax: maxDifference, zmid: 0,
      colorbar: { title: { text: "差(pt)" }, thickness: 10 },
      hovertemplate: `${esc(second.name)}-${esc(first.name)}<br>${esc(result.x)}=%{x}<br>${esc(result.y)}=%{y}<br>差=%{z:.3f}pt<extra></extra>` },
  ];
  const axis = (domain, title, anchor) => ({
    domain, anchor, title: { text: title }, gridcolor: cssVar("--chart-grid"),
    zerolinecolor: cssVar("--chart-axis"), linecolor: cssVar("--chart-axis"),
  });
  renderChart("cmp-cohort-2d-chart", () => Plotly.react(
    "cmp-cohort-2d-chart",
    traces,
    baseLayout({
      margin: { l: 55, r: 65, t: 48, b: 50 },
      xaxis: axis([0, 0.29], result.x, "y"), yaxis: axis([0, 1], result.y, "x"),
      xaxis2: axis([0.355, 0.645], result.x, "y2"), yaxis2: axis([0, 1], result.y, "x2"),
      xaxis3: axis([0.71, 1], result.x, "y3"), yaxis3: axis([0, 1], result.y, "x3"),
      annotations: [
        { text: first.name, x: 0.145, y: 1.1, xref: "paper", yref: "paper", showarrow: false },
        { text: second.name, x: 0.5, y: 1.1, xref: "paper", yref: "paper", showarrow: false },
        { text: `${second.name} − ${first.name}`, x: 0.855, y: 1.1, xref: "paper", yref: "paper", showarrow: false },
      ],
      showlegend: false,
    }),
    PLOT_CONFIG,
  ));
}

async function renderCohortTransitions(filters, normalization, runToken) {
  const stateColumn = $("#cmp-transition-state").value;
  const orderBy = $("#cmp-transition-order").value;
  if (!stateColumn || !orderBy || stateColumn === orderBy) {
    Plotly.purge("cmp-transition-chart");
    return;
  }
  const denominatorColumn = $("#cmp-transition-denominator").value || null;
  const denominatorScale = Number($("#cmp-transition-scale").value) || 1;
  const result = await cohortPost("/api/compare/cohorts/transitions", {
    state_column: stateColumn,
    order_by: orderBy,
    filters,
    denominator_column: denominatorColumn,
    denominator_scale: denominatorScale,
  });
  if (runToken !== state.cmp.cohortRunToken) return;
  const rateKey = normalization === "mean_dataset_percents" ? "mean_dataset_rates" : "pooled_rates";
  const traces = result.cohorts.map((cohort, index) => ({
    type: "bar", x: result.transitions, y: cohort[rateKey], name: cohort.name,
    marker: { color: seriesColors()[index % seriesColors().length] },
    customdata: cohort.counts,
    hovertemplate: "%{x}<br>頻度=%{y:.3f}<br>回数=%{customdata}<extra>%{fullData.name}</extra>",
  }));
  const unit = result.rate.kind === "rows"
    ? "1,000行あたり"
    : `${result.rate.denominator_column} ${result.rate.scale}あたり`;
  renderChart("cmp-transition-chart", () => Plotly.react(
    "cmp-transition-chart",
    traces,
    baseLayout({
      barmode: "group",
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: `${stateColumn} 遷移` } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: `頻度 (${unit})` } }),
      showlegend: true,
    }),
    PLOT_CONFIG,
  ));
}

// --- 彼我差分サマリ: 共通信号を KS 統計量でランキング ---
async function renderDiffTable(ctx) {
  const diff = await api("/api/compare/diff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset_ids: ctx.ids, baseline: ctx.baseline, filters: ctx.filters }),
  });
  const others = ctx.ids.filter((id) => id !== diff.baseline);
  const headers = ["信号", "分布差 (KS)", `基準: ${cmpDsName(diff.baseline)} 平均`]
    .concat(others.map((id) => `${cmpDsName(id)} 平均 (Δ%)`));
  $("#cmp-diff-table thead").innerHTML =
    `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const tbody = $("#cmp-diff-table tbody");
  tbody.innerHTML = "";
  for (const s of diff.signals) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.title = "クリックすると下のチャートがこの信号に切り替わります";
    const ksBar = s.max_ks == null ? "—" :
      `<div style="display:flex;align-items:center;gap:8px;">
         <div style="width:90px;height:8px;border-radius:4px;background:var(--subtle-active);overflow:hidden;">
           <div style="width:${Math.round(s.max_ks * 100)}%;height:100%;background:var(--accent);"></div>
         </div><span class="num">${s.max_ks.toFixed(3)}</span></div>`;
    const compCells = others.map((id) => {
      const c = s.comps.find((x) => x.dataset_id === id) || {};
      const delta = c.delta_pct == null ? "" :
        ` <span style="color:${Math.abs(c.delta_pct) >= 5 ? "var(--danger)" : "var(--text-muted)"};">(${c.delta_pct > 0 ? "+" : ""}${c.delta_pct}%)</span>`;
      return `<td class="num">${esc(fmtStat(c.avg))}${delta}</td>`;
    }).join("");
    tr.innerHTML = `<td><strong>${esc(s.name)}</strong></td><td>${ksBar}</td>` +
      `<td class="num">${esc(fmtStat(s.base_avg))}</td>${compCells}`;
    tr.addEventListener("click", () => {
      if (![...$("#cmp-signal").options].some((o) => o.value === s.name)) return;
      $("#cmp-signal").value = s.name;
      state.cmp.last = { ...state.cmp.last, signal: s.name };
      renderSignalCharts(state.cmp.last).catch((e) => toast(`エラー: ${e.message}`, "error"));
      toast(`信号「${s.name}」に切り替えました`);
    });
    tbody.appendChild(tr);
  }
  $("#cmp-diff-empty").style.display = "none";
  if (diff.truncated) toast("共通信号が多いため先頭100信号のみスキャンしました");
}

// --- 選択信号のチャート群 (分布・CDF・グループ別・統計量) ---
async function renderSignalCharts(ctx) {
  const { ids, signal, groupBy, filters } = ctx;
  const post = (path, body) => api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // 統計量比較テーブル (フィルタ適用)
  const sum = await post("/api/compare/summary", { dataset_ids: ids, column: signal, filters });
  const statKeys = ["count", "min", "max", "avg", "std", "q25", "q50", "q75"];
  const headers = ["データセット", "件数", "最小", "最大", "平均", "標準偏差", "Q25", "中央値", "Q75"];
  $("#cmp-stats-table thead").innerHTML =
    `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  const colors = seriesColors();
  $("#cmp-stats-table tbody").innerHTML = sum.series.map((row, i) => {
    const cells = statKeys.map((k) => `<td class="num">${esc(fmtStat(row[k]))}</td>`).join("");
    return `<tr><td>${swatch(colors[i % colors.length])}<strong>${esc(cmpDsName(row.dataset_id))}</strong></td>${cells}</tr>`;
  }).join("");
  $("#cmp-stats-empty").style.display = "none";

  // 分布比較 (共通ビン・割合)
  const hist = await post("/api/compare/histogram",
    { dataset_ids: ids, column: signal, bins: 40, filters });
  renderChart("cmp-hist-chart", () => {
      let traces;
      if (hist.kind === "numeric") {
        const centers = hist.edges.slice(0, -1).map((e, i) => (e + hist.edges[i + 1]) / 2);
        traces = hist.series.map((s) => ({
          type: "bar", x: centers, y: s.percents, name: cmpDsName(s.dataset_id), opacity: 0.6,
          hovertemplate: "%{x}<br>%{y}%<extra>%{fullData.name}</extra>",
        }));
      } else {
        traces = hist.series.map((s) => ({
          type: "bar", x: hist.labels, y: s.percents, name: cmpDsName(s.dataset_id),
          hovertemplate: "%{x}<br>%{y}%<extra>%{fullData.name}</extra>",
        }));
      }
      Plotly.react("cmp-hist-chart", traces, baseLayout({
        barmode: hist.kind === "numeric" ? "overlay" : "group",
        bargap: 0.05,
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: signal } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: "割合 (%)" } }),
        showlegend: true,
      }), PLOT_CONFIG);
    });

    // 累積分布 (CDF) 比較
    const cdf = await post("/api/compare/cdf", { dataset_ids: ids, column: signal, filters });
    renderChart("cmp-cdf-chart", () => {
      const traces = cdf.series
        .filter((s) => s.values)
        .map((s) => ({
          type: "scatter", mode: "lines", name: cmpDsName(s.dataset_id),
          x: s.values, y: cdf.percents, line: { width: 2 },
          hovertemplate: `${esc(signal)} ≤ %{x}<br>累積 %{y}%<extra>%{fullData.name}</extra>`,
        }));
      Plotly.react("cmp-cdf-chart", traces, baseLayout({
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: signal } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: "累積割合 (%)" }, range: [0, 100] }),
        hovermode: "y unified",
        showlegend: true,
      }), PLOT_CONFIG);
    });

  // グループ別比較 (箱ひげ図)
  if (groupBy) {
    const gs = await post("/api/compare/groupstats",
      { dataset_ids: ids, column: signal, group_by: groupBy, filters });
    $("#cmp-group-title").textContent = `グループ別比較: ${signal} × ${groupBy}`;
    $("#cmp-group-card").style.display = "";
    renderChart("cmp-group-chart", () => {
      const traces = gs.series.map((s, i) => ({
        type: "box", name: cmpDsName(s.dataset_id),
        x: gs.groups,
        q1: s.groups.map((g) => g?.q1 ?? null),
        median: s.groups.map((g) => g?.median ?? null),
        q3: s.groups.map((g) => g?.q3 ?? null),
        lowerfence: s.groups.map((g) => g?.lowerfence ?? null),
        upperfence: s.groups.map((g) => g?.upperfence ?? null),
        mean: s.groups.map((g) => g?.avg ?? null),
        marker: { color: seriesColors()[i % 8] },
        line: { width: 2 },
        boxmean: true,
      }));
      Plotly.react("cmp-group-chart", traces, baseLayout({
        boxmode: "group",
        xaxis: Object.assign(baseLayout().xaxis,
          { title: { text: groupBy }, type: "category" }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: signal } }),
        showlegend: true,
      }), PLOT_CONFIG);
    });
  } else {
    $("#cmp-group-card").style.display = "none";
    chartRegistry.delete("cmp-group-chart");
  }
}

// --- 特性カーブ比較 (X ビン × Y 平均 + P10-P90 帯) ---
$("#cmp-curve-plot").addEventListener("click", () => plotCmpCurve().catch(
  (e) => toast(`エラー: ${e.message}`, "error")));

async function plotCmpCurve() {
  const ctx = state.cmp.last;
  if (!ctx) return;
  const x = $("#cmp-curve-x").value, y = $("#cmp-curve-y").value;
  if (!x || !y) return;
  if (x === y) return toast("特性カーブの X と Y には別の列を指定してください", "error");
  const curve = await api("/api/compare/curve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset_ids: ctx.ids, x, y, bins: 40, filters: ctx.filters }),
  });
  renderChart("cmp-curve-chart", () => {
    const colors = seriesColors();
    const traces = [];
    curve.series.forEach((s, i) => {
      const color = colors[i % colors.length];
      const name = cmpDsName(s.dataset_id);
      // P10-P90 帯 (null ビンを除いた連続区間で塗る)
      traces.push({
        type: "scatter", mode: "lines", x: curve.centers, y: s.p10,
        line: { width: 0 }, hoverinfo: "skip", showlegend: false,
        legendgroup: name, connectgaps: false,
      });
      traces.push({
        type: "scatter", mode: "lines", x: curve.centers, y: s.p90,
        fill: "tonexty", fillcolor: color + "26", line: { width: 0 },
        hoverinfo: "skip", showlegend: false, legendgroup: name, connectgaps: false,
      });
      traces.push({
        type: "scatter", mode: "lines", x: curve.centers, y: s.mean,
        name, line: { width: 2, color }, legendgroup: name, connectgaps: false,
        customdata: s.count,
        hovertemplate: `${esc(curve.y)} 平均 %{y}<br>n=%{customdata}<extra>%{fullData.name}</extra>`,
      });
    });
    Plotly.react("cmp-curve-chart", traces, baseLayout({
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: curve.x } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: curve.y } }),
      hovermode: "x unified",
      showlegend: true,
    }), PLOT_CONFIG);
  });
}

$("#cmp-save-view").addEventListener("click", async () => {
  const ids = cmpSelectedIds();
  if (state.cmp.mode === "datasets" && ids.length < 2) {
    return toast("データセットを2つ以上選択してください", "error");
  }
  if (state.cmp.mode === "cohorts" && !state.cmp.cohortResolution) {
    return toast("A/Bのタグ条件を指定してください", "error");
  }
  const name = await openNameDialog("比較ビューを保存");
  if (!name) return;
  const cohortConfig = state.cmp.mode === "cohorts" ? {
    mode: "cohorts",
    analysis_mode: state.cmp.cohortAnalysisMode,
    cohorts: cohortPayload(),
    normalization: $("#cmp-cohort-normalization").value,
    statistic: $("#cmp-cohort-statistic").value,
    cohort_x: $("#cmp-cohort-x").value || null,
    cohort_y: $("#cmp-cohort-y").value || null,
    transition_state: $("#cmp-transition-state").value || null,
    transition_order: $("#cmp-transition-order").value || null,
    transition_denominator: $("#cmp-transition-denominator").value || null,
    transition_scale: Number($("#cmp-transition-scale").value) || 1,
  } : { mode: "datasets" };
  await api("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, kind: "compare", dataset_id: null,
      config: {
        ...cohortConfig,
        dataset_ids: ids,
        signal: $("#cmp-signal").value,
        group_by: $("#cmp-groupby").value || null,
        baseline: $("#cmp-baseline").value || null,
        filters: activeFilters(state.cmp),
        curve_x: $("#cmp-curve-x").value || null,
        curve_y: $("#cmp-curve-y").value || null,
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});
