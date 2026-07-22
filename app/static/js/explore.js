/* 自由分析タブ (万能チャートビルダー)
   グラフ種別 × X・Y・色分け・集計・フィルタを自由に組み合わせる。
   集計「割合%」は色グループ内で正規化するため、N数の違う対象の比較に使える。 */
import { $, $$, api, toast, debounce, esc, fmtNum } from "./api.js";
import { state } from "./state.js";
import { renderChart, baseLayout, PLOT_CONFIG, seriesColors, cssVar } from "./charts.js";
import { columnOptions, loadSchema, renderFilters, activeFilters } from "./filters.js";
import { openNameDialog } from "./modals.js";

export const EX_VISIBILITY = {
  scatter:   { x: "num", y: "num", color: true,  bins: false, points: true },
  line:      { x: "any", y: "num", color: true,  bins: false, points: true },
  bar:       { x: "any", y: "num", color: true,  bins: false, points: false, agg: true },
  box:       { x: "any", y: "num", color: true,  bins: false, points: false },
  histogram: { x: "any", y: null,  color: true,  bins: true,  points: false },
  heatmap:   { x: "num", y: "num", color: false, bins: true,  points: false },
};
const AGG_LABEL = { avg: "平均", median: "中央値", sum: "合計", count: "件数",
  min: "最小", max: "最大", share: "割合%" };
const NO_Y_AGGS = ["count", "share"];

state.ex.source = state.ex.source || "dataset";   // "dataset" | "groups"
state.ex.groupTags = state.ex.groupTags || new Set();
state.ex.schemas = state.ex.schemas || {};

const exAuto = debounce(() => plotExplore(true), 500);
state.ex.onChange = exAuto;

// ---------- 対象の切替 (データセット単体 / タググループ) ----------

export function setExSource(source) {
  state.ex.source = source === "groups" ? "groups" : "dataset";
  $("#ex-src-dataset").classList.toggle("on", state.ex.source === "dataset");
  $("#ex-src-groups").classList.toggle("on", state.ex.source === "groups");
  $("#ex-dataset-wrap").hidden = state.ex.source !== "dataset";
  $("#ex-groups-wrap").hidden = state.ex.source !== "groups";
  if (state.ex.source === "groups") renderExGroupTags();
  exUpdateControls();
}

$("#ex-src-dataset").addEventListener("click", async () => {
  setExSource("dataset");
  await exRefreshSchema();
  plotExplore(true);
});
$("#ex-src-groups").addEventListener("click", async () => {
  setExSource("groups");
  await exRefreshSchema();
  plotExplore(true);
});

export function renderExGroupTags() {
  const wrap = $("#ex-group-tags");
  if (!state.tags.length) {
    wrap.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">タグがまだありません。データ管理タブでタグを付けてください。</span>';
    return;
  }
  wrap.innerHTML = "";
  for (const tag of state.tags) {
    const members = state.datasets.filter((d) => (d.tags || []).includes(tag));
    const chip = document.createElement("button");
    chip.className = "chip clickable" + (state.ex.groupTags.has(tag) ? " on" : "");
    chip.type = "button";
    chip.textContent = `${tag} (${members.length})`;
    chip.disabled = !members.length;
    chip.addEventListener("click", async () => {
      state.ex.groupTags.has(tag) ? state.ex.groupTags.delete(tag) : state.ex.groupTags.add(tag);
      renderExGroupTags();
      await exRefreshSchema();
      plotExplore(true);
    });
    wrap.appendChild(chip);
  }
}

// データ一覧の更新 (タグ変更など) に追従する
document.addEventListener("datasets-refreshed", () => {
  if (state.ex.source === "groups") renderExGroupTags();
});

export function exSelectedGroups() {
  return [...state.ex.groupTags].map((tag) => ({
    label: tag,
    dataset_ids: state.datasets.filter((d) => (d.tags || []).includes(tag)).map((d) => d.id),
  })).filter((g) => g.dataset_ids.length);
}

// 現在の対象に応じたスキーマ (グループ時は関与する全データセットの共通列) を用意する
export async function exRefreshSchema() {
  if (state.ex.source === "dataset") {
    state.ex.schema = $("#ex-dataset").value ? await loadSchema($("#ex-dataset").value) : null;
  } else {
    const ids = [...new Set(exSelectedGroups().flatMap((g) => g.dataset_ids))];
    if (!ids.length) {
      state.ex.schema = null;
    } else {
      for (const id of ids) {
        if (!state.ex.schemas[id]) state.ex.schemas[id] = await loadSchema(id);
      }
      const schemas = ids.map((id) => state.ex.schemas[id]);
      const common = schemas[0].columns.filter((c) =>
        schemas.every((sc) => sc.columns.some((o) => o.name === c.name && o.kind === c.kind)));
      state.ex.schema = { columns: common };
    }
  }
  state.ex.filters = state.ex.filters.filter(
    (f) => state.ex.schema?.columns.some((c) => c.name === f.column));
  renderFilters("#ex-filters", state.ex);
  exFillColumns();
}

