/* クラスタリングタブ: K-means による走行状態の自動ラベリング */
import { $, $$, api, toast, fmtNum, esc } from "./api.js";
import { state } from "./state.js";
import { cssVar, seriesColors, baseLayout, PLOT_CONFIG, renderChart } from "./charts.js";
import { loadSchema } from "./filters.js";

$("#cl-dataset").addEventListener("change", async () => {
  state.cl.schema = await loadSchema($("#cl-dataset").value);
  state.cl.result = null;
  $("#cl-result-card").style.display = "none";
  $("#cl-charts").style.display = "none";
  $("#cl-status").innerHTML = "";
  renderClColumns();
  // 走行状態のクラスタリングに使いやすい信号を自動で仮選択
  if (state.cl.schema) {
    const numeric = state.cl.schema.columns.filter((c) => c.kind === "numeric");
    let picks = numeric
      .filter((c) => /speed|km\/?h|車速|rpm|回転|throttle|スロットル|brake|ブレーキ|accel|加速/i.test(c.name))
      .slice(0, 4).map((c) => c.name);
    if (!picks.length) picks = numeric.slice(0, 3).map((c) => c.name);
    $$("#cl-cols input").forEach((el) => { el.checked = picks.includes(el.value); });
  }
});

function renderClColumns() {
  const wrap = $("#cl-cols");
  wrap.innerHTML = "";
  if (!state.cl.schema) return;
  const q = $("#cl-col-search").value.trim().toLowerCase();
  for (const c of state.cl.schema.columns) {
    if (c.kind !== "numeric") continue;
    if (q && !c.name.toLowerCase().includes(q)) continue;
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${esc(c.name)}"><span>${esc(c.name)}</span><span class="col-type">${esc(c.type)}</span>`;
    wrap.appendChild(label);
  }
}

$("#cl-col-search").addEventListener("input", () => {
  const checked = $$("#cl-cols input:checked").map((el) => el.value);
  renderClColumns();
  $$("#cl-cols input").forEach((el) => { el.checked = checked.includes(el.value); });
});

const CLUSTER_LABEL = (v) => (v == null || v === "(null)" ? "未分類" : `クラスタ ${v}`);

