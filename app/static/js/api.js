/* 共通ユーティリティ: DOM選択・API呼び出し・トースト通知・フォーマット */

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

export async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* noop */ }
    throw new Error(detail);
  }
  return res.json();
}

const latestControllers = new Map();

// 同じ表示領域への古い通信を中断し、遅い応答が新しい描画を上書きするのを防ぐ。
export async function apiLatest(key, path, opts = {}) {
  latestControllers.get(key)?.abort();
  const controller = new AbortController();
  latestControllers.set(key, controller);
  try {
    return await api(path, { ...opts, signal: controller.signal });
  } finally {
    if (latestControllers.get(key) === controller) latestControllers.delete(key);
  }
}

export const isAbortError = (error) => error?.name === "AbortError";

export function toast(msg, kind = "ok") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = ""; }, 3500);
}

// どこかで拾い損ねた非同期エラーも必ずユーザーに見せる (無反応にしない)
window.addEventListener("unhandledrejection", (e) => {
  const handled = !window.dispatchEvent(new CustomEvent("vdas-unhandled-error", {
    cancelable: true,
    detail: e.reason,
  }));
  if (handled) {
    e.preventDefault();
    return;
  }
  toast(`エラー: ${e.reason?.message || e.reason}`, "error");
});

export function debounce(fn, ms = 500) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString("ja-JP") : n;
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

// データセット選択肢の表示ラベル (エスケープ済み)。タグを併記して
// 「どの Parquet がどれか」を名前だけより見分けやすくする。
// 例: 走行A ［A社・高速］ (5,000行)
export function dsOptionLabel(d) {
  const tags = (d.tags || []).filter(Boolean);
  const tagStr = tags.length ? ` ［${tags.join("・")}］` : "";
  return `${esc(d.name)}${esc(tagStr)} (${fmtNum(d.row_count)}行)`;
}