export function exUpdateControls() {
  const v = EX_VISIBILITY[state.ex.kind];
  const show = (id, on) => { $(id).style.display = on ? "" : "none"; };
  const yNeeded = v.y && !(state.ex.kind === "bar" && NO_Y_AGGS.includes($("#ex-agg").value));
  show("#ex-y-wrap", yNeeded);
  show("#ex-color-wrap", !!v.color && state.ex.source === "dataset");
  show("#ex-agg-wrap", !!v.agg);
  exSyncAggOptions();
  show("#ex-bins-wrap", v.bins);
  show("#ex-points-wrap", v.points);
  exFillColumns();
}

function exFillColumns() {
  const schema = state.ex.schema;
  if (!schema) return;
  const v = EX_VISIBILITY[state.ex.kind];
  const keep = (sel, html) => {
    const prev = sel.value;
    sel.innerHTML = html;
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  };
  keep($("#ex-x"), columnOptions(schema, { numericOnly: v.x === "num" }));
  keep($("#ex-y"), columnOptions(schema, { numericOnly: true }));
  keep($("#ex-color"), '<option value="">なし</option>' + columnOptions(schema));
}

$$("#ex-kind .chart-kind").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$("#ex-kind .chart-kind").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.ex.kind = btn.dataset.kind;
    exUpdateControls();
    plotExplore(true);
  });
});

$("#ex-dataset").addEventListener("change", async () => {
  if (state.ex.source !== "dataset") return;  // グループモード中は無視
  state.ex.schema = await loadSchema($("#ex-dataset").value);
  state.ex.filters = [];
  renderFilters("#ex-filters", state.ex);
  if (!state.ex.schema) return;
  exFillColumns();
  // 初期候補: X = 車速らしい列、Y = 回転数らしい列
  const numeric = state.ex.schema.columns.filter((c) => c.kind === "numeric");
  const gx = numeric.find((c) => /speed|km\/?h|車速/i.test(c.name)) || numeric[0];
  const gy = numeric.find((c) => /rpm|回転/i.test(c.name)) || numeric[1] || numeric[0];
  if (gx) $("#ex-x").value = gx.name;
  if (gy) $("#ex-y").value = gy.name;
  exUpdateControls();
  plotExplore(true);
});

["#ex-x", "#ex-y", "#ex-color", "#ex-bins", "#ex-points"].forEach((sel) =>
  $(sel).addEventListener("change", exAuto));
$("#ex-agg").addEventListener("change", () => { exUpdateControls(); exAuto(); });

// タググループ比較では母数 (行数) が違うため、件数・合計は不公平になる。
// N非依存の集計 (平均/中央値/最小/最大/割合%) だけ選べるようにする。
const N_DEPENDENT_AGGS = ["count", "sum"];
function exSyncAggOptions() {
  const groupMode = state.ex.source === "groups";
  const sel = $("#ex-agg");
  [...sel.options].forEach((o) => {
    o.hidden = groupMode && N_DEPENDENT_AGGS.includes(o.value);
  });
  if (groupMode && N_DEPENDENT_AGGS.includes(sel.value)) sel.value = "avg";
}

