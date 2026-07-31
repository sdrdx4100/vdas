/* 時系列比較タブ: 2走行の信号を、時刻が違っても同じ条件(整列軸)に揃えて重ねる。
   横軸(整列軸)を「基準信号」または「時間+手動オフセット」から選べる。 */
import { $, $$, api, toast, debounce, fmtNum, esc, dsOptionLabel } from "./api.js";
import { state } from "./state.js";
import { loadSchema, columnOptions, renderFilters, activeFilters } from "./filters.js";
import { seriesColors, baseLayout, PLOT_CONFIG, renderChart, chartRegistry, cssVar } from "./charts.js";
import { loadAliases, openAliasManager, resolveColumn } from "./aliases.js";

$("#tc-alias-manage").addEventListener("click", () => openAliasManager());
loadAliases();

const tcAuto = debounce(() => plot(true), 500);
state.tc.onChange = tcAuto;
let selected = new Set();
let tcReq = 0;

// ---------- データセット選択肢の同期 ----------

document.addEventListener("datasets-refreshed", () => {
  fillSel($("#tc-dataset-a"), "— 走行A を選択 —");
  fillSel($("#tc-dataset-b"), "なし (1走行のみ)");
});

function fillSel(sel, placeholder) {
  const prev = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    state.datasets.map((d) => `<option value="${d.id}">${dsOptionLabel(d)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function datasetName(id) {
  return state.datasets.find((d) => d.id === id)?.name || id;
}

function schemaCols(schema) {
  return new Map((schema?.columns || []).map((c) => [c.name, c]));
}

export function onTscomparePageEnter() {
  const a = $("#tc-dataset-a");
  if (!a.value && state.datasets.length) a.value = state.datasets[0].id;
  if (a.value && state.tc.schemaA?.dataset?.id !== a.value) a.dispatchEvent(new Event("change"));
}

// ---------- 走行の選択 ----------

$("#tc-dataset-a").addEventListener("change", async () => {
  tcReq += 1;
  state.tc.schemaA = await loadSchema($("#tc-dataset-a").value);
  state.tc.filters = [];
  selected = new Set();
  renderFilters("#tc-filters", state.tc);
  renderCols();
  fillXOptions();
  autoPickSignals();
  plot(true);
});

$("#tc-dataset-b").addEventListener("change", async () => {
  const id = $("#tc-dataset-b").value;
  state.tc.schemaB = id ? await loadSchema(id) : null;
  plot(true);
});

$("#tc-xmode").addEventListener("change", () => {
  applyXModeVisibility();
  tcAuto();
});
$("#tc-xref").addEventListener("change", tcAuto);
$("#tc-xtime").addEventListener("change", tcAuto);
$("#tc-offset").addEventListener("change", tcAuto);
$("#tc-maxpoints").addEventListener("change", tcAuto);
$("#tc-plot").addEventListener("click", () => plot());

function applyXModeVisibility() {
  const ref = $("#tc-xmode").value === "ref";
  $("#tc-xref-wrap").hidden = !ref;
  $("#tc-xtime-wrap").hidden = ref;
  $("#tc-offset-wrap").hidden = ref;
}

function fillXOptions() {
  const schema = state.tc.schemaA;
  $("#tc-xref").innerHTML = columnOptions(schema, { numericOnly: true });
  $("#tc-xtime").innerHTML = columnOptions(schema);
  if (!schema) return;
  // 時間軸らしい列を既定に
  const cols = schema.columns;
  const guessTime = cols.find((c) => c.kind === "temporal") ||
    cols.find((c) => /time|date|timestamp|時刻|時間/i.test(c.name)) || cols[0];
  if (guessTime) $("#tc-xtime").value = guessTime.name;
  // 基準信号は速度らしい列を既定に
  const numeric = cols.filter((c) => c.kind === "numeric");
  const guessRef = numeric.find((c) => /speed|km\/?h|車速/i.test(c.name)) ||
    numeric.find((c) => /rpm|回転/i.test(c.name)) || numeric[0];
  if (guessRef) $("#tc-xref").value = guessRef.name;
  applyXModeVisibility();
}

// ---------- 比較信号の選択 ----------

function renderCols() {
  const wrap = $("#tc-cols");
  wrap.innerHTML = "";
  if (!state.tc.schemaA) return;
  const q = $("#tc-col-search").value.trim().toLowerCase();
  for (const c of state.tc.schemaA.columns) {
    if (c.kind !== "numeric") continue;
    if (q && !c.name.toLowerCase().includes(q)) continue;
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${esc(c.name)}"><span>${esc(c.name)}</span><span class="col-type">${esc(c.type)}</span>`;
    label.querySelector("input").checked = selected.has(c.name);
    wrap.appendChild(label);
  }
  updateSummary();
}

