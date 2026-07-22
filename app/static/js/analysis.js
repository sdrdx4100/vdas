/* 自由分析タブ: タググループ統計分析。
   ①タグでグループを選ぶ → ②分析の種類を1つ選ぶ → ③最小限の設定 → 結果1枚。
   すべて変更で自動更新。バックエンドは /api/compare/cohorts/* を利用する。 */
import { $, $$, api, toast, debounce, esc, fmtNum } from "./api.js";
import { state } from "./state.js";
import { renderChart, baseLayout, PLOT_CONFIG, seriesColors } from "./charts.js";
import { loadSchema, renderFilters, activeFilters } from "./filters.js";
import { openNameDialog } from "./modals.js";

export const AN_KINDS = {
  summary: {
    hint: "各ログ (データセット) の代表値を1標本として扱う統計です。箱ひげ＋個点で、走行量の長いログに引っ張られない比較ができます。",
    controls: ["signal", "metric"],
  },
  distribution: {
    hint: "全行の分布を共通ビンの割合% で重ねます。正規化「データセット均等」は各ログを同じ重みで平均します。",
    controls: ["signal", "bins", "norm"],
  },
  share: {
    hint: "ギア段・走行モードなどの使用割合を各グループ内 100% に正規化して比較します。N数 (走行量) が違っても公平です。",
    controls: ["col", "norm"],
  },
  region: {
    hint: "X-Y の使用密度をグループごとの等高線で重ねます。例: 車速 × 回転数の動作領域の違い。",
    controls: ["x", "y", "bins", "norm"],
  },
  transitions: {
    hint: "ギア段などの状態変化を遷移イベントとして数え、行数・時間・距離あたりの頻度で比較します。",
    controls: ["tstate", "torder", "tdenom", "tscale", "norm"],
  },
  events: {
    hint: "状態列が指定の値になっている連続区間を1イベントとして抽出し、経過時間を比較します。例: shiftinprocess=1 の区間 = 変速に要した時間。「イベント中の信号」を選ぶと 経過時間 × 信号平均 の散布図になります。",
    controls: ["estate", "evalue", "eorder", "etime", "esignal"],
  },
  regression: {
    hint: "Y ~ X の線形回帰をグループごとに当て、傾き・切片・R² を比較します。例: 車速→回転数の傾きが A社 と B社 でどう違うか。",
    controls: ["rx", "ry"],
  },
  pca: {
    hint: "選んだ信号を標準化して主成分分析し、PC1-PC2 平面へグループを射影します。多次元の走行特性でグループが分離するかを見ます。",
    controls: ["signals"],
  },
  correlation: {
    hint: "グループごとに信号間の相関行列 (ヒートマップ) を出します。信号どうしの関係の違いを比較できます。",
    controls: ["signals"],
  },
};

state.an = state.an || { tags: new Set(), kind: "summary", filters: [], schemas: {}, schema: null };

const anAuto = debounce(() => runAnalysis(true), 600);
state.an.onChange = anAuto;

const fmtVal = (v) => (v == null ? "—" : (Number.isInteger(v) ? fmtNum(v) : Number(v).toPrecision(5)));
const swatch = (color) =>
  `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:6px;"></span>`;

// ---------- ① グループ (タグ) 選択 ----------

export function renderAnalysisTags() {
  const wrap = $("#an-tags");
  state.an.tags = new Set([...state.an.tags].filter((t) => state.tags.includes(t)));
  if (!state.tags.length) {
    wrap.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">タグがまだありません。データ管理タブでタグを付けてください。</span>';
    return;
  }
  wrap.innerHTML = "";
  for (const tag of state.tags) {
    const members = state.datasets.filter((d) => (d.tags || []).includes(tag));
    const chip = document.createElement("button");
    chip.className = "chip clickable" + (state.an.tags.has(tag) ? " on" : "");
    chip.type = "button";
    chip.textContent = `${tag} (${members.length})`;
    chip.disabled = !members.length;
    chip.addEventListener("click", async () => {
      state.an.tags.has(tag) ? state.an.tags.delete(tag) : state.an.tags.add(tag);
      renderAnalysisTags();
      await anRefreshSchema();
      anAuto();
    });
    wrap.appendChild(chip);
  }
}

