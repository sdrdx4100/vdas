/* 全体統計可視化タブ: 基本統計量・ヒストグラム・散布図・相関行列 */
import { $, api, toast, debounce, esc } from "./api.js";
import { state } from "./state.js";
import { loadSchema, columnOptions, renderFilters, activeFilters } from "./filters.js";
import { seriesColors, baseLayout, PLOT_CONFIG, renderChart } from "./charts.js";
import { openNameDialog } from "./modals.js";

// フィルタ変更ですべてのチャートを自動更新
const stAutoAll = debounce(() => {
  plotHistogram(true);
  plotStScatter(true);
  plotCorrelation(true);
}, 600);
state.st.onChange = stAutoAll;

$("#st-dataset").addEventListener("change", async () => {
  state.st.schema = await loadSchema($("#st-dataset").value);
  state.st.filters = [];
  renderFilters("#st-filters", state.st);
  $("#hist-col").innerHTML = columnOptions(state.st.schema);
  $("#sc-x").innerHTML = columnOptions(state.st.schema, { numericOnly: true });
  $("#sc-y").innerHTML = columnOptions(state.st.schema, { numericOnly: true });
  $("#sc-color").innerHTML = columnOptions(state.st.schema, { blank: true });
  const numeric = (state.st.schema?.columns || []).filter((c) => c.kind === "numeric");
  if (numeric.length >= 2) $("#sc-y").value = numeric[1].name;
  if (numeric.length) $("#hist-col").value = numeric[0].name;
  if (!state.st.schema) return;
  // データセットを選んだ瞬間にすべて自動計算
  loadSummary(true);
  plotHistogram(true);
  plotStScatter(true);
  plotCorrelation(true);
});

// 各コントロールの変更でそのチャートを自動更新
$("#hist-col").addEventListener("change", () => plotHistogram(true));
$("#hist-bins").addEventListener("change", () => plotHistogram(true));
$("#sc-x").addEventListener("change", () => plotStScatter(true));
$("#sc-y").addEventListener("change", () => plotStScatter(true));
$("#sc-color").addEventListener("change", () => plotStScatter(true));

$("#st-add-filter").addEventListener("click", () => {
  if (!state.st.schema) return toast("先にデータセットを選択してください", "error");
  state.st.filters.push({ column: state.st.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#st-filters", state.st);
});

$("#st-load").addEventListener("click", () => loadSummary());

export async function loadSummary(auto = false) {
  const dsId = $("#st-dataset").value;
  if (!dsId) return auto || toast("データセットを選択してください", "error");
  try {
    const res = await api(`/api/datasets/${dsId}/summary`);
    const cols = ["column_name", "column_type", "count", "null_percentage",
      "min", "max", "avg", "std", "q25", "q50", "q75", "approx_unique"];
    const headers = ["列名", "型", "件数", "NULL%", "最小", "最大", "平均", "標準偏差", "Q25", "中央値", "Q75", "ユニーク数"];
    $("#summary-table thead").innerHTML =
      `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
    $("#summary-table tbody").innerHTML = res.stats.map((row) =>
      `<tr>${cols.map((c, i) => {
        let v = row[c];
        if (typeof v === "number" && !Number.isInteger(v)) v = v.toPrecision(5);
        return `<td class="${i >= 2 ? "num" : ""}">${esc(v ?? "—")}</td>`;
      }).join("")}</tr>`
    ).join("");
    $("#summary-empty").style.display = "none";
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

$("#hist-plot").addEventListener("click", () => plotHistogram());

async function plotHistogram(auto = false) {
  const dsId = $("#st-dataset").value;
  const column = $("#hist-col").value;
  if (!dsId || !column) return auto || toast("データセットと列を選択してください", "error");
  try {
    const res = await api(`/api/datasets/${dsId}/histogram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column, bins: +$("#hist-bins").value || 40, filters: activeFilters(state.st) }),
    });
    renderChart("hist-chart", () => {
      let trace;
      if (res.kind === "numeric") {
        const centers = res.edges.slice(0, -1).map((e, i) => (e + res.edges[i + 1]) / 2);
        trace = { type: "bar", x: centers, y: res.counts, marker: { color: seriesColors()[0] },
          hovertemplate: `${esc(column)}: %{x}<br>件数: %{y}<extra></extra>` };
      } else {
        trace = { type: "bar", x: res.labels, y: res.counts, marker: { color: seriesColors()[0] },
          hovertemplate: "%{x}<br>件数: %{y}<extra></extra>" };
      }
      Plotly.react("hist-chart", [trace], baseLayout({
        bargap: 0.08,
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: column } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: "件数" } }),
        showlegend: false,
      }), PLOT_CONFIG);
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