$("#cl-run").addEventListener("click", async () => {
  const dsId = $("#cl-dataset").value;
  const features = $$("#cl-cols input:checked").map((el) => el.value);
  if (!dsId) return toast("データセットを選択してください", "error");
  if (features.length < 1) return toast("信号を1つ以上選択してください", "error");
  const btn = $("#cl-run");
  btn.disabled = true;
  $("#cl-status").innerHTML = '<span class="chip">計算中… (データ量によって数秒〜数十秒かかります)</span>';
  try {
    const res = await api(`/api/datasets/${dsId}/cluster`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        features,
        k: +$("#cl-k").value || 4,
        column_name: $("#cl-colname").value.trim() || "cluster",
      }),
    });
    state.cl.result = res;
    $("#cl-status").innerHTML =
      `<span class="chip accent">列「${esc(res.column_name)}」を追加しました</span> ` +
      `<span class="chip">${fmtNum(res.clustered_rows)} / ${fmtNum(res.total_rows)} 行を k=${res.k} でクラスタリング</span> ` +
      `<span class="chip">他タブのフィルタ・色分けでも使えます</span>`;
    renderClCenters(res);
    setupClCharts(res);
    // 他タブが持っているスキーマキャッシュを無効化する (列が増えたため)
    delete state.cmp.schemas[dsId];
    state.cl.schema = await loadSchema(dsId);
    renderClColumns();
    $$("#cl-cols input").forEach((el) => { el.checked = features.includes(el.value); });
    if ($("#ts-dataset").value === dsId) $("#ts-dataset").dispatchEvent(new Event("change"));
    if ($("#st-dataset").value === dsId) $("#st-dataset").dispatchEvent(new Event("change"));
    toast("クラスタリングが完了しました");
  } catch (e) {
    $("#cl-status").innerHTML = "";
    toast(`エラー: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
  }
});

function renderClCenters(res) {
  const headers = ["クラスタ", "件数", "割合"].concat(res.features);
  $("#cl-centers-table thead").innerHTML =
    `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const colors = seriesColors();
  $("#cl-centers-table tbody").innerHTML = res.centers.map((c) => {
    const cells = res.features.map((f) => `<td class="num">${esc(c[f] ?? "—")}</td>`).join("");
    return `<tr>
      <td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colors[c.cluster % colors.length]};margin-right:6px;"></span><strong>${CLUSTER_LABEL(c.cluster)}</strong></td>
      <td class="num">${fmtNum(c.count)}</td><td class="num">${c.percent}%</td>${cells}</tr>`;
  }).join("");
  $("#cl-result-card").style.display = "";
}

function setupClCharts(res) {
  const cols = state.cl.schema.columns;
  const numeric = cols.filter((c) => c.kind === "numeric" && c.name !== res.column_name);
  const opts = (list) => list.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  $("#cl-sc-x").innerHTML = opts(numeric);
  $("#cl-sc-y").innerHTML = opts(numeric);
  $("#cl-sc-x").value = res.features[0];
  $("#cl-sc-y").value = res.features[1] || res.features[0];
  $("#cl-ts-x").innerHTML = opts(cols.filter((c) => c.name !== res.column_name));
  const guess = cols.find((c) => c.kind === "temporal") ||
    cols.find((c) => /time|date|timestamp|時刻|時間/i.test(c.name)) || cols[0];
  if (guess) $("#cl-ts-x").value = guess.name;
  $("#cl-ts-y").innerHTML = opts(numeric);
  $("#cl-ts-y").value = res.features[0];
  $("#cl-charts").style.display = "";
  plotClScatter();
  plotClTimeseries();
}

async function fetchClusterScatter(x, y) {
  const res = state.cl.result;
  return api(`/api/datasets/${$("#cl-dataset").value}/scatter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x, y, color: res.column_name, max_points: 5000 }),
  });
}

// クラスタ番号 → 常に同じ色スロットになるようにグループ化して描画する
function clusterTraces(data, x, y, colorCol, markerSize) {
  const groups = new Map();
  data[colorCol].forEach((v, i) => {
    const key = v == null ? "(null)" : String(v);
    if (!groups.has(key)) groups.set(key, { x: [], y: [] });
    groups.get(key).x.push(data[x][i]);
    groups.get(key).y.push(data[y][i]);
  });
  const colors = seriesColors();
  return [...groups.entries()]
    .sort((a, b) => (a[0] === "(null)" ? 1 : b[0] === "(null)" ? -1 : +a[0] - +b[0]))
    .map(([key, g]) => ({
      type: "scattergl", mode: "markers", name: CLUSTER_LABEL(key),
      x: g.x, y: g.y,
      marker: {
        size: markerSize, opacity: 0.65,
        color: key === "(null)" ? cssVar("--text-muted") : colors[+key % colors.length],
      },
    }));
}

$("#cl-sc-plot").addEventListener("click", plotClScatter);
$("#cl-ts-plot").addEventListener("click", plotClTimeseries);

async function plotClScatter() {
  const res = state.cl.result;
  if (!res) return;
  const x = $("#cl-sc-x").value, y = $("#cl-sc-y").value;
  try {
    const data = (await fetchClusterScatter(x, y)).data;
    renderChart("cl-sc-chart", () => {
      Plotly.react("cl-sc-chart", clusterTraces(data, x, y, res.column_name, 5), baseLayout({
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: x } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: y } }),
        showlegend: true,
      }), PLOT_CONFIG);
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

async function plotClTimeseries() {
  const res = state.cl.result;
  if (!res) return;
  const x = $("#cl-ts-x").value, y = $("#cl-ts-y").value;
  try {
    const data = (await fetchClusterScatter(x, y)).data;
    renderChart("cl-ts-chart", () => {
      Plotly.react("cl-ts-chart", clusterTraces(data, x, y, res.column_name, 3), baseLayout({
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: x } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: y } }),
        showlegend: true,
      }), PLOT_CONFIG);
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}