document.addEventListener("datasets-refreshed", () => {
  renderAnalysisTags();
});

export function anSelectedCohorts() {
  return [...state.an.tags].slice(0, 8).map((tag) => ({ name: tag, tags: [tag], match: "all" }));
}

function anInvolvedIds() {
  return [...new Set(state.datasets
    .filter((d) => (d.tags || []).some((t) => state.an.tags.has(t)))
    .map((d) => d.id))];
}

// 関与する全データセットの共通列からセレクトを構成する
export async function anRefreshSchema() {
  const ids = anInvolvedIds();
  if (!ids.length) {
    state.an.schema = null;
  } else {
    for (const id of ids) {
      if (!state.an.schemas[id]) state.an.schemas[id] = await loadSchema(id);
    }
    const schemas = ids.map((id) => state.an.schemas[id]);
    const common = schemas[0].columns.filter((c) =>
      schemas.every((sc) => sc.columns.some((o) => o.name === c.name && o.kind === c.kind)));
    state.an.schema = { columns: common };
  }
  state.an.filters = state.an.filters.filter(
    (f) => state.an.schema?.columns.some((c) => c.name === f.column));
  renderFilters("#an-filters", state.an);
  anFillColumns();
}

function anFillColumns() {
  const cols = state.an.schema?.columns || [];
  const numeric = cols.filter((c) => c.kind === "numeric");
  const discrete = cols.filter((c) => c.kind !== "temporal");
  const opts = (list) => list.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  const keep = (sel, html, guessRe = null, fallback = null) => {
    const prev = sel.value;
    sel.innerHTML = html;
    if (prev && [...sel.options].some((o) => o.value === prev)) {
      sel.value = prev;
    } else if (guessRe) {
      const hit = [...sel.options].find((o) => guessRe.test(o.value));
      sel.value = hit ? hit.value : (fallback ?? sel.value);
    }
  };
  keep($("#an-signal"), opts(numeric), /speed|km\/?h|車速|rpm|回転/i);
  keep($("#an-col"), opts(discrete), /gear|ギア|mode|モード|cluster|状態/i);
  keep($("#an-x"), opts(numeric), /speed|km\/?h|車速/i);
  keep($("#an-y"), opts(numeric), /rpm|回転/i);
  keep($("#an-tstate"), opts(discrete), /gear|ギア|shift|段|state|状態|mode|モード/i);
  keep($("#an-torder"), opts(cols.filter((c) => c.kind === "numeric" || c.kind === "temporal")),
    /time|timestamp|時刻|時間|elapsed/i);
  keep($("#an-tdenom"), '<option value="">1,000行あたり</option>' + opts(numeric));
  const orderable = cols.filter((c) => c.kind === "numeric" || c.kind === "temporal");
  keep($("#an-estate"), opts(discrete), /shift|inprocess|gear|ギア|state|状態|flag|mode|モード/i);
  keep($("#an-eorder"), opts(orderable), /time|timestamp|時刻|時間|elapsed/i);
  keep($("#an-etime"), opts(orderable), /elapsed|time|timestamp|時刻|時間/i);
  keep($("#an-esignal"), '<option value="">なし (経過時間の分布)</option>' + opts(numeric));
  keep($("#an-rx"), opts(numeric), /speed|km\/?h|車速|throttle|スロットル/i);
  keep($("#an-ry"), opts(numeric), /rpm|回転/i);
  renderAnSignals(numeric);
}

// PCA・相関で使う数値信号のチェックリスト
function renderAnSignals(numeric) {
  const wrap = $("#an-signals");
  const prev = new Set([...wrap.querySelectorAll("input:checked")].map((el) => el.value));
  const preset = prev.size ? prev
    : new Set(numeric.filter((c) => /speed|rpm|throttle|brake|accel|車速|回転/i.test(c.name))
        .slice(0, 5).map((c) => c.name));
  wrap.innerHTML = "";
  for (const c of numeric) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${esc(c.name)}"><span>${esc(c.name)}</span>`;
    const cb = label.querySelector("input");
    cb.checked = preset.has(c.name);
    cb.addEventListener("change", anAuto);
    wrap.appendChild(label);
  }
}