$("#tc-col-search").addEventListener("input", renderCols);

$("#tc-cols").addEventListener("change", (event) => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  input.checked ? selected.add(input.value) : selected.delete(input.value);
  updateSummary();
  tcAuto();
});

function selectedList(schema) {
  return (schema?.columns || [])
    .filter((c) => c.kind === "numeric" && selected.has(c.name))
    .map((c) => c.name);
}

function autoPickSignals() {
  const schema = state.tc.schemaA;
  if (!schema) return;
  const xref = $("#tc-xref").value;
  const numeric = schema.columns.filter((c) => c.kind === "numeric" && c.name !== xref);
  const picks = [];
  for (const re of [/speed|km\/?h|車速/i, /rpm|回転/i]) {
    const hit = numeric.find((c) => re.test(c.name) && !picks.includes(c.name));
    if (hit) picks.push(hit.name);
  }
  for (const c of numeric) {
    if (picks.length >= 2) break;
    if (!picks.includes(c.name)) picks.push(c.name);
  }
  selected = new Set(picks);
  $$("#tc-cols input").forEach((el) => { el.checked = selected.has(el.value); });
  updateSummary();
}

function updateSummary() {
  const s = $("#tc-selection-summary");
  if (s) s.textContent = `${selected.size} 信号選択中`;
}

$("#tc-clear-selection").addEventListener("click", () => {
  selected = new Set();
  $$("#tc-cols input").forEach((el) => { el.checked = false; });
  updateSummary();
  tcAuto();
});

