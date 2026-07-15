/* チャートテーマ (Fluent + 検証済みパレット) とテーマ切替 */
import { $, $$ } from "./api.js";

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function seriesColors() {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--series-${i}`));
}

export function baseLayout(extra = {}) {
  return Object.assign({
    font: { family: '"Segoe UI", system-ui, sans-serif', size: 12, color: cssVar("--text-primary") },
    paper_bgcolor: cssVar("--chart-surface"),
    plot_bgcolor: cssVar("--chart-surface"),
    colorway: seriesColors(),
    margin: { l: 56, r: 20, t: 30, b: 44 },
    xaxis: { gridcolor: cssVar("--chart-grid"), zerolinecolor: cssVar("--chart-axis"), linecolor: cssVar("--chart-axis") },
    yaxis: { gridcolor: cssVar("--chart-grid"), zerolinecolor: cssVar("--chart-axis"), linecolor: cssVar("--chart-axis") },
    hovermode: "closest",
    legend: { orientation: "h", y: 1.08, bgcolor: "transparent" },
  }, extra);
}

export const PLOT_CONFIG = { responsive: true, displaylogo: false, locale: "ja" };

// テーマ切替時に再描画するため、直近の描画関数を覚えておく
export const chartRegistry = new Map();
export function renderChart(elId, fn) {
  chartRegistry.set(elId, fn);
  fn();
}

// ---------- テーマ ----------

$("#theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  localStorage.setItem("vdas-theme", next);
  for (const fn of chartRegistry.values()) fn();
});

const savedTheme = localStorage.getItem("vdas-theme");
document.documentElement.dataset.theme =
  savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