function anSelectedSignals() {
  return [...$("#an-signals").querySelectorAll("input:checked")].map((el) => el.value);
}

// ---------- ② 分析の種類 ----------

export function setAnalysisKind(kind) {
  if (!AN_KINDS[kind]) return;
  state.an.kind = kind;
  $$("#an-kind .chart-kind").forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
  const wanted = new Set(AN_KINDS[kind].controls);
  for (const c of ["signal", "metric", "col", "x", "y", "bins", "tstate", "torder", "tdenom", "tscale",
    "estate", "evalue", "eorder", "etime", "esignal", "rx", "ry", "signals", "norm"]) {
    $(`#an-${c}-wrap`).style.display = wanted.has(c) ? "" : "none";
  }
  $("#an-kind-hint").textContent = AN_KINDS[kind].hint;
}

$$("#an-kind .chart-kind").forEach((btn) => {
  btn.addEventListener("click", () => {
    setAnalysisKind(btn.dataset.kind);
    anAuto();
  });
});

["#an-signal", "#an-metric", "#an-col", "#an-x", "#an-y", "#an-bins",
  "#an-tstate", "#an-torder", "#an-tdenom", "#an-tscale",
  "#an-estate", "#an-evalue", "#an-eorder", "#an-etime", "#an-esignal",
  "#an-rx", "#an-ry", "#an-norm"].forEach((sel) =>
  $(sel).addEventListener("change", anAuto));
$("#an-run").addEventListener("click", () => runAnalysis());

$("#an-add-filter").addEventListener("click", () => {
  if (!state.an.schema) return toast("先にグループのタグを選択してください", "error");
  state.an.filters.push({ column: state.an.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#an-filters", state.an);
});

// タブに入ったとき: タグ未選択なら先頭を自動選択して分析を始める
export async function onAnalysisPageEnter() {
  if (!state.an.tags.size && state.tags.length) {
    const first = state.tags.find((t) => state.datasets.some((d) => (d.tags || []).includes(t)));
    if (first) state.an.tags.add(first);
  }
  renderAnalysisTags();
  await anRefreshSchema();
  anAuto();
}

// ---------- 実行 ----------

function normKey(res) {
  // レスポンス側のキー名: 分布/構成比/動作領域は *_percents、遷移は *_rates
  const mean = $("#an-norm").value !== "pooled";
  return {
    percents: mean ? "mean_dataset_percents" : "pooled_percents",
    rates: mean ? "mean_dataset_rates" : "pooled_rates",
  };
}

export async function runAnalysis(auto = false) {
  const cohorts = anSelectedCohorts();
  if (!cohorts.length) return auto || toast("グループのタグを1つ以上選択してください", "error");
  const kind = state.an.kind;
  const filters = activeFilters(state.an);
  const post = (path, body) => api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cohorts, filters, ...body }),
  });
  try {
    $("#an-table-wrap").hidden = true;
    if (kind === "summary") {
      const res = await post("/api/compare/cohorts/summary",
        { column: $("#an-signal").value, metric: $("#an-metric").value });
      renderGroupChips(res);
      renderSummaryResult(res);
    } else if (kind === "distribution") {
      const res = await post("/api/compare/cohorts/histogram",
        { column: $("#an-signal").value, bins: +$("#an-bins").value || 40 });
      renderGroupChips(res);
      renderDistributionResult(res);
    } else if (kind === "share") {
      const res = await post("/api/compare/cohorts/histogram",
        { column: $("#an-col").value, as_category: true });
      renderGroupChips(res);
      renderShareResult(res);
    } else if (kind === "region") {
      const bins = Math.min(+$("#an-bins").value || 40, 100);
      const res = await post("/api/compare/cohorts/histogram2d",
        { x: $("#an-x").value, y: $("#an-y").value, bins_x: bins, bins_y: bins });
      renderGroupChips(res);
      renderRegionResult(res);
    } else if (kind === "transitions") {
      const res = await post("/api/compare/cohorts/transitions", {
        state_column: $("#an-tstate").value,
        order_by: $("#an-torder").value,
        denominator_column: $("#an-tdenom").value || null,
        denominator_scale: +$("#an-tscale").value || 1,
      });
      renderGroupChips(res);
      renderTransitionsResult(res);
    } else if (kind === "events") {
      const res = await post("/api/compare/cohorts/events", {
        state_column: $("#an-estate").value,
        value: $("#an-evalue").value,
        order_by: $("#an-eorder").value,
        time_column: $("#an-etime").value || null,
        secondary_column: $("#an-esignal").value || null,
      });
      renderGroupChips(res);
      renderEventsResult(res);
    } else if (kind === "regression") {
      const res = await post("/api/compare/cohorts/regression",
        { x: $("#an-rx").value, y: $("#an-ry").value });
      renderGroupChips(res);
      renderRegressionResult(res);
    } else if (kind === "pca") {
      const signals = anSelectedSignals();
      if (signals.length < 2) return auto || toast("PCAには信号を2つ以上選んでください", "error");
      const res = await post("/api/compare/cohorts/pca", { columns: signals });
      renderGroupChips(res);
      renderPcaResult(res);
    } else {
      const signals = anSelectedSignals();
      const res = await post("/api/compare/cohorts/correlation",
        signals.length >= 2 ? { columns: signals } : {});
      renderGroupChips(res);
      renderCorrelationResult(res);
    }
  } catch (e) {
    toast(`分析エラー: ${e.message}`, "error");
  }
}

