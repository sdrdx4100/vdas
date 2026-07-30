/* 信号名エイリアス: 会社ごとに異なる列名 (例: speed / 車速) を同じ意味として
   対応づける。2走行比較 (GPS地図・時系列比較) で、列名が完全一致しなくても
   重ねて表示できるようにするための共通ユーティリティ。 */
import { $, api, esc, toast } from "./api.js";

let cache = null;

export async function loadAliases(force = false) {
  if (cache && !force) return cache;
  try {
    cache = await api("/api/signal-aliases");
  } catch (_) {
    cache = [];
  }
  return cache;
}

// sourceColumn (基準側の走行での列名) と同じ意味を持つ列名を、
// targetColumns (もう一方の走行の列集合) の中から探す。
// 直接一致すればそれを、無ければエイリアスで結びついた列を探す。
export function resolveColumn(sourceColumn, targetColumns, aliasList) {
  if (targetColumns.has(sourceColumn)) return sourceColumn;
  const own = (aliasList || []).find((a) => a.column_name === sourceColumn);
  if (!own) return null;
  const group = aliasList.filter((a) => a.canonical_name === own.canonical_name);
  for (const g of group) {
    if (targetColumns.has(g.column_name)) return g.column_name;
  }
  return null;
}

// ---------- 管理モーダル ----------

const aliasModal = { bound: false };

export async function openAliasManager() {
  if (!aliasModal.bound) {
    aliasModal.bound = true;
    $("#aliasmodal-add").addEventListener("click", addAliasFromForm);
    $("#aliasmodal-close").addEventListener("click", () => { $("#alias-backdrop").hidden = true; });
    $("#alias-backdrop").addEventListener("mousedown", (e) => {
      if (e.target.id === "alias-backdrop") $("#alias-backdrop").hidden = true;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#alias-backdrop").hidden) $("#alias-backdrop").hidden = true;
    });
    $("#aliasmodal-group").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addAliasFromForm();
    });
    $("#aliasmodal-column").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addAliasFromForm();
    });
  }
  await loadAliases(true);
  renderAliasList();
  $("#alias-backdrop").hidden = false;
  $("#aliasmodal-group").focus();
}

function renderAliasList() {
  const wrap = $("#aliasmodal-list");
  const groups = new Map();
  for (const a of cache || []) {
    if (!groups.has(a.canonical_name)) groups.set(a.canonical_name, []);
    groups.get(a.canonical_name).push(a);
  }
  if (!groups.size) {
    wrap.innerHTML = '<div class="empty-note">まだ対応付けがありません。下のフォームから追加してください。</div>';
    return;
  }
  wrap.innerHTML = "";
  for (const [name, members] of groups) {
    const row = document.createElement("div");
    row.style.cssText = "padding:8px 10px; border:1px solid var(--card-border); border-radius:6px; margin-bottom:8px;";
    const chips = members.map((m) =>
      `<span class="chip" data-id="${m.id}">${esc(m.column_name)}<button class="tag-x" title="削除" type="button">✕</button></span>`
    ).join(" ");
    row.innerHTML = `<div style="font-weight:600; margin-bottom:6px;">${esc(name)}</div><div style="display:flex; gap:6px; flex-wrap:wrap;">${chips}</div>`;
    row.querySelectorAll(".tag-x").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const id = e.target.closest("[data-id]").dataset.id;
        await api(`/api/signal-aliases/${id}`, { method: "DELETE" });
        await loadAliases(true);
        renderAliasList();
      });
    });
    wrap.appendChild(row);
  }
}

async function addAliasFromForm() {
  const canonical = $("#aliasmodal-group").value.trim();
  const column = $("#aliasmodal-column").value.trim();
  if (!canonical || !column) return toast("グループ名と列名の両方を入力してください", "error");
  try {
    await api("/api/signal-aliases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canonical_name: canonical, column_name: column }),
    });
    $("#aliasmodal-column").value = "";
    await loadAliases(true);
    renderAliasList();
  } catch (e) {
    toast(`追加に失敗しました: ${e.message}`, "error");
  }
}
