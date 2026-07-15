/* 時系列可視化タブ */
import { $, $$, api, toast, debounce, fmtNum, esc } from "./api.js";
import { state } from "./state.js";
import { loadSchema, columnOptions, renderFilters, activeFilters } from "./filters.js";
import { seriesColors, baseLayout, PLOT_CONFIG, renderChart } from "./charts.js";
import { openNameDialog } from "./modals.js";
import { refreshLabelsets, refreshLabelsetSelect } from "./views.js";

const tsAutoPlot = debounce(() => plotTimeseries(true), 500);
state.ts.onChange = tsAutoPlot;

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
  refreshLabelsetSelect();
});

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

export function setTsSelectedColumns(cols) {
  $$("#ts-cols input").forEach((el) => { el.checked = cols.includes(el.value); });
}

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
    const mode = $("#ts-mode").value;
    renderChart("ts-chart", () => {
      if (mode === "split" && res.ys.length > 1) {
        renderTsSplit(res);
      } else {
        renderTsOverlay(res);
      }
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
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
  const gap = Math.min(0.03, 0.12 / k);
  const bandH = (1 - gap * (k - 1)) / k;

  const layout = baseLayout({
    height: Math.max(460, 150 * k + 90),
    showlegend: false,
    hovermode: "x unified",
    margin: { l: 64, r: 20, t: 24, b: 44 },
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
    layout[i === 0 ? "yaxis" : `yaxis${i + 1}`] = Object.assign({}, gridStyle, {
      domain: [Math.max(0, top - bandH), top],
      // 帯のタイトルを線と同じ色にして凡例の代わりにする
      title: { text: y, font: { size: 11, color: colors[i % colors.length] } },
      tickfont: { size: 10 },
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

$("#ts-mode").addEventListener("change", tsAutoPlot);

// ---------- ラベルセット適用 ----------

$("#ts-labelset").addEventListener("change", () => {
  const ls = state.labelsets.find((l) => l.id === $("#ts-labelset").value);
  if (!ls) return;
  $("#ts-col-search").value = "";
  renderTsColumns();
  // このデータセットに存在する信号だけ適用し、無いものは知らせる
  const existing = new Set((state.ts.schema?.columns || []).map((c) => c.name));
  const found = ls.columns.filter((c) => existing.has(c));
  if (!found.length) {
    return toast(`「${ls.name}」の信号はこのデータセットに存在しません`, "error");
  }
  setTsSelectedColumns(found);
  const missing = ls.columns.length - found.length;
  toast(`ラベルセット「${ls.name}」を適用しました` +
    (missing ? ` (${missing} 信号はこのデータに無いためスキップ)` : ""));
  plotTimeseries(true);
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