// ---------- 結果描画 ----------

function renderGroupChips(res) {
  const colors = seriesColors();
  const chips = (res.cohorts || []).map((c, i) =>
    `<span class="chip">${swatch(colors[i % colors.length])}<strong>${esc(c.name)}</strong>` +
    ` ${c.dataset_count} ログ / ${fmtNum(c.row_count)} 行</span>`);
  if (res.overlaps?.length) {
    chips.push(`<span class="chip" style="color:var(--danger);">⚠ ${res.overlaps.length} ログが複数グループに所属</span>`);
  }
  $("#an-stats").innerHTML = chips.join(" ");
}

const METRIC_LABEL = { avg: "平均", q50: "中央値", q75: "Q75" };

function renderSummaryResult(res) {
  const colors = seriesColors();
  renderChart("an-chart", () => {
    const traces = res.cohorts.map((c, i) => ({
      type: "box", name: c.name,
      y: c.values,
      boxpoints: "all", jitter: 0.4, pointpos: 0,
      boxmean: true,
      marker: { color: colors[i % colors.length], size: 7, opacity: 0.75 },
      line: { width: 2 },
      text: c.datasets.map((d) => d.dataset_name),
      hovertemplate: `%{text}<br>${METRIC_LABEL[res.metric]}(${esc(res.column)}) = %{y}<extra>%{fullData.name}</extra>`,
    }));
    Plotly.react("an-chart", traces, baseLayout({
      height: 480,
      yaxis: Object.assign(baseLayout().yaxis,
        { title: { text: `ログごとの${METRIC_LABEL[res.metric]}(${res.column})` } }),
      xaxis: Object.assign(baseLayout().xaxis, { type: "category" }),
      showlegend: false,
    }), PLOT_CONFIG);
  });

  // 統計テーブル: グループごとの要約 + 基準グループとの差・効果量
  const head = ["グループ", "ログ数", "平均", "σ", "最小", "中央値", "最大"];
  const rows = res.cohorts.map((c, i) => {
    const s = c.summary;
    return `<tr><td>${swatch(colors[i % colors.length])}<strong>${esc(c.name)}</strong></td>` +
      `<td class="num">${s.n}</td><td class="num">${fmtVal(s.mean)}</td><td class="num">${fmtVal(s.std)}</td>` +
      `<td class="num">${fmtVal(s.min)}</td><td class="num">${fmtVal(s.median)}</td><td class="num">${fmtVal(s.max)}</td></tr>`;
  });
  for (const cmp of res.comparisons || []) {
    const d = cmp.difference;
    const pct = cmp.difference_percent;
    const ci = cmp.ci95 ? ` [95%CI ${fmtVal(cmp.ci95[0])} 〜 ${fmtVal(cmp.ci95[1])}]` : "";
    const strength = cmp.hedges_g == null ? "" :
      ` / 効果量 g=${fmtVal(cmp.hedges_g)}${Math.abs(cmp.hedges_g) >= 0.8 ? " (大)" : Math.abs(cmp.hedges_g) >= 0.5 ? " (中)" : " (小)"}`;
    const pval = (label, v) => v == null ? "" :
      ` / ${label} p=${v < 0.001 ? "<0.001" : fmtVal(v)}${v < 0.05 ? " ✓有意" : ""}`;
    const tests = pval("t検定", cmp.t_test_p) + pval("MW", cmp.mann_whitney_p);
    rows.push(`<tr><td colspan="7" style="color:var(--text-secondary);">Δ ${esc(cmp.comparison)} − ${esc(cmp.baseline)}: ` +
      `<strong>${fmtVal(d)}</strong>${pct != null ? ` (${pct > 0 ? "+" : ""}${fmtVal(pct)}%)` : ""}${ci}${strength}${tests}</td></tr>`);
  }
  $("#an-table thead").innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  $("#an-table tbody").innerHTML = rows.join("");
  $("#an-table-wrap").hidden = false;
}

