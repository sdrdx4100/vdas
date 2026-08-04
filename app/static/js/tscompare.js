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
$("#tc-maxpoints").addEventListener("change", tcAuto);
$("#tc-plot").addEventListener("click", () => plot());

// ---------- Bオフセット (Aの上でスライド) ----------
// オフセットは取得済みデータのX値をずらすだけなので、再取得せず再描画だけで
// 済む。スライダーのドラッグ中も requestAnimationFrame で滑らかに追従させる。
let lastPlot = null;   // { results, signals, xcol, mode } — オフセット再描画用キャッシュ
let offsetRaf = 0;

function scheduleOffsetRerender() {
  if (offsetRaf) return;
  offsetRaf = requestAnimationFrame(() => {
    offsetRaf = 0;
    if (lastPlot && lastPlot.mode !== "ref") {
      renderMeta(lastPlot.results, lastPlot.xcol, lastPlot.mode);
      renderChart("tc-chart",
        () => renderOverlay(lastPlot.results, lastPlot.signals, lastPlot.xcol, lastPlot.mode));
    } else {
      tcAuto();  // まだ描画キャッシュが無ければ通常の再取得
    }
  });
}

function syncSliderFromNumber() {
  const slider = $("#tc-offset-slider");
  const value = +$("#tc-offset").value || 0;
  slider.value = String(Math.max(+slider.min, Math.min(+slider.max, value)));
}

// A(基準)の数値時間軸の広がりからスライダーの範囲を決める。
function updateOffsetRange(results, xcol) {
  const slider = $("#tc-offset-slider");
  const num = $("#tc-offset");
  const ax = (results[0]?.res.data[xcol] || []).filter((v) => typeof v === "number");
  const canSlide = ax.length >= 2;
  slider.disabled = !canSlide;
  num.disabled = !canSlide;
  $("#tc-offset-wrap").title = canSlide
    ? "Aの記録時間の範囲でBをスライドできます" : "スライドには数値の時間列が必要です";
  if (!canSlide) return;
  const span = Math.max(...ax) - Math.min(...ax);
  slider.min = String(-span);
  slider.max = String(span);
  slider.step = String(span > 0 ? span / 1000 : 1);
  syncSliderFromNumber();
}

$("#tc-offset-slider").addEventListener("input", () => {
  $("#tc-offset").value = $("#tc-offset-slider").value;
  scheduleOffsetRerender();
});
$("#tc-offset").addEventListener("input", () => {
  syncSliderFromNumber();
  scheduleOffsetRerender();
});
$("#tc-offset-reset").addEventListener("click", () => {
  $("#tc-offset").value = "0";
  $("#tc-offset-slider").value = "0";
  scheduleOffsetRerender();
});

// ---------- 自動整列 (基準信号の正規化相互相関でBのオフセットを推定) ----------
// 停車(定常)区間の影響を抑えるため、各信号は平均を引いてから相関を取る。
// 道路状況の違いで外すこともあるため、あくまで初期値の目安として使う。
$("#tc-offset-auto").addEventListener("click", () => {
  if (!lastPlot || lastPlot.mode === "ref") {
    return toast("「時間+手動オフセット」モードで走行A・Bを表示してから実行してください", "error");
  }
  const { results, signals, xcol } = lastPlot;
  if (results.length < 2) return toast("比較走行Bを選んでから実行してください", "error");
  const [runA, runB] = results;
  const common = signals.filter((s) => s in runA.res.data && s in runB.res.data);
  if (!common.length) return toast("A・B共通の信号が無いため自動整列できません", "error");
  // 速度らしい信号を優先 (動きが特徴的で合わせやすい)
  const sig = common.find((s) => /speed|km\/?h|車速|rpm|回転/i.test(s)) || common[0];
  const fit = bestOffset(runA.res.data[xcol], runA.res.data[sig], runB.res.data[xcol], runB.res.data[sig]);
  if (!fit) return toast("自動整列に必要な数値データが不足しています", "error");
  $("#tc-offset").value = String(fit.offset);
  syncSliderFromNumber();
  scheduleOffsetRerender();
  const pct = Math.round(fit.score * 100);
  const weak = fit.score < 0.4;
  toast(`信号「${sig}」で自動整列 (一致度 ${pct}%)` +
    (weak ? " — 低めです。停車区間や道路差の可能性、手動で微調整してください" : " — 必要なら手動で微調整を"),
    weak ? "error" : "ok");
});

