/* 比較可視化タブ: データセット横断の統計比較 (分布・CDF・グループ別・特性カーブ・差分ランキング) */
import { $, $$, api, toast, debounce, esc } from "./api.js";
import { state } from "./state.js";
import { loadSchema, renderFilters, activeFilters } from "./filters.js";
import { seriesColors, baseLayout, PLOT_CONFIG, renderChart, chartRegistry } from "./charts.js";
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

export async function updateCmpColumns() {
  const ids = cmpSelectedIds();
  const sigSel = $("#cmp-signal"), grpSel = $("#cmp-groupby");
  const baseSel = $("#cmp-baseline"), cxSel = $("#cmp-curve-x"), cySel = $("#cmp-curve-y");
  if (!ids.length) {
    sigSel.innerHTML = ""; grpSel.innerHTML = '<option value="">なし (全体のみ)</option>';
    baseSel.innerHTML = ""; cxSel.innerHTML = ""; cySel.innerHTML = "";
    state.cmp.schema = null;
    return;
  }

  for (const id of ids) {
    if (!state.cmp.schemas[id]) state.cmp.schemas[id] = await loadSchema(id);
  }
  // 現在の選択値は await 後に読む (読み込み中にユーザーが変更した値を潰さないため)
  const prevSig = sigSel.value, prevGrp = grpSel.value, prevBase = baseSel.value;
  const prevCx = cxSel.value, prevCy = cySel.value;
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
}

$("#cmp-add-filter").addEventListener("click", () => {
  if (!state.cmp.schema) return toast("先にデータセットを2つ以上選択してください", "error");
  state.cmp.filters.push({ column: state.cmp.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#cmp-filters", state.cmp);
});

const cmpAutoRun = debounce(() => runCompare(true), 600);
state.cmp.onChange = cmpAutoRun;

$("#cmp-plot").addEventListener("click", () => runCompare());
["#cmp-signal", "#cmp-groupby", "#cmp-baseline"].forEach((sel) =>
  $(sel).addEventListener("change", cmpAutoRun));
$("#cmp-curve-x").addEventListener("change", () => plotCmpCurve().catch(() => {}));
$("#cmp-curve-y").addEventListener("change", () => plotCmpCurve().catch(() => {}));

// 比較タブを開いたとき、未選択ならデータセットを自動で選んで比較を始める
export function autoSelectCmpDatasets() {
  if (cmpSelectedIds().length >= 2) return;
  const boxes = $$("#cmp-datasets input");
  if (boxes.length < 2) return;
  boxes.slice(0, 2).forEach((el) => { el.checked = true; });
  updateCmpColumns().then(cmpAutoRun);
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
  if (ids.length < 2) return toast("データセットを2つ以上選択してください", "error");
  const name = await openNameDialog("比較ビューを保存");
  if (!name) return;
  await api("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, kind: "compare", dataset_id: null,
      config: {
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