function renderDistributionResult(res) {
  const colors = seriesColors();
  const key = normKey(res).percents;
  renderChart("an-chart", () => {
    let traces;
    if (res.kind === "numeric") {
      const centers = res.edges.slice(0, -1).map((e, i) => (e + res.edges[i + 1]) / 2);
      traces = res.cohorts.map((c, i) => ({
        type: "bar", x: centers, y: c[key], name: c.name,
        opacity: res.cohorts.length > 1 ? 0.6 : 1,
        marker: { color: colors[i % colors.length] },
      }));
    } else {
      traces = res.cohorts.map((c, i) => ({
        type: "bar", x: res.labels, y: c[key], name: c.name,
        marker: { color: colors[i % colors.length] },
      }));
    }
    Plotly.react("an-chart", traces, baseLayout({
      height: 480,
      barmode: res.kind === "numeric" && res.cohorts.length > 1 ? "overlay" : "group",
      bargap: 0.08,
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: res.column } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "割合 (%)" } }),
      showlegend: res.cohorts.length > 1,
    }), PLOT_CONFIG);
  });
}

function renderShareResult(res) {
  const colors = seriesColors();
  const key = normKey(res).percents;
  renderChart("an-chart", () => {
    const traces = res.cohorts.map((c, i) => ({
      type: "bar", x: res.labels, y: c[key], name: c.name,
      marker: { color: colors[i % colors.length] },
      hovertemplate: `${esc(res.column)}=%{x}<br>%{y:.2f}%<extra>%{fullData.name}</extra>`,
    }));
    Plotly.react("an-chart", traces, baseLayout({
      height: 480,
      barmode: "group", bargap: 0.15,
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: res.column }, type: "category" }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: "割合 (%)" } }),
      showlegend: res.cohorts.length > 1,
    }), PLOT_CONFIG);
  });
}