$("#tc-add-filter").addEventListener("click", () => {
  if (!state.tc.schemaA) return toast("先に走行Aを選択してください", "error");
  state.tc.filters.push({ column: state.tc.schemaA.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#tc-filters", state.tc);
});

// ---------- 描画 ----------

async function fetchRun(id, schema, xcol, signals, filters, maxPoints) {
  const cols = schemaCols(schema);
  const ys = signals.filter((s) => cols.get(s)?.kind === "numeric");
  const flt = filters.filter((f) => cols.has(f.column));
  return api(`/api/datasets/${id}/timeseries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: xcol, ys: ys.length ? ys : [signals[0]], filters: flt, max_points: maxPoints }),
  });
}

async function plot(auto = false) {
  const aId = $("#tc-dataset-a").value;
  if (!aId) return auto || toast("走行A を選択してください", "error");
  const mode = $("#tc-xmode").value;
  const xcol = mode === "ref" ? $("#tc-xref").value : $("#tc-xtime").value;
  if (!xcol) return auto || toast("横軸の列を選択してください", "error");
  const signals = selectedList(state.tc.schemaA);
  if (!signals.length) return auto || toast("比較する信号を1つ以上選択してください", "error");

  const bId = $("#tc-dataset-b").value;
  const filters = activeFilters(state.tc);
  const maxPoints = +$("#tc-maxpoints").value || 5000;
  const runs = [{ id: aId, schema: state.tc.schemaA, label: datasetName(aId), primary: true }];
  if (bId && bId !== aId) runs.push({ id: bId, schema: state.tc.schemaB, label: datasetName(bId), primary: false });

  const req = ++tcReq;
  setLoading(true);
  try {
    const aliasList = await loadAliases();
    const results = [];
    for (const r of runs) {
      const rColSet = new Set(schemaCols(r.schema).keys());
      // 列名がAと完全一致しなくても、エイリアスで同じ意味と分かっていれば
      // その走行の実列名で要求し、結果はAの列名(canonical)に戻して統一する。
      const rXcol = resolveColumn(xcol, rColSet, aliasList);
      if (!rXcol) {
        if (r.primary) throw new Error(`横軸の列「${xcol}」が走行Aにありません`);
        toast(`走行Bに列「${xcol}」に対応する列が無いため重ねられません`, "error");
        continue;
      }
      const nameMap = new Map();  // 実列名 -> 表示名 (Aで選んだ列名)
      const rSignals = [];
      for (const s of signals) {
        const resolved = resolveColumn(s, rColSet, aliasList);
        if (resolved) { rSignals.push(resolved); nameMap.set(resolved, s); }
      }
      if (!rSignals.length) {
        if (r.primary) throw new Error("比較する信号に対応する列がありません");
        toast("走行Bに対応する信号が無いため重ねられません", "error");
        continue;
      }
      const rFilters = filters
        .map((f) => {
          const resolved = resolveColumn(f.column, rColSet, aliasList);
          return resolved ? { ...f, column: resolved } : null;
        })
        .filter(Boolean);
      try {
        const res = await fetchRun(r.id, r.schema, rXcol, rSignals, rFilters, maxPoints);
        const data = {};
        for (const [key, values] of Object.entries(res.data)) {
          data[nameMap.get(key) || key] = values;
        }
        data[xcol] = res.data[rXcol];
        results.push({ ...r, res: { ...res, data } });
      } catch (e) {
        if (r.primary) throw e;
        toast(`走行Bを重ねられません: ${e.message}`, "error");
      }
    }
    if (req !== tcReq) return;
    if (!results.length) return;
    renderMeta(results, xcol, mode);
    renderChart("tc-chart", () => renderOverlay(results, signals, xcol, mode));
  } catch (e) {
    if (req === tcReq) {
      toast(`エラー: ${e.message}`, "error");
      Plotly.purge("tc-chart");
      chartRegistry.delete("tc-chart");
    }
  } finally {
    if (req === tcReq) setLoading(false);
  }
}

function setLoading(loading) {
  const b = $("#tc-plot");
  b.disabled = loading;
  b.textContent = loading ? "更新中…" : "🔄 更新";
  $("#tc-chart").setAttribute("aria-busy", String(loading));
}

function renderMeta(results, xcol, mode) {
  const colors = seriesColors();
  const axisLabel = mode === "ref" ? `横軸: ${esc(xcol)} (基準信号)` :
    `横軸: ${esc(xcol)} (時間, Bオフセット ${(+$("#tc-offset").value || 0)})`;
  const chips = results.map((r, i) =>
    `<span class="chip" style="border-left:3px solid ${colors[i]};">${esc(r.label)} — ${fmtNum(r.res.returned_rows)}点</span>`).join(" ");
  $("#tc-meta").innerHTML = `${chips} <span class="chip">${axisLabel}</span>`;
}

// Bの時間オフセットを適用したX配列 (数値のみ・ref整列では無効)
function xValues(run, xcol, mode) {
  const base = run.res.data[xcol] || [];
  if (mode !== "ref" && !run.primary) {
    const off = +$("#tc-offset").value || 0;
    if (off) return base.map((v) => (typeof v === "number" ? v + off : v));
  }
  return base;
}

// 信号ごとに帯を積み重ね、各帯に走行A/Bを色分けで重ねる (X軸=整列軸を共有)
function renderOverlay(results, signals, xcol, mode) {
  const panels = signals;
  const k = panels.length;
  const colors = seriesColors();
  const chartHeight = Math.max(480, 150 * k + 90);
  const gap = Math.min(0.03, 0.12 / k);
  const bandH = (1 - gap * (k - 1)) / k;
  const headerH = Math.min(26 / chartHeight, bandH * 0.32);

  const layout = baseLayout({
    height: chartHeight,
    showlegend: results.length > 1,
    legend: { orientation: "h", y: 1.03, x: 0, bgcolor: "transparent" },
    hovermode: "x unified",
    margin: { l: 64, r: 20, t: results.length > 1 ? 34 : 24, b: 44 },
    annotations: [],
  });
  const gridStyle = layout.yaxis;
  delete layout.yaxis;

  const traces = [];
  panels.forEach((sig, i) => {
    const yaxis = i === 0 ? "y" : `y${i + 1}`;
    results.forEach((run, j) => {
      if (!(sig in run.res.data)) return;  // その走行に無い信号はスキップ
      traces.push({
        type: "scattergl", mode: "lines", name: run.label,
        legendgroup: run.label, showlegend: results.length > 1 && i === 0,
        x: xValues(run, xcol, mode), y: run.res.data[sig], yaxis,
        line: { width: 2, color: colors[j] },
        hovertemplate: `%{y}<extra>${esc(run.label)} · ${esc(sig)}</extra>`,
      });
    });
    const top = 1 - i * (bandH + gap);
    const bottom = Math.max(0, top - bandH);
    layout[i === 0 ? "yaxis" : `yaxis${i + 1}`] = Object.assign({}, gridStyle, {
      domain: [bottom, Math.max(bottom + 0.01, top - headerH)], tickfont: { size: 10 },
    });
    layout.annotations.push({
      xref: "paper", yref: "paper", x: 0, y: top, xanchor: "left", yanchor: "top",
      showarrow: false, align: "left", text: `<b>${wrapLabel(sig)}</b>`,
      font: { size: 11, color: cssVar("--text-secondary") },
    });
  });
  layout.xaxis = Object.assign(layout.xaxis, {
    domain: [0, 1], anchor: k === 1 ? "y" : `y${k}`, title: { text: xcol },
  });
  Plotly.react("tc-chart", traces, layout, PLOT_CONFIG);
}

function wrapLabel(label, lineLength = 48) {
  const chars = Array.from(label);
  const lines = [];
  for (let i = 0; i < chars.length; i += lineLength) lines.push(esc(chars.slice(i, i + lineLength).join("")));
  return lines.join("<br>");
}