// 数値の (t, y) 対を昇順に抽出する。
function numericPairs(ts, ys) {
  const out = [];
  const n = Math.min(ts.length, ys.length);
  for (let i = 0; i < n; i += 1) {
    const t = Number(ts[i]);
    const y = Number(ys[i]);
    if (Number.isFinite(t) && Number.isFinite(y)) out.push([t, y]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

// (t,y) 列を [tmin, tmax] の等間隔グリッド(間隔 dt)へ線形補間する。
function resampleUniform(pairs, tmin, tmax, dt) {
  const n = Math.max(2, Math.round((tmax - tmin) / dt) + 1);
  const grid = new Array(n);
  let j = 0;
  for (let k = 0; k < n; k += 1) {
    const t = tmin + k * dt;
    while (j < pairs.length - 2 && pairs[j + 1][0] < t) j += 1;
    const [t0, y0] = pairs[Math.min(j, pairs.length - 1)];
    const [t1, y1] = pairs[Math.min(j + 1, pairs.length - 1)];
    if (t <= pairs[0][0]) grid[k] = pairs[0][1];
    else if (t >= pairs[pairs.length - 1][0]) grid[k] = pairs[pairs.length - 1][1];
    else grid[k] = t1 > t0 ? y0 + (y1 - y0) * ((t - t0) / (t1 - t0)) : y0;
  }
  return grid;
}

function zeroMean(arr) {
  let sum = 0;
  let cnt = 0;
  for (const v of arr) if (Number.isFinite(v)) { sum += v; cnt += 1; }
  const mean = cnt ? sum / cnt : 0;
  for (let i = 0; i < arr.length; i += 1) arr[i] = Number.isFinite(arr[i]) ? arr[i] - mean : 0;
}

// 先頭・末尾の停車(定常・低値)区間を除いた「実走行」部分の範囲を返す。
// 停車の長さがA/Bで違うと相関がそこに引きずられるため、Bはこの範囲だけ使う。
function activeRange(grid) {
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of grid) if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!(mx > mn)) return [0, grid.length - 1];
  const th = mn + (mx - mn) * 0.1;
  let s = 0;
  let e = grid.length - 1;
  while (s < e && !(grid[s] >= th)) s += 1;
  while (e > s && !(grid[e] >= th)) e -= 1;
  return [s, e];
}

// A の時間軸上で B をずらし、正規化相互相関が最大になるオフセットを返す。
// Bの停車区間を除いた実走行部分を、A内に十分収まる位置だけで探すことで、
// 停車の長さ違いや端の偶発的な高相関に振り回されないようにする。
function bestOffset(tA, yA, tB, yB) {
  const A = numericPairs(tA, yA);
  const B = numericPairs(tB, yB);
  if (A.length < 4 || B.length < 4) return null;
  const aMin = A[0][0];
  const aMax = A[A.length - 1][0];
  const bMin = B[0][0];
  const bMax = B[B.length - 1][0];
  const spanA = aMax - aMin;
  const spanB = bMax - bMin;
  if (spanA <= 0 || spanB <= 0) return null;
  const dt = Math.max(spanA, spanB) / 600;
  const zA = resampleUniform(A, aMin, aMax, dt);
  const gBfull = resampleUniform(B, bMin, bMax, dt);
  const [activeStart, activeEnd] = activeRange(gBfull);
  const gB = gBfull.slice(activeStart, activeEnd + 1);
  if (gB.length < 4) return null;
  zeroMean(zA);
  zeroMean(gB);
  const na = zA.length;
  const nb = gB.length;
  const minOverlap = Math.max(8, Math.floor(nb * 0.85));  // Bの実走行がAにほぼ収まる位置だけ
  let bestL = 0;
  let bestScore = -Infinity;
  for (let L = -(nb - minOverlap); L <= na - minOverlap; L += 1) {
    let dot = 0;
    let sa = 0;
    let sb = 0;
    let cnt = 0;
    for (let m = 0; m < nb; m += 1) {
      const k = m + L;
      if (k < 0 || k >= na) continue;
      dot += zA[k] * gB[m];
      sa += zA[k] * zA[k];
      sb += gB[m] * gB[m];
      cnt += 1;
    }
    if (cnt < minOverlap) continue;
    const denom = Math.sqrt(sa * sb);
    const score = denom > 0 ? dot / denom : 0;
    if (score > bestScore) { bestScore = score; bestL = L; }
  }
  if (!Number.isFinite(bestScore)) return null;
  // Bの実走行開始 (bMin + activeStart*dt) が A時刻 (aMin + bestL*dt) に来る
  const offset = (aMin - (bMin + activeStart * dt)) + bestL * dt;
  const rounded = Math.abs(offset) >= 100 ? Math.round(offset) : Number(offset.toFixed(3));
  return { offset: rounded, score: Math.max(0, bestScore) };
}

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
  // 横軸(整列軸)と同じ列は信号として重ねない (時間vs時間の無意味な描画や、
  // x列をyにも要求したときの重複取得を避ける)。
  const signals = selectedList(state.tc.schemaA).filter((s) => s !== xcol);
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
    lastPlot = { results, signals, xcol, mode };
    if (mode !== "ref") updateOffsetRange(results, xcol);
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
    // オフセットのスライド(再描画)ではズーム/パンを保持し、データセットや
    // 信号を変えたときだけリセットする。
    uirevision: results.map((r) => r.id).join("|") + "|" + panels.join(","),
  });
  const gridStyle = layout.yaxis;
  delete layout.yaxis;

  const traces = [];
  panels.forEach((sig, i) => {
    const yaxis = i === 0 ? "y" : `y${i + 1}`;
    // 色は通常の時系列と同じく「信号ごと」。重ねる側(走行B)は薄く破線にして
    // 基準(走行A・実線)と区別する。
    const sigColor = colors[i % colors.length];
    results.forEach((run) => {
      if (!(sig in run.res.data)) return;  // その走行に無い信号はスキップ
      const overlaid = !run.primary;
      traces.push({
        type: "scattergl", mode: "lines", name: run.label,
        legendgroup: run.label, showlegend: results.length > 1 && i === 0,
        x: xValues(run, xcol, mode), y: run.res.data[sig], yaxis,
        line: { width: overlaid ? 1.8 : 2, color: sigColor, dash: overlaid ? "dash" : "solid" },
        opacity: overlaid ? 0.55 : 1,
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