function renderRegionResult(res) {
  const colors = seriesColors();
  const key = normKey(res).percents;
  renderChart("an-chart", () => {
    const cx = res.x_edges.slice(0, -1).map((e, i) => (e + res.x_edges[i + 1]) / 2);
    const cy = res.y_edges.slice(0, -1).map((e, i) => (e + res.y_edges[i + 1]) / 2);
    const traces = res.cohorts.map((c, i) => {
      const color = colors[i % colors.length];
      return {
        type: "contour", x: cx, y: cy, z: c[key], name: c.name,
        showscale: false, showlegend: true,
        colorscale: [[0, color], [1, color]],
        contours: { coloring: "lines" },
        line: { width: 2 }, ncontours: 8,
        hovertemplate: `${esc(c.name)}<br>${esc(res.x)}: %{x}<br>${esc(res.y)}: %{y}<br>%{z:.3f}%<extra></extra>`,
      };
    });
    Plotly.react("an-chart", traces, baseLayout({
      height: 520,
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: res.x } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: res.y } }),
      showlegend: true,
    }), PLOT_CONFIG);
  });
}

function renderTransitionsResult(res) {
  const colors = seriesColors();
  const key = normKey(res).rates;
  const unit = res.rate.kind === "rows"
    ? "1,000行あたり"
    : `${esc(res.rate.denominator_column)} ${fmtNum(res.rate.scale)} あたり`;
  renderChart("an-chart", () => {
    const traces = res.cohorts.map((c, i) => ({
      type: "bar", x: res.transitions, y: c[key], name: c.name,
      marker: { color: colors[i % colors.length] },
    }));
    Plotly.react("an-chart", traces, baseLayout({
      height: 480,
      barmode: "group", bargap: 0.15,
      xaxis: Object.assign(baseLayout().xaxis,
        { title: { text: `${res.state_column} 遷移` }, type: "category" }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: `頻度 (${unit})` } }),
      showlegend: res.cohorts.length > 1,
    }), PLOT_CONFIG);
  });
}

function renderEventsResult(res) {
  const colors = seriesColors();
  const secondary = res.secondary_column;
  renderChart("an-chart", () => {
    let traces;
    if (secondary) {
      // 経過時間 × イベント中の信号平均 の散布図
      traces = res.cohorts.map((c, i) => ({
        type: "scattergl", mode: "markers", name: c.name,
        x: c.durations, y: c.secondary_values,
        marker: { color: colors[i % colors.length], size: 7, opacity: 0.7 },
        hovertemplate: `経過 %{x:.3f}<br>${esc(secondary)} 平均 %{y}<extra>%{fullData.name}</extra>`,
      }));
    } else {
      traces = res.cohorts.map((c, i) => ({
        type: "box", name: c.name, y: c.durations,
        boxpoints: c.durations.length <= 400 ? "all" : "outliers",
        jitter: 0.4, pointpos: 0, boxmean: true,
        marker: { color: colors[i % colors.length], size: 5, opacity: 0.6 },
        line: { width: 2 },
      }));
    }
    Plotly.react("an-chart", traces, baseLayout({
      height: 480,
      xaxis: Object.assign(baseLayout().xaxis, secondary
        ? { title: { text: `イベント経過時間 (${res.time_column})` } }
        : { type: "category" }),
      yaxis: Object.assign(baseLayout().yaxis, {
        title: { text: secondary ? `イベント中の ${secondary} 平均`
          : `${res.state_column}=${res.value} の経過時間 (${res.time_column})` },
      }),
      showlegend: !!secondary && res.cohorts.length > 1,
    }), PLOT_CONFIG);
  });

  const head = ["グループ", "イベント数", "1,000行あたり", "平均", "中央値", "P90", "最大"];
  $("#an-table thead").innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  $("#an-table tbody").innerHTML = res.cohorts.map((c, i) => {
    const s2 = c.summary;
    return `<tr><td>${swatch(colors[i % colors.length])}<strong>${esc(c.name)}</strong></td>` +
      `<td class="num">${fmtNum(c.event_count)}</td>` +
      `<td class="num">${fmtVal(c.events_per_1k_rows)}</td>` +
      `<td class="num">${fmtVal(s2.mean)}</td><td class="num">${fmtVal(s2.median)}</td>` +
      `<td class="num">${fmtVal(s2.p90)}</td><td class="num">${fmtVal(s2.max)}</td></tr>`;
  }).join("");
  $("#an-table-wrap").hidden = false;
}