$("#sc-plot").addEventListener("click", () => plotStScatter());

async function plotStScatter(auto = false) {
  const dsId = $("#st-dataset").value;
  const x = $("#sc-x").value, y = $("#sc-y").value, color = $("#sc-color").value || null;
  if (!dsId || !x || !y) return auto || toast("データセットとX/Y列を選択してください", "error");
  try {
    const res = await api(`/api/datasets/${dsId}/scatter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y, color, filters: activeFilters(state.st), max_points: 5000 }),
    });
    renderChart("sc-chart", () => {
      let traces;
      if (color) {
        // 色分け列の値ごとにトレースを作成 (上位8カテゴリ + その他)
        const groups = new Map();
        res.data[color].forEach((v, i) => {
          const key = v == null ? "(null)" : String(v);
          if (!groups.has(key)) groups.set(key, { x: [], y: [] });
          groups.get(key).x.push(res.data[x][i]);
          groups.get(key).y.push(res.data[y][i]);
        });
        const entries = [...groups.entries()].sort((a, b) => b[1].x.length - a[1].x.length);
        const top = entries.slice(0, 8);
        const rest = entries.slice(8);
        if (rest.length) {
          const other = { x: [], y: [] };
          rest.forEach(([, g]) => { other.x.push(...g.x); other.y.push(...g.y); });
          top.push(["その他", other]);
        }
        traces = top.map(([name, g]) => ({
          type: "scattergl", mode: "markers", name,
          x: g.x, y: g.y, marker: { size: 5, opacity: 0.65 },
        }));
      } else {
        traces = [{ type: "scattergl", mode: "markers", x: res.data[x], y: res.data[y],
          marker: { size: 5, opacity: 0.6, color: seriesColors()[0] } }];
      }
      Plotly.react("sc-chart", traces, baseLayout({
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: x } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: y } }),
        showlegend: !!color,
      }), PLOT_CONFIG);
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

$("#corr-plot").addEventListener("click", () => plotCorrelation());

async function plotCorrelation(auto = false) {
  const dsId = $("#st-dataset").value;
  if (!dsId) return auto || toast("データセットを選択してください", "error");
  try {
    const res = await api(`/api/datasets/${dsId}/correlation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: activeFilters(state.st) }),
    });
    renderChart("corr-chart", () => {
      const dark = document.documentElement.dataset.theme === "dark";
      // 発散配色: 青 ↔ 赤、中点はニュートラルグレー
      const mid = dark ? "#383835" : "#f0efec";
      const colorscale = [
        [0, "#104281"], [0.25, "#5598e7"], [0.5, mid], [0.75, "#e88a8a"], [1, "#c03434"],
      ];
      Plotly.react("corr-chart", [{
        type: "heatmap", x: res.columns, y: res.columns, z: res.matrix,
        zmin: -1, zmax: 1, colorscale,
        colorbar: { title: { text: "r" }, outlinewidth: 0 },
        hovertemplate: "%{y} × %{x}<br>r = %{z}<extra></extra>",
        xgap: 2, ygap: 2,
      }], baseLayout({
        margin: { l: 120, r: 20, t: 30, b: 100 },
        yaxis: Object.assign(baseLayout().yaxis, { autorange: "reversed" }),
      }), PLOT_CONFIG);
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

$("#st-save-view").addEventListener("click", async () => {
  const dsId = $("#st-dataset").value;
  if (!dsId) return toast("データセットを選択してください", "error");
  const name = await openNameDialog("統計ビューを保存");
  if (!name) return;
  await api("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, kind: "stats", dataset_id: dsId,
      config: {
        filters: activeFilters(state.st),
        hist_col: $("#hist-col").value,
        hist_bins: +$("#hist-bins").value || 40,
        sc_x: $("#sc-x").value, sc_y: $("#sc-y").value, sc_color: $("#sc-color").value,
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});
