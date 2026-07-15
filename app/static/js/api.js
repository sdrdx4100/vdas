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

export function toast(msg, kind = "ok") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = ""; }, 3500);
}

// どこかで拾い損ねた非同期エラーも必ずユーザーに見せる (無反応にしない)
window.addEventListener("unhandledrejection", (e) => {
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