function renderRegressionResult(res) {
  const colors = seriesColors();
  renderChart("an-chart", () => {
    const traces = [];
    res.cohorts.forEach((c, i) => {
      const color = colors[i % colors.length];
      traces.push({
        type: "scattergl", mode: "markers", name: c.name,
        x: c.x, y: c.y, legendgroup: c.name,
        marker: { color, size: 5, opacity: 0.5 },
      });
      if (c.fit) {
        traces.push({
          type: "scatter", mode: "lines", name: `${c.name} 回帰`,
          x: c.fit.x, y: c.fit.y, legendgroup: c.name, showlegend: false,
          line: { color, width: 3 },
        });
      }
    });
    Plotly.react("an-chart", traces, baseLayout({
      height: 480,
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: res.x } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: res.y } }),
      showlegend: true,
    }), PLOT_CONFIG);
  });
  const head = ["グループ", "傾き", "切片", "R²", "n"];
  $("#an-table thead").innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  $("#an-table tbody").innerHTML = res.cohorts.map((c, i) =>
    `<tr><td>${swatch(colors[i % colors.length])}<strong>${esc(c.name)}</strong></td>` +
    `<td class="num">${fmtVal(c.slope)}</td><td class="num">${fmtVal(c.intercept)}</td>` +
    `<td class="num">${fmtVal(c.r2)}</td><td class="num">${fmtNum(c.n)}</td></tr>`).join("");
  $("#an-table-wrap").hidden = false;
}

function renderPcaResult(res) {
  const colors = seriesColors();
  const [v1, v2] = res.explained_variance;
  renderChart("an-chart", () => {
    const traces = res.cohorts.map((c, i) => ({
      type: "scattergl", mode: "markers", name: c.name,
      x: c.pc1, y: c.pc2,
      marker: { color: colors[i % colors.length], size: 5, opacity: 0.5 },
    }));
    Plotly.react("an-chart", traces, baseLayout({
      height: 520,
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: `PC1 (${(v1 * 100).toFixed(1)}%)` } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: `PC2 (${(v2 * 100).toFixed(1)}%)` } }),
      showlegend: true,
    }), PLOT_CONFIG);
  });
  // ローディング (各信号の寄与) をテーブルに
  const head = ["信号", "PC1 寄与", "PC2 寄与"];
  $("#an-table thead").innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  $("#an-table tbody").innerHTML = res.loadings.map((l) =>
    `<tr><td><strong>${esc(l.column)}</strong></td>` +
    `<td class="num">${fmtVal(l.pc1)}</td><td class="num">${fmtVal(l.pc2)}</td></tr>`).join("");
  $("#an-table-wrap").hidden = false;
}

const CORR_SCALE = [[0, "#104281"], [0.25, "#5598e7"], [0.5, "#f0efec"], [0.75, "#e88a8a"], [1, "#c03434"]];

function renderCorrelationResult(res) {
  // グループごとにヒートマップを横並び (サブプロット)
  const n = res.cohorts.length;
  renderChart("an-chart", () => {
    const traces = res.cohorts.map((c, i) => ({
      type: "heatmap", z: c.matrix, x: res.columns, y: res.columns,
      xaxis: i === 0 ? "x" : `x${i + 1}`, yaxis: i === 0 ? "y" : `y${i + 1}`,
      zmin: -1, zmax: 1, colorscale: CORR_SCALE, showscale: i === n - 1,
      colorbar: { title: { text: "r" }, len: 0.9, outlinewidth: 0 },
      hovertemplate: `${esc(c.name)}<br>%{y} × %{x}<br>r = %{z}<extra></extra>`,
      xgap: 1, ygap: 1,
    }));
    const layout = baseLayout({
      height: 460,
      margin: { l: 90, r: 20, t: 40, b: 90 },
      grid: { rows: 1, columns: n, pattern: "independent" },
    });
    delete layout.xaxis; delete layout.yaxis;
    res.cohorts.forEach((c, i) => {
      const sx = i === 0 ? "xaxis" : `xaxis${i + 1}`;
      const sy = i === 0 ? "yaxis" : `yaxis${i + 1}`;
      layout[sx] = { tickangle: -45, tickfont: { size: 9 },
        title: { text: c.name, font: { size: 12 } }, side: "bottom" };
      layout[sy] = { autorange: "reversed", tickfont: { size: 9 } };
    });
    Plotly.react("an-chart", traces, layout, PLOT_CONFIG);
  });
  $("#an-table-wrap").hidden = true;
}

