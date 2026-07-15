/* データ管理タブ: 一覧・タグ付け・一括操作・アップロード・プレビュー */
import { $, $$, api, toast, fmtNum, fmtSize, esc } from "./api.js";
import { state } from "./state.js";
import { chipEditor, openTagEditor, updateTagDatalist } from "./modals.js";
import { gotoPage } from "./nav.js";
import { renderCmpTagFilter, renderCmpDatasets } from "./compare.js";
import { refreshLabelsets } from "./views.js";

// ---------- データセット一覧 ----------

export async function refreshDatasets() {
  state.datasets = await api("/api/datasets");
  await refreshTags();
  renderDatasetTable();
  renderDataTagFilter();
  fillDatasetSelect($("#ts-dataset"));
  fillDatasetSelect($("#st-dataset"));
  fillDatasetSelect($("#cl-dataset"));
  renderCmpTagFilter();
  renderCmpDatasets();
}

export function visibleDatasets() {
  const filter = state.dataTagFilter;
  return state.datasets.filter(
    (d) => !filter.size || (d.tags || []).some((t) => filter.has(t)));
}

function renderDatasetTable() {
  const tbody = $("#dataset-table tbody");
  tbody.innerHTML = "";
  // 消えたデータセットの選択は掃除する
  state.dsSelection = new Set(
    [...state.dsSelection].filter((id) => state.datasets.some((d) => d.id === id)));
  const list = visibleDatasets();
  $("#dataset-empty").style.display = state.datasets.length ? "none" : "";
  for (const ds of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-act="select" style="accent-color:var(--accent);"></td>
      <td><strong>${esc(ds.name)}</strong></td>
      <td>${tagChips(ds.tags)} <button class="btn subtle" data-act="tags" title="タグを編集" style="padding:2px 8px; min-height:24px;">🏷️ ✎</button></td>
      <td>${esc(ds.original_filename)}</td>
      <td class="num">${fmtNum(ds.row_count)}</td>
      <td class="num">${fmtNum(ds.column_count)}</td>
      <td class="num">${fmtSize(ds.file_size)}</td>
      <td>${esc(ds.created_at)}</td>
      <td style="white-space:nowrap;">
        <button class="btn subtle" data-act="ts" title="時系列タブで開く">📈 時系列</button>
        <button class="btn subtle" data-act="stats" title="統計タブで開く">📊 統計</button>
        <button class="btn subtle" data-act="preview">プレビュー</button>
        <button class="btn subtle danger-text" data-act="delete">削除</button>
      </td>`;
    const cb = tr.querySelector('[data-act="select"]');
    cb.checked = state.dsSelection.has(ds.id);
    cb.addEventListener("change", () => {
      cb.checked ? state.dsSelection.add(ds.id) : state.dsSelection.delete(ds.id);
      updateBulkBar();
    });
    tr.querySelector('[data-act="tags"]').addEventListener("click", () => editTags(ds));
    tr.querySelector('[data-act="ts"]').addEventListener("click", () => openDatasetIn(ds.id, "timeseries"));
    tr.querySelector('[data-act="stats"]').addEventListener("click", () => openDatasetIn(ds.id, "stats"));
    tr.querySelector('[data-act="preview"]').addEventListener("click", () => showPreview(ds));
    tr.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      if (!confirm(`「${ds.name}」を削除しますか? (取り込んだテーブルと原本ファイルも削除されます)`)) return;
      await api(`/api/datasets/${ds.id}`, { method: "DELETE" });
      toast("削除しました");
      refreshDatasets();
    });
    tbody.appendChild(tr);
  }
  $("#select-all-ds").checked = list.length > 0 && list.every((d) => state.dsSelection.has(d.id));
  updateBulkBar();
}

function renderDataTagFilter() {
  const wrap = $("#data-tag-filter");
  if (!state.tags.length) {
    wrap.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">タグ未登録</span>';
    return;
  }
  wrap.innerHTML = "";
  for (const tag of state.tags) {
    const chip = document.createElement("button");
    chip.className = "chip clickable" + (state.dataTagFilter.has(tag) ? " on" : "");
    chip.textContent = tag;
    chip.addEventListener("click", () => {
      state.dataTagFilter.has(tag) ? state.dataTagFilter.delete(tag) : state.dataTagFilter.add(tag);
      renderDataTagFilter();
      renderDatasetTable();
    });
    wrap.appendChild(chip);
  }
}

$("#select-all-ds").addEventListener("change", () => {
  const list = visibleDatasets();
  if ($("#select-all-ds").checked) list.forEach((d) => state.dsSelection.add(d.id));
  else list.forEach((d) => state.dsSelection.delete(d.id));
  renderDatasetTable();
});

function updateBulkBar() {
  const n = state.dsSelection.size;
  $("#bulk-bar").hidden = n === 0;
  $("#bulk-count").textContent = `${n} 件選択中`;
}

$("#bulk-clear").addEventListener("click", () => {
  state.dsSelection.clear();
  renderDatasetTable();
});

$("#bulk-add-tags").addEventListener("click", async () => {
  const ids = [...state.dsSelection];
  const tags = await openTagEditor({ title: `${ids.length} 件のデータセットにタグを追加` });
  if (!tags || !tags.length) return;
  await api("/api/datasets/tags/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset_ids: ids, add: tags }),
  });
  toast(`${ids.length} 件にタグを追加しました`);
  refreshDatasets();
});

$("#bulk-remove-tags").addEventListener("click", async () => {
  const ids = [...state.dsSelection];
  const union = [...new Set(state.datasets
    .filter((d) => state.dsSelection.has(d.id))
    .flatMap((d) => d.tags || []))];
  if (!union.length) return toast("選択中のデータセットにタグが付いていません", "error");
  const tags = await openTagEditor({
    title: `${ids.length} 件のデータセットからタグを外す`, suggestions: union,
  });
  if (!tags || !tags.length) return;
  await api("/api/datasets/tags/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset_ids: ids, remove: tags }),
  });
  toast(`${ids.length} 件からタグを外しました`);
  refreshDatasets();
});

$("#bulk-delete").addEventListener("click", async () => {
  const ids = [...state.dsSelection];
  const names = state.datasets.filter((d) => state.dsSelection.has(d.id)).map((d) => d.name);
  const list = names.slice(0, 5).join("、") + (names.length > 5 ? ` ほか${names.length - 5}件` : "");
  if (!confirm(`選択した ${ids.length} 件のデータセットを削除しますか?\n(${list})\n\n取り込んだテーブルと原本ファイルも削除されます。この操作は取り消せません。`)) return;
  await api("/api/datasets/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset_ids: ids }),
  });
  state.dsSelection.clear();
  state.cmp.schemas = {};
  toast(`${ids.length} 件を削除しました`);
  refreshDatasets();
});

$("#delete-all").addEventListener("click", async () => {
  const n = state.datasets.length;
  if (!n) return toast("削除するデータセットがありません", "error");
  if (!confirm(`全 ${n} 件のデータセットを削除して初期状態に戻しますか?\n\n取り込んだテーブル・原本ファイル・DuckDBファイルがすべて削除されます。この操作は取り消せません。`)) return;
  const includeViews = confirm("保存ビューとラベルセットも一緒に削除しますか?\n\nOK = 一緒に削除 / キャンセル = データセットのみ削除");
  const res = await api("/api/datasets/delete-all", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ include_views: includeViews }),
  });
  state.dsSelection.clear();
  state.dataTagFilter.clear();
  state.cmp.schemas = {};
  state.cmp.last = null;
  toast(`全 ${res.deleted} 件を削除しました${includeViews ? " (保存ビュー・ラベルセットも削除)" : ""}`);
  refreshDatasets();
  refreshLabelsets();
});

export function tagChips(tags) {
  return (tags || []).map((t) => `<span class="chip accent">${esc(t)}</span>`).join(" ");
}

// データセットを指定タブで開く (選択→自動描画→タブ移動 まで1クリック)
function openDatasetIn(dsId, page) {
  const sel = { timeseries: "#ts-dataset", stats: "#st-dataset", cluster: "#cl-dataset" }[page];
  // 先に値を入れてからタブ移動する (ナビ側の自動選択と競合しないように)
  $(sel).value = dsId;
  gotoPage(page);
}

async function refreshTags() {
  state.tags = await api("/api/tags");
  updateTagDatalist();
}

async function editTags(ds) {
  const tags = await openTagEditor({
    title: `「${ds.name}」のタグを編集`, tags: ds.tags || [],
  });
  if (tags == null) return;
  await api(`/api/datasets/${ds.id}/tags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });
  toast("タグを更新しました");
  refreshDatasets();
}