$("#ex-add-filter").addEventListener("click", () => {
  if (!state.ex.schema) return toast("先にデータセットを選択してください", "error");
  state.ex.filters.push({ column: state.ex.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#ex-filters", state.ex);
});

export async function plotExplore(auto = false) {
  if (state.ex.source === "groups") return plotExploreGroups(auto);
  const dsId = $("#ex-dataset").value;
  if (!dsId) return auto || toast("データセットを選択してください", "error");
  const kind = state.ex.kind;
  const v = EX_VISIBILITY[kind];
  const yNeeded = v.y && !(kind === "bar" && NO_Y_AGGS.includes($("#ex-agg").value));
  const spec = {
    kind,
    x: $("#ex-x").value || null,
    y: yNeeded ? $("#ex-y").value || null : null,
    color: v.color ? $("#ex-color").value || null : null,
    agg: $("#ex-agg").value,
    bins: +$("#ex-bins").value || 40,
    filters: activeFilters(state.ex),
    max_points: +$("#ex-points").value || 5000,
  };
  try {
    const res = await api(`/api/datasets/${dsId}/chart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    renderExStats(res);
    renderChart("ex-chart", () => renderExChart(res, spec));
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

function renderExStats(res) {
  const s = res.stats;
  const chips = [];
  if (res.total_rows != null) {
    chips.push(`<span class="chip accent">${fmtNum(res.returned_rows)} 点表示 / 全 ${fmtNum(res.total_rows)} 行</span>`);
  }
  if (s) {
    const f = (v) => (v == null ? "—" : (Number.isInteger(v) ? fmtNum(v) : Number(v).toPrecision(5)));
    chips.push(`<span class="chip">${esc(s.column)}:</span>`,
      `<span class="chip">件数 ${fmtNum(s.count)}</span>`,
      `<span class="chip">平均 ${f(s.avg)}</span>`,
      `<span class="chip">中央値 ${f(s.median)}</span>`,
      `<span class="chip">σ ${f(s.std)}</span>`,
      `<span class="chip">範囲 ${f(s.min)}〜 ${f(s.max)}</span>`);
  }
  $("#ex-stats").innerHTML = chips.join(" ");
}

// 色分け列でグループ化 (上位8グループ + その他)
function exGroupByColor(data, x, y, colorCol) {
  const groups = new Map();
  data[colorCol].forEach((v, i) => {
    const key = v == null ? "(null)" : String(v);
    if (!groups.has(key)) groups.set(key, { x: [], y: [] });
    groups.get(key).x.push(data[x][i]);
    groups.get(key).y.push(data[y][i]);
  });
  let entries = [...groups.entries()];
  // 数値なら数値順、それ以外は件数順で安定させる
  const numericKeys = entries.every(([k]) => k === "(null)" || !isNaN(+k));
  entries.sort(numericKeys
    ? (a, b) => (a[0] === "(null)" ? 1 : b[0] === "(null)" ? -1 : +a[0] - +b[0])
    : (a, b) => b[1].x.length - a[1].x.length);
  if (entries.length > 9) {
    const rest = entries.slice(8);
    const other = { x: [], y: [] };
    rest.forEach(([, g]) => { other.x.push(...g.x); other.y.push(...g.y); });
    entries = entries.slice(0, 8).concat([["その他", other]]);
  }
  return entries;
}

// 密度マップ用の単色 (青) シーケンシャルスケール
const SEQ_BLUE = [
  [0, "rgba(0,0,0,0)"], [0.001, "#cde2fb"], [0.2, "#9ec5f4"], [0.4, "#6da7ec"],
  [0.6, "#3987e5"], [0.8, "#256abf"], [1, "#0d366b"],
];

function renderExChart(res, spec) {
  const colors = seriesColors();
  const base = (extra) => baseLayout(Object.assign({ height: 520 }, extra));
  let traces = [], layout;

  if (res.kind === "scatter" || res.kind === "line") {
    const mode = res.kind === "line" ? "lines" : "markers";
    const style = res.kind === "line" ? { line: { width: 2 } } : { marker: { size: 5, opacity: 0.65 } };
    if (spec.color) {
      traces = exGroupByColor(res.data, spec.x, spec.y, spec.color).map(([name, g]) => ({
        type: "scattergl", mode, name: `${spec.color}=${name}`,
        x: g.x, y: g.y, ...JSON.parse(JSON.stringify(style)),
      }));
    } else {
      traces = [{ type: "scattergl", mode, x: res.data[spec.x], y: res.data[spec.y],
        ...style, marker: { ...style.marker, color: colors[0] }, line: { width: 2, color: colors[0] } }];
    }
    layout = base({
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: spec.x } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: spec.y } }),
      showlegend: !!spec.color,
      hovermode: res.kind === "line" ? "x unified" : "closest",
    });
  } else if (res.kind === "bar") {
    const single = res.series.length === 1 && !res.series[0].label;
    traces = res.series.map((s, i) => ({
      type: "bar", x: res.groups, y: s.values,
      name: single ? "" : `${spec.color}=${s.label}`,
      marker: { color: colors[i % colors.length] },
    }));
    const ylab = spec.agg === "count" ? "件数" :
      spec.agg === "share" ? "割合 (%)" : `${AGG_LABEL[spec.agg]}(${spec.y})`;
    layout = base({
      barmode: "group", bargap: 0.15,
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: spec.x }, type: "category" }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: ylab } }),
      showlegend: !single,
    });
  } else if (res.kind === "box") {
    const single = res.series.length === 1 && !res.series[0].label;
    traces = res.series.map((s, i) => ({
      type: "box", x: res.groups,
      name: single ? spec.y : `${spec.color}=${s.label}`,
      q1: s.groups.map((g) => g?.q1 ?? null),
      median: s.groups.map((g) => g?.median ?? null),
      q3: s.groups.map((g) => g?.q3 ?? null),
      lowerfence: s.groups.map((g) => g?.lowerfence ?? null),
      upperfence: s.groups.map((g) => g?.upperfence ?? null),
      mean: s.groups.map((g) => g?.avg ?? null),
      marker: { color: colors[i % colors.length] }, line: { width: 2 }, boxmean: true,
    }));
    layout = base({
      boxmode: "group",
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: spec.x }, type: "category" }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: spec.y } }),
      showlegend: !single,
    });
  } else if (res.kind === "histogram") {
    const multi = res.series.length > 1;
    const val = (s) => (multi ? s.percents : s.counts);
    if (res.sub === "numeric") {
      const centers = res.edges.slice(0, -1).map((e, i) => (e + res.edges[i + 1]) / 2);
      traces = res.series.map((s, i) => ({
        type: "bar", x: centers, y: val(s),
        name: multi ? `${spec.color}=${s.label}` : "",
        opacity: multi ? 0.6 : 1,
        marker: { color: colors[i % colors.length] },
      }));
    } else {
      traces = res.series.map((s, i) => ({
        type: "bar", x: res.labels, y: val(s),
        name: multi ? `${spec.color}=${s.label}` : "",
        marker: { color: colors[i % colors.length] },
      }));
    }
    layout = base({
      barmode: multi ? (res.sub === "numeric" ? "overlay" : "group") : "group",
      bargap: 0.08,
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: spec.x } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: multi ? "割合 (%)" : "件数" } }),
      showlegend: multi,
    });
  } else {  // heatmap
    const cx = res.x_edges.slice(0, -1).map((e, i) => (e + res.x_edges[i + 1]) / 2);
    const cy = res.y_edges.slice(0, -1).map((e, i) => (e + res.y_edges[i + 1]) / 2);
    traces = [{
      type: "heatmap", x: cx, y: cy, z: res.matrix,
      colorscale: SEQ_BLUE, zmin: 0,
      colorbar: { title: { text: "件数" }, outlinewidth: 0 },
      hovertemplate: `${esc(spec.x)}: %{x}<br>${esc(spec.y)}: %{y}<br>件数: %{z}<extra></extra>`,
    }];
    layout = base({
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: spec.x } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: spec.y } }),
    });
  }
  Plotly.react("ex-chart", traces, layout, PLOT_CONFIG);
}

$("#ex-save-view").addEventListener("click", async () => {
  const dsId = $("#ex-dataset").value;
  if (state.ex.source === "dataset" && !dsId) return toast("データセットを選択してください", "error");
  if (state.ex.source === "groups" && !state.ex.groupTags.size) return toast("比較するタグを選択してください", "error");
  const name = await openNameDialog("グラフ作成ビューを保存");
  if (!name) return;
  await api("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, kind: "explore", dataset_id: state.ex.source === "dataset" ? dsId : null,
      config: {
        source: state.ex.source,
        group_tags: [...state.ex.groupTags],
        chart_kind: state.ex.kind,
        x: $("#ex-x").value, y: $("#ex-y").value, color: $("#ex-color").value || null,
        agg: $("#ex-agg").value, bins: +$("#ex-bins").value || 40,
        max_points: +$("#ex-points").value || 5000,
        filters: activeFilters(state.ex),
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});

// ---------- タググループモード: 系列 = グループとして描画 ----------

async function plotExploreGroups(auto = false) {
  const groups = exSelectedGroups();
  if (!groups.length) return auto || toast("比較するタグを1つ以上選択してください", "error");
  const kind = state.ex.kind;
  const v = EX_VISIBILITY[kind];
  const yNeeded = v.y && !(kind === "bar" && NO_Y_AGGS.includes($("#ex-agg").value));
  const spec = {
    groups, kind,
    x: $("#ex-x").value || null,
    y: yNeeded ? $("#ex-y").value || null : null,
    agg: $("#ex-agg").value,
    bins: +$("#ex-bins").value || 40,
    filters: activeFilters(state.ex),
    max_points: +$("#ex-points").value || 5000,
  };
  try {
    const res = await api("/api/chart/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    renderExGroupStats(res);
    renderChart("ex-chart", () => renderExGroupChart(res, spec));
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

function renderExGroupStats(res) {
  const colors = seriesColors();
  const f = (v) => (v == null ? "—" : (Number.isInteger(v) ? fmtNum(v) : Number(v).toPrecision(5)));
  const chips = (res.stats || []).map((s, i) =>
    `<span class="chip"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${colors[i % colors.length]};margin-right:5px;"></span>` +
    `<strong>${esc(s.label)}</strong>: n=${fmtNum(s.count)} 平均 ${f(s.avg)} 中央値 ${f(s.median)} σ ${f(s.std)}</span>`);
  if (res.stats?.length) chips.unshift(`<span class="chip accent">${esc(res.stats[0].column)} の統計 (グループ別)</span>`);
  $("#ex-stats").innerHTML = chips.join(" ");
}

function renderExGroupChart(res, spec) {
  const colors = seriesColors();
  const base = (extra) => baseLayout(Object.assign({ height: 520 }, extra));
  let traces = [], layout;

  if (res.kind === "scatter" || res.kind === "line") {
    const mode = res.kind === "line" ? "lines" : "markers";
    traces = res.series.map((s, i) => ({
      type: "scattergl", mode, name: s.label,
      x: s.x, y: s.y,
      marker: { size: 5, opacity: 0.6, color: colors[i % colors.length] },
      line: { width: 2, color: colors[i % colors.length] },
    }));
    layout = base({
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: spec.x } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: spec.y } }),
      showlegend: true,
      hovermode: res.kind === "line" ? "x unified" : "closest",
    });
  } else if (res.kind === "bar") {
    traces = res.series.map((s, i) => ({
      type: "bar", x: res.categories, y: s.values, name: s.label,
      marker: { color: colors[i % colors.length] },
    }));
    const ylab = spec.agg === "count" ? "件数" :
      spec.agg === "share" ? "割合 (%)" : `${AGG_LABEL[spec.agg]}(${spec.y})`;
    layout = base({
      barmode: "group", bargap: 0.15,
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: spec.x }, type: "category" }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: ylab } }),
      showlegend: true,
    });
  } else if (res.kind === "box") {
    traces = res.series.map((s, i) => ({
      type: "box", x: res.categories, name: s.label,
      q1: s.groups.map((g) => g?.q1 ?? null),
      median: s.groups.map((g) => g?.median ?? null),
      q3: s.groups.map((g) => g?.q3 ?? null),
      lowerfence: s.groups.map((g) => g?.lowerfence ?? null),
      upperfence: s.groups.map((g) => g?.upperfence ?? null),
      mean: s.groups.map((g) => g?.avg ?? null),
      marker: { color: colors[i % colors.length] }, line: { width: 2 }, boxmean: true,
    }));
    layout = base({
      boxmode: "group",
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: spec.x }, type: "category" }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: spec.y } }),
      showlegend: true,
    });
  } else if (res.kind === "histogram") {
    // グループ比較なので常に割合% (N数差を吸収)
    if (res.sub === "numeric") {
      const centers = res.edges.slice(0, -1).map((e, i) => (e + res.edges[i + 1]) / 2);
      traces = res.series.map((s, i) => ({
        type: "bar", x: centers, y: s.percents, name: s.label,
        opacity: res.series.length > 1 ? 0.6 : 1,
        marker: { color: colors[i % colors.length] },
      }));
    } else {
      traces = res.series.map((s, i) => ({
        type: "bar", x: res.labels, y: s.percents, name: s.label,
        marker: { color: colors[i % colors.length] },
      }));
    }
    layout = base({
      barmode: res.sub === "numeric" && res.series.length > 1 ? "overlay" : "group",
      bargap: 0.08,
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: spec.x } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "割合 (%)" } }),
      showlegend: true,
    });
  } else {  // heatmap → グループごとの動作領域を等高線で重ねる
    const cx = res.x_edges.slice(0, -1).map((e, i) => (e + res.x_edges[i + 1]) / 2);
    const cy = res.y_edges.slice(0, -1).map((e, i) => (e + res.y_edges[i + 1]) / 2);
    traces = res.series.map((s, i) => {
      const color = colors[i % colors.length];
      return {
        type: "contour", x: cx, y: cy, z: s.percents || s.matrix, name: s.label,
        showscale: false, showlegend: true,
        colorscale: [[0, color], [1, color]],
        contours: { coloring: "lines" },
        line: { width: 2 },
        ncontours: 8,
        hovertemplate: `${esc(s.label)}<br>${esc(spec.x)}: %{x}<br>${esc(spec.y)}: %{y}<br>密度 %{z:.3f}%<extra></extra>`,
      };
    });
    layout = base({
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: spec.x } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: spec.y } }),
      showlegend: true,
    });
  }
  Plotly.react("ex-chart", traces, layout, PLOT_CONFIG);
}