// ---------- ビュー保存 ----------

$("#an-save-view").addEventListener("click", async () => {
  if (!state.an.tags.size) return toast("グループのタグを選択してください", "error");
  const name = await openNameDialog("自由分析ビューを保存");
  if (!name) return;
  await api("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, kind: "compare", dataset_id: null,
      config: {
        v2: true,
        tags: [...state.an.tags],
        analysis: state.an.kind,
        signal: $("#an-signal").value,
        metric: $("#an-metric").value,
        col: $("#an-col").value,
        x: $("#an-x").value, y: $("#an-y").value,
        bins: +$("#an-bins").value || 40,
        tstate: $("#an-tstate").value, torder: $("#an-torder").value,
        tdenom: $("#an-tdenom").value || null, tscale: +$("#an-tscale").value || 1,
        estate: $("#an-estate").value, evalue: $("#an-evalue").value,
        eorder: $("#an-eorder").value, etime: $("#an-etime").value,
        esignal: $("#an-esignal").value || null,
        rx: $("#an-rx").value, ry: $("#an-ry").value,
        signals: anSelectedSignals(),
        norm: $("#an-norm").value,
        filters: activeFilters(state.an),
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});

export async function loadAnalysisView(view) {
  const c = view.config || {};
  if (!c.v2) {
    // 旧形式 (再設計前) のビュー: タグ情報があればそれだけ復元する
    const tags = c.tags || c.group_tags ||
      (c.cohorts || []).flatMap((sp) => sp.tags || []);
    state.an.tags = new Set((tags || []).filter((t) => state.tags.includes(t)));
    toast("旧形式のビューのため、グループ選択のみ復元しました", "error");
  } else {
    state.an.tags = new Set((c.tags || []).filter((t) => state.tags.includes(t)));
  }
  renderAnalysisTags();
  await anRefreshSchema();
  if (c.v2) {
    setAnalysisKind(c.analysis || "summary");
    const setIf = (sel, val) => {
      if (val && [...$(sel).options].some((o) => o.value === val)) $(sel).value = val;
    };
    setIf("#an-signal", c.signal);
    if (c.metric) $("#an-metric").value = c.metric;
    setIf("#an-col", c.col);
    setIf("#an-x", c.x);
    setIf("#an-y", c.y);
    if (c.bins) $("#an-bins").value = c.bins;
    setIf("#an-tstate", c.tstate);
    setIf("#an-torder", c.torder);
    setIf("#an-estate", c.estate);
    if (c.evalue != null) $("#an-evalue").value = c.evalue;
    setIf("#an-eorder", c.eorder);
    setIf("#an-etime", c.etime);
    if (c.esignal != null) setIf("#an-esignal", c.esignal);
    setIf("#an-rx", c.rx);
    setIf("#an-ry", c.ry);
    if (Array.isArray(c.signals) && c.signals.length) {
      $("#an-signals").querySelectorAll("input").forEach((el) => {
        el.checked = c.signals.includes(el.value);
      });
    }
    if (c.tdenom != null) setIf("#an-tdenom", c.tdenom);
    if (c.tscale) $("#an-tscale").value = c.tscale;
    if (c.norm) $("#an-norm").value = c.norm === "pooled" ? "pooled" : "mean";
    state.an.filters = (c.filters || []).map((f) => ({ ...f }));
    renderFilters("#an-filters", state.an);
  } else {
    setAnalysisKind("summary");
  }
  runAnalysis(true);
}

// 初期表示
setAnalysisKind(state.an.kind);