function fillDatasetSelect(sel) {
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 選択 —</option>' +
    state.datasets.map((d) => `<option value="${d.id}">${esc(d.name)} (${fmtNum(d.row_count)}行)</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function showPreview(ds) {
  const data = await api(`/api/datasets/${ds.id}/preview?limit=100`);
  $("#preview-card").style.display = "";
  $("#preview-title").textContent = `プレビュー: ${ds.name} (先頭100行)`;
  $("#preview-table thead").innerHTML =
    `<tr>${data.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  $("#preview-table tbody").innerHTML = data.rows
    .map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`)
    .join("");
  $("#preview-card").scrollIntoView({ behavior: "smooth" });
}

// ---------- アップロード ----------

const dropzone = $("#dropzone");
const fileInput = $("#file-input");
// アップロード時に自動で付けるタグ (チップ入力)
const uploadTagEditor = chipEditor($("#upload-tags"), $("#upload-tag-input"));
dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => uploadFiles([...fileInput.files]));
["dragover", "dragenter"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
dropzone.addEventListener("drop", (e) => uploadFiles([...e.dataTransfer.files]));

async function uploadFiles(files) {
  const tags = uploadTagEditor.get();
  let lastDs = null;
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    if (tags.length) fd.append("tags", JSON.stringify(tags));
    try {
      toast(`アップロード中: ${file.name} …`);
      lastDs = await api("/api/datasets/upload", { method: "POST", body: fd });
      toast(`取り込み完了: ${lastDs.name} (${fmtNum(lastDs.row_count)}行)` +
        (tags.length ? ` — タグ: ${tags.join(", ")}` : ""));
    } catch (e) {
      toast(`エラー: ${e.message}`, "error");
    }
  }
  fileInput.value = "";
  await refreshDatasets();
  // アップロードしたデータをすぐ見られるよう、未選択のタブには自動セット
  // (タブを開いた瞬間に自動描画される)
  if (lastDs) {
    for (const sel of ["#ts-dataset", "#st-dataset", "#cl-dataset"]) {
      if (!$(sel).value) $(sel).value = lastDs.id;
    }
  }
}
