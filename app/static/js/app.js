/* VDAS フロントエンド */
"use strict";

// ---------- ユーティリティ ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* noop */ }
    throw new Error(detail);
  }
  return res.json();
}

function toast(msg, kind = "ok") {
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

function debounce(fn, ms = 500) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString("ja-JP") : n;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

// ---------- チャートテーマ (Fluent + 検証済みパレット) ----------

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function seriesColors() {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--series-${i}`));
}

function baseLayout(extra = {}) {
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

const PLOT_CONFIG = { responsive: true, displaylogo: false, locale: "ja" };

// テーマ切替時に再描画するため、直近の描画関数を覚えておく
const chartRegistry = new Map();
function renderChart(elId, fn) {
  chartRegistry.set(elId, fn);
  fn();
}

// ---------- 状態 ----------

const state = {
  datasets: [],
  ts: { schema: null, filters: [] },   // 時系列タブ
  st: { schema: null, filters: [] },   // 統計タブ
  cmp: { tagFilter: new Set(), schemas: {}, schema: null, filters: [], last: null },  // 比較タブ
  cl: { schema: null, result: null },          // クラスタリングタブ
  labelsets: [],
  tags: [],
  dsSelection: new Set(),      // データ管理タブの一括操作用チェック
  dataTagFilter: new Set(),    // データ管理タブのタグ絞り込み
};

// ---------- チップ式タグエディタ ----------

function chipEditor(areaEl, inputEl, onChange = () => {}) {
  const tags = [];
  const render = () => {
    areaEl.querySelectorAll(".tag-chip").forEach((el) => el.remove());
    for (const t of tags) {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.innerHTML = `${esc(t)}<button class="tag-x" title="削除" type="button">✕</button>`;
      chip.querySelector(".tag-x").addEventListener("click", () => remove(t));
      areaEl.insertBefore(chip, inputEl);
    }
    onChange([...tags]);
  };
  const add = (t) => {
    t = (t || "").replace(/[,、]/g, "").trim();
    if (t && !tags.includes(t)) { tags.push(t); render(); }
  };
  const remove = (t) => {
    const i = tags.indexOf(t);
    if (i >= 0) { tags.splice(i, 1); render(); }
  };
  const set = (list) => {
    tags.length = 0;
    for (const t of list || []) if (t && !tags.includes(t)) tags.push(t);
    render();
  };
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(inputEl.value);
      inputEl.value = "";
    } else if (e.key === "Backspace" && !inputEl.value && tags.length) {
      remove(tags[tags.length - 1]);
    }
  });
  // datalist から選択したときは change で確定する
  inputEl.addEventListener("change", () => {
    if (inputEl.value.trim()) { add(inputEl.value); inputEl.value = ""; }
  });
  areaEl.addEventListener("click", (e) => { if (e.target === areaEl) inputEl.focus(); });
  return { get: () => [...tags], set, add };
}

function updateTagDatalist() {
  $("#tag-suggestions").innerHTML =
    state.tags.map((t) => `<option value="${esc(t)}"></option>`).join("");
}

// ---------- タグ編集モーダル ----------

const tagModal = { editor: null, resolve: null, suggestions: [] };

function openTagEditor({ title, tags = [], suggestions = null }) {
  return new Promise((resolve) => {
    if (!tagModal.editor) {
      tagModal.editor = chipEditor($("#tagmodal-chips"), $("#tagmodal-input"),
        (current) => renderModalExisting(current));
      $("#tagmodal-save").addEventListener("click", () => closeTagModal(tagModal.editor.get()));
      $("#tagmodal-cancel").addEventListener("click", () => closeTagModal(null));
      $("#modal-backdrop").addEventListener("mousedown", (e) => {
        if (e.target.id === "modal-backdrop") closeTagModal(null);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !$("#modal-backdrop").hidden) closeTagModal(null);
      });
    }
    tagModal.resolve = resolve;
    tagModal.suggestions = suggestions ?? state.tags;
    $("#tagmodal-title").textContent = title;
    tagModal.editor.set(tags);
    $("#tagmodal-input").value = "";
    $("#modal-backdrop").hidden = false;
    $("#tagmodal-input").focus();
  });
}

function renderModalExisting(current) {
  const wrap = $("#tagmodal-existing");
  const cands = (tagModal.suggestions || []).filter((t) => !current.includes(t));
  $("#tagmodal-existing-wrap").style.display = cands.length ? "" : "none";
  wrap.innerHTML = "";
  for (const t of cands) {
    const chip = document.createElement("button");
    chip.className = "chip clickable";
    chip.type = "button";
    chip.textContent = t;
    chip.addEventListener("click", () => tagModal.editor.add(t));
    wrap.appendChild(chip);
  }
}

function closeTagModal(result) {
  $("#modal-backdrop").hidden = true;
  const r = tagModal.resolve;
  tagModal.resolve = null;
  if (r) r(result);
}

// ---------- 名前入力モーダル (prompt はブラウザ設定で無効化されうるため使わない) ----------

const nameModal = { resolve: null };

function openNameDialog(title, value = "") {
  return new Promise((resolve) => {
    if (!nameModal.bound) {
      nameModal.bound = true;
      const close = (result) => {
        $("#name-backdrop").hidden = true;
        const r = nameModal.resolve;
        nameModal.resolve = null;
        if (r) r(result);
      };
      $("#namemodal-save").addEventListener("click", () => {
        const v = $("#namemodal-input").value.trim();
        if (!v) return toast("名前を入力してください", "error");
        close(v);
      });
      $("#namemodal-cancel").addEventListener("click", () => close(null));
      $("#name-backdrop").addEventListener("mousedown", (e) => {
        if (e.target.id === "name-backdrop") close(null);
      });
      $("#namemodal-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") $("#namemodal-save").click();
        if (e.key === "Escape") close(null);
      });
    }
    nameModal.resolve = resolve;
    $("#namemodal-title").textContent = title;
    $("#namemodal-input").value = value;
    $("#name-backdrop").hidden = false;
    $("#namemodal-input").focus();
  });
}

// ---------- ナビゲーション ----------

$$(".nav-item[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".nav-item[data-page]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $$(".page").forEach((p) => p.classList.remove("active"));
    $(`#page-${btn.dataset.page}`).classList.add("active");
    if (btn.dataset.page === "views") refreshViewsPage();
    if (btn.dataset.page === "compare") autoSelectCmpDatasets();
    // 単一データセットのタブ: 未選択なら最初のデータセットを自動選択して即描画。
    // 選択済みでもスキーマ未読込 (別画面で値だけ変えた場合) なら読み込んで描画
    if (["timeseries", "stats", "cluster"].includes(btn.dataset.page)) {
      const page = btn.dataset.page;
      const sel = { timeseries: "#ts-dataset", stats: "#st-dataset", cluster: "#cl-dataset" }[page];
      const tab = { timeseries: state.ts, stats: state.st, cluster: state.cl }[page];
      if (!$(sel).value && state.datasets.length) $(sel).value = state.datasets[0].id;
      if ($(sel).value && tab.schema?.dataset?.id !== $(sel).value) {
        $(sel).dispatchEvent(new Event("change"));
      }
    }
  });
});

function gotoPage(name) {
  $(`.nav-item[data-page="${name}"]`).click();
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

// ---------- データセット一覧 ----------

async function refreshDatasets() {
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

function visibleDatasets() {
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

function tagChips(tags) {
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

// ---------- スキーマ・フィルタ UI (共通) ----------

async function loadSchema(datasetId) {
  return datasetId ? api(`/api/datasets/${datasetId}/schema`) : null;
}

function columnOptions(schema, { numericOnly = false, blank = false } = {}) {
  let cols = schema ? schema.columns : [];
  if (numericOnly) cols = cols.filter((c) => c.kind === "numeric");
  return (blank ? '<option value="">なし</option>' : "") +
    cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
}

const FILTER_OPS = [
  ["eq", "="], ["ne", "≠"], ["gt", ">"], ["ge", "≥"], ["lt", "<"], ["le", "≤"],
  ["contains", "を含む"], ["notnull", "が非NULL"], ["isnull", "がNULL"],
];

function renderFilters(containerId, tabState) {
  const wrap = $(containerId);
  wrap.innerHTML = "";
  tabState.filters.forEach((f, idx) => {
    const row = document.createElement("div");
    row.className = "filter-row";
    row.innerHTML = `
      <select data-k="column" style="min-width:150px;">${columnOptions(tabState.schema)}</select>
      <select data-k="op">${FILTER_OPS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
      <input type="text" data-k="value" placeholder="値" style="width:130px;">
      <button class="btn subtle danger-text" title="削除">✕</button>`;
    row.querySelector('[data-k="column"]').value = f.column || "";
    row.querySelector('[data-k="op"]').value = f.op || "eq";
    row.querySelector('[data-k="value"]').value = f.value ?? "";
    row.querySelectorAll("[data-k]").forEach((el) =>
      el.addEventListener("change", () => {
        f[el.dataset.k] = el.value;
        tabState.onChange?.();  // 条件変更で自動再描画
      }));
    row.querySelector("button").addEventListener("click", () => {
      tabState.filters.splice(idx, 1);
      renderFilters(containerId, tabState);
      tabState.onChange?.();
    });
    wrap.appendChild(row);
  });
}

function activeFilters(tabState) {
  return tabState.filters
    .filter((f) => f.column && f.op)
    .map((f) => ({ column: f.column, op: f.op, value: f.value ?? null }));
}

// ---------- 時系列タブ ----------

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

function setTsSelectedColumns(cols) {
  $$("#ts-cols input").forEach((el) => { el.checked = cols.includes(el.value); });
}

$("#ts-add-filter").addEventListener("click", () => {
  if (!state.ts.schema) return toast("先にデータセットを選択してください", "error");
  state.ts.filters.push({ column: state.ts.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#ts-filters", state.ts);
});

$("#ts-plot").addEventListener("click", () => plotTimeseries());

async function plotTimeseries(auto = false) {
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

// ---------- ラベルセット ----------

async function refreshLabelsets() {
  state.labelsets = await api("/api/labelsets");
  refreshLabelsetSelect();
}

function refreshLabelsetSelect() {
  // ラベルセットはどのデータセットでも使える (同名信号があれば適用される)
  const sel = $("#ts-labelset");
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 選択 —</option>' +
    state.labelsets
      .map((ls) => `<option value="${ls.id}">${esc(ls.name)} (${ls.columns.length}信号)</option>`)
      .join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

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

// ---------- 統計タブ ----------

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

async function loadSummary(auto = false) {
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

// ---------- 比較タブ ----------

function renderCmpTagFilter() {
  const wrap = $("#cmp-tag-filter");
  if (!state.tags.length) {
    wrap.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">タグ未登録 (データ管理タブの ✎ から付けられます)</span>';
    return;
  }
  wrap.innerHTML = "";
  for (const tag of state.tags) {
    const chip = document.createElement("button");
    chip.className = "chip clickable" + (state.cmp.tagFilter.has(tag) ? " on" : "");
    chip.textContent = tag;
    chip.addEventListener("click", () => {
      state.cmp.tagFilter.has(tag) ? state.cmp.tagFilter.delete(tag) : state.cmp.tagFilter.add(tag);
      renderCmpTagFilter();
      renderCmpDatasets();
    });
    wrap.appendChild(chip);
  }
}

function renderCmpDatasets() {
  const wrap = $("#cmp-datasets");
  const checked = cmpSelectedIds();
  const filter = state.cmp.tagFilter;
  const list = state.datasets.filter(
    (d) => !filter.size || (d.tags || []).some((t) => filter.has(t)));
  wrap.innerHTML = "";
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-note">該当するデータセットがありません</div>';
    return;
  }
  for (const ds of list) {
    const label = document.createElement("label");
    label.innerHTML =
      `<input type="checkbox" value="${esc(ds.id)}"><span><strong>${esc(ds.name)}</strong></span>` +
      `<span style="margin-left:6px;">${tagChips(ds.tags)}</span>` +
      `<span class="col-type">${fmtNum(ds.row_count)}行</span>`;
    const cb = label.querySelector("input");
    cb.checked = checked.includes(ds.id);
    cb.addEventListener("change", async () => {
      await updateCmpColumns();
      cmpAutoRun();  // 2件以上そろえば自動で比較開始
    });
    wrap.appendChild(label);
  }
}

function cmpSelectedIds() {
  return $$("#cmp-datasets input:checked").map((el) => el.value);
}

async function updateCmpColumns() {
  const ids = cmpSelectedIds();
  const sigSel = $("#cmp-signal"), grpSel = $("#cmp-groupby");
  const baseSel = $("#cmp-baseline"), cxSel = $("#cmp-curve-x"), cySel = $("#cmp-curve-y");
  if (!ids.length) {
    sigSel.innerHTML = ""; grpSel.innerHTML = '<option value="">なし (全体のみ)</option>';
    baseSel.innerHTML = ""; cxSel.innerHTML = ""; cySel.innerHTML = "";
    state.cmp.schema = null;
    return;
  }

  for (const id of ids) {
    if (!state.cmp.schemas[id]) state.cmp.schemas[id] = await loadSchema(id);
  }
  // 現在の選択値は await 後に読む (読み込み中にユーザーが変更した値を潰さないため)
  const prevSig = sigSel.value, prevGrp = grpSel.value, prevBase = baseSel.value;
  const prevCx = cxSel.value, prevCy = cySel.value;
  // 選択された全データセットに共通する列 (名前で照合)
  const schemas = ids.map((id) => state.cmp.schemas[id]);
  const common = schemas[0].columns.filter((c) =>
    schemas.every((s) => s.columns.some((o) => o.name === c.name && o.kind === c.kind)));
  state.cmp.schema = { columns: common };
  state.cmp.filters = state.cmp.filters.filter((f) => common.some((c) => c.name === f.column));
  renderFilters("#cmp-filters", state.cmp);

  const numeric = common.filter((c) => c.kind === "numeric");
  const numOpts = numeric.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  sigSel.innerHTML = numOpts;
  cxSel.innerHTML = numOpts;
  cySel.innerHTML = numOpts;
  grpSel.innerHTML = '<option value="">なし (全体のみ)</option>' +
    common.filter((c) => c.kind !== "temporal")
      .map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  baseSel.innerHTML = ids.map((id) =>
    `<option value="${esc(id)}">${esc(state.datasets.find((d) => d.id === id)?.name || id)}</option>`).join("");

  const keep = (sel, prev) => prev && [...sel.options].some((o) => o.value === prev) && (sel.value = prev);
  keep(sigSel, prevSig);
  keep(baseSel, prevBase);
  if (prevGrp && [...grpSel.options].some((o) => o.value === prevGrp)) {
    grpSel.value = prevGrp;
  } else {
    // ギア段・モードらしい列を自動候補にする
    const guess = common.find((c) => /gear|ギア|mode|モード|cluster|状態/i.test(c.name));
    grpSel.value = guess ? guess.name : "";
  }
  // 特性カーブの初期候補: X = 車速らしい列、Y = 回転数らしい列
  if (!keep(cxSel, prevCx)) {
    const gx = numeric.find((c) => /speed|km\/?h|velocity|車速/i.test(c.name)) || numeric[0];
    if (gx) cxSel.value = gx.name;
  }
  if (!keep(cySel, prevCy)) {
    const gy = numeric.find((c) => /rpm|回転/i.test(c.name)) || numeric[1] || numeric[0];
    if (gy) cySel.value = gy.name;
  }
}

$("#cmp-add-filter").addEventListener("click", () => {
  if (!state.cmp.schema) return toast("先にデータセットを2つ以上選択してください", "error");
  state.cmp.filters.push({ column: state.cmp.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#cmp-filters", state.cmp);
});

const cmpAutoRun = debounce(() => runCompare(true), 600);
state.cmp.onChange = cmpAutoRun;

$("#cmp-plot").addEventListener("click", () => runCompare());
["#cmp-signal", "#cmp-groupby", "#cmp-baseline"].forEach((sel) =>
  $(sel).addEventListener("change", cmpAutoRun));
$("#cmp-curve-x").addEventListener("change", () => plotCmpCurve().catch(() => {}));
$("#cmp-curve-y").addEventListener("change", () => plotCmpCurve().catch(() => {}));

// 比較タブを開いたとき、未選択ならデータセットを自動で選んで比較を始める
function autoSelectCmpDatasets() {
  if (cmpSelectedIds().length >= 2) return;
  const boxes = $$("#cmp-datasets input");
  if (boxes.length < 2) return;
  boxes.slice(0, 2).forEach((el) => { el.checked = true; });
  updateCmpColumns().then(cmpAutoRun);
}

const cmpDsName = (id) => state.datasets.find((d) => d.id === id)?.name || id;
const swatch = (color) =>
  `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:6px;"></span>`;

function fmtStat(v) {
  const n = Number(v);
  if (v != null && Number.isFinite(n) && !Number.isInteger(n)) return n.toPrecision(5);
  return v ?? "—";
}

async function runCompare(auto = false) {
  const ids = cmpSelectedIds();
  const signal = $("#cmp-signal").value;
  if (ids.length < 2) return auto || toast("データセットを2つ以上選択してください", "error");
  if (!signal) return auto || toast("比較する信号を選択してください", "error");
  const ctx = {
    ids, signal,
    groupBy: $("#cmp-groupby").value,
    baseline: $("#cmp-baseline").value || ids[0],
    filters: activeFilters(state.cmp),
  };
  state.cmp.last = ctx;
  try {
    await renderDiffTable(ctx);
    await renderSignalCharts(ctx);
    await plotCmpCurve();
    // レイアウト確定後にチャートをコンテナ幅へ合わせ直す
    requestAnimationFrame(() => {
      ["cmp-hist-chart", "cmp-cdf-chart", "cmp-group-chart", "cmp-curve-chart"].forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.data) Plotly.Plots.resize(el);
      });
    });
  } catch (e) {
    toast(`エラー: ${e.message}`, "error");
  }
}

// --- 彼我差分サマリ: 共通信号を KS 統計量でランキング ---
async function renderDiffTable(ctx) {
  const diff = await api("/api/compare/diff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset_ids: ctx.ids, baseline: ctx.baseline, filters: ctx.filters }),
  });
  const others = ctx.ids.filter((id) => id !== diff.baseline);
  const headers = ["信号", "分布差 (KS)", `基準: ${cmpDsName(diff.baseline)} 平均`]
    .concat(others.map((id) => `${cmpDsName(id)} 平均 (Δ%)`));
  $("#cmp-diff-table thead").innerHTML =
    `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const tbody = $("#cmp-diff-table tbody");
  tbody.innerHTML = "";
  for (const s of diff.signals) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.title = "クリックすると下のチャートがこの信号に切り替わります";
    const ksBar = s.max_ks == null ? "—" :
      `<div style="display:flex;align-items:center;gap:8px;">
         <div style="width:90px;height:8px;border-radius:4px;background:var(--subtle-active);overflow:hidden;">
           <div style="width:${Math.round(s.max_ks * 100)}%;height:100%;background:var(--accent);"></div>
         </div><span class="num">${s.max_ks.toFixed(3)}</span></div>`;
    const compCells = others.map((id) => {
      const c = s.comps.find((x) => x.dataset_id === id) || {};
      const delta = c.delta_pct == null ? "" :
        ` <span style="color:${Math.abs(c.delta_pct) >= 5 ? "var(--danger)" : "var(--text-muted)"};">(${c.delta_pct > 0 ? "+" : ""}${c.delta_pct}%)</span>`;
      return `<td class="num">${esc(fmtStat(c.avg))}${delta}</td>`;
    }).join("");
    tr.innerHTML = `<td><strong>${esc(s.name)}</strong></td><td>${ksBar}</td>` +
      `<td class="num">${esc(fmtStat(s.base_avg))}</td>${compCells}`;
    tr.addEventListener("click", () => {
      if (![...$("#cmp-signal").options].some((o) => o.value === s.name)) return;
      $("#cmp-signal").value = s.name;
      state.cmp.last = { ...state.cmp.last, signal: s.name };
      renderSignalCharts(state.cmp.last).catch((e) => toast(`エラー: ${e.message}`, "error"));
      toast(`信号「${s.name}」に切り替えました`);
    });
    tbody.appendChild(tr);
  }
  $("#cmp-diff-empty").style.display = "none";
  if (diff.truncated) toast("共通信号が多いため先頭100信号のみスキャンしました");
}

// --- 選択信号のチャート群 (分布・CDF・グループ別・統計量) ---
async function renderSignalCharts(ctx) {
  const { ids, signal, groupBy, filters } = ctx;
  const post = (path, body) => api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // 統計量比較テーブル (フィルタ適用)
  const sum = await post("/api/compare/summary", { dataset_ids: ids, column: signal, filters });
  const statKeys = ["count", "min", "max", "avg", "std", "q25", "q50", "q75"];
  const headers = ["データセット", "件数", "最小", "最大", "平均", "標準偏差", "Q25", "中央値", "Q75"];
  $("#cmp-stats-table thead").innerHTML =
    `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  const colors = seriesColors();
  $("#cmp-stats-table tbody").innerHTML = sum.series.map((row, i) => {
    const cells = statKeys.map((k) => `<td class="num">${esc(fmtStat(row[k]))}</td>`).join("");
    return `<tr><td>${swatch(colors[i % colors.length])}<strong>${esc(cmpDsName(row.dataset_id))}</strong></td>${cells}</tr>`;
  }).join("");
  $("#cmp-stats-empty").style.display = "none";

  // 分布比較 (共通ビン・割合)
  const hist = await post("/api/compare/histogram",
    { dataset_ids: ids, column: signal, bins: 40, filters });
  renderChart("cmp-hist-chart", () => {
      let traces;
      if (hist.kind === "numeric") {
        const centers = hist.edges.slice(0, -1).map((e, i) => (e + hist.edges[i + 1]) / 2);
        traces = hist.series.map((s) => ({
          type: "bar", x: centers, y: s.percents, name: cmpDsName(s.dataset_id), opacity: 0.6,
          hovertemplate: "%{x}<br>%{y}%<extra>%{fullData.name}</extra>",
        }));
      } else {
        traces = hist.series.map((s) => ({
          type: "bar", x: hist.labels, y: s.percents, name: cmpDsName(s.dataset_id),
          hovertemplate: "%{x}<br>%{y}%<extra>%{fullData.name}</extra>",
        }));
      }
      Plotly.react("cmp-hist-chart", traces, baseLayout({
        barmode: hist.kind === "numeric" ? "overlay" : "group",
        bargap: 0.05,
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: signal } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: "割合 (%)" } }),
        showlegend: true,
      }), PLOT_CONFIG);
    });

    // 累積分布 (CDF) 比較
    const cdf = await post("/api/compare/cdf", { dataset_ids: ids, column: signal, filters });
    renderChart("cmp-cdf-chart", () => {
      const traces = cdf.series
        .filter((s) => s.values)
        .map((s) => ({
          type: "scatter", mode: "lines", name: cmpDsName(s.dataset_id),
          x: s.values, y: cdf.percents, line: { width: 2 },
          hovertemplate: `${esc(signal)} ≤ %{x}<br>累積 %{y}%<extra>%{fullData.name}</extra>`,
        }));
      Plotly.react("cmp-cdf-chart", traces, baseLayout({
        xaxis: Object.assign(baseLayout().xaxis, { title: { text: signal } }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: "累積割合 (%)" }, range: [0, 100] }),
        hovermode: "y unified",
        showlegend: true,
      }), PLOT_CONFIG);
    });

  // グループ別比較 (箱ひげ図)
  if (groupBy) {
    const gs = await post("/api/compare/groupstats",
      { dataset_ids: ids, column: signal, group_by: groupBy, filters });
    $("#cmp-group-title").textContent = `グループ別比較: ${signal} × ${groupBy}`;
    $("#cmp-group-card").style.display = "";
    renderChart("cmp-group-chart", () => {
      const traces = gs.series.map((s, i) => ({
        type: "box", name: cmpDsName(s.dataset_id),
        x: gs.groups,
        q1: s.groups.map((g) => g?.q1 ?? null),
        median: s.groups.map((g) => g?.median ?? null),
        q3: s.groups.map((g) => g?.q3 ?? null),
        lowerfence: s.groups.map((g) => g?.lowerfence ?? null),
        upperfence: s.groups.map((g) => g?.upperfence ?? null),
        mean: s.groups.map((g) => g?.avg ?? null),
        marker: { color: seriesColors()[i % 8] },
        line: { width: 2 },
        boxmean: true,
      }));
      Plotly.react("cmp-group-chart", traces, baseLayout({
        boxmode: "group",
        xaxis: Object.assign(baseLayout().xaxis,
          { title: { text: groupBy }, type: "category" }),
        yaxis: Object.assign(baseLayout().yaxis, { title: { text: signal } }),
        showlegend: true,
      }), PLOT_CONFIG);
    });
  } else {
    $("#cmp-group-card").style.display = "none";
    chartRegistry.delete("cmp-group-chart");
  }
}

// --- 特性カーブ比較 (X ビン × Y 平均 + P10-P90 帯) ---
$("#cmp-curve-plot").addEventListener("click", () => plotCmpCurve().catch(
  (e) => toast(`エラー: ${e.message}`, "error")));

async function plotCmpCurve() {
  const ctx = state.cmp.last;
  if (!ctx) return;
  const x = $("#cmp-curve-x").value, y = $("#cmp-curve-y").value;
  if (!x || !y) return;
  if (x === y) return toast("特性カーブの X と Y には別の列を指定してください", "error");
  const curve = await api("/api/compare/curve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset_ids: ctx.ids, x, y, bins: 40, filters: ctx.filters }),
  });
  renderChart("cmp-curve-chart", () => {
    const colors = seriesColors();
    const traces = [];
    curve.series.forEach((s, i) => {
      const color = colors[i % colors.length];
      const name = cmpDsName(s.dataset_id);
      // P10-P90 帯 (null ビンを除いた連続区間で塗る)
      traces.push({
        type: "scatter", mode: "lines", x: curve.centers, y: s.p10,
        line: { width: 0 }, hoverinfo: "skip", showlegend: false,
        legendgroup: name, connectgaps: false,
      });
      traces.push({
        type: "scatter", mode: "lines", x: curve.centers, y: s.p90,
        fill: "tonexty", fillcolor: color + "26", line: { width: 0 },
        hoverinfo: "skip", showlegend: false, legendgroup: name, connectgaps: false,
      });
      traces.push({
        type: "scatter", mode: "lines", x: curve.centers, y: s.mean,
        name, line: { width: 2, color }, legendgroup: name, connectgaps: false,
        customdata: s.count,
        hovertemplate: `${esc(curve.y)} 平均 %{y}<br>n=%{customdata}<extra>%{fullData.name}</extra>`,
      });
    });
    Plotly.react("cmp-curve-chart", traces, baseLayout({
      xaxis: Object.assign(baseLayout().xaxis, { title: { text: curve.x } }),
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: curve.y } }),
      hovermode: "x unified",
      showlegend: true,
    }), PLOT_CONFIG);
  });
}

$("#cmp-save-view").addEventListener("click", async () => {
  const ids = cmpSelectedIds();
  if (ids.length < 2) return toast("データセットを2つ以上選択してください", "error");
  const name = await openNameDialog("比較ビューを保存");
  if (!name) return;
  await api("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, kind: "compare", dataset_id: null,
      config: {
        dataset_ids: ids,
        signal: $("#cmp-signal").value,
        group_by: $("#cmp-groupby").value || null,
        baseline: $("#cmp-baseline").value || null,
        filters: activeFilters(state.cmp),
        curve_x: $("#cmp-curve-x").value || null,
        curve_y: $("#cmp-curve-y").value || null,
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});

// ---------- クラスタリングタブ ----------

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

// ---------- 保存ビュータブ ----------

async function refreshViewsPage() {
  const [views] = await Promise.all([api("/api/views"), refreshLabelsets()]);

  const vBody = $("#views-table tbody");
  vBody.innerHTML = "";
  $("#views-empty").style.display = views.length ? "none" : "";
  const kindLabel = { timeseries: "時系列", stats: "統計", compare: "比較" };
  for (const v of views) {
    const dsIds = v.kind === "compare" ? (v.config.dataset_ids || []) : [v.dataset_id];
    const dsNames = dsIds
      .map((id) => state.datasets.find((d) => d.id === id)?.name || id)
      .filter(Boolean).join(" / ") || "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(v.name)}</strong></td>
      <td><span class="chip ${v.kind === "timeseries" ? "accent" : ""}">${kindLabel[v.kind] || v.kind}</span></td>
      <td>${esc(dsNames)}</td>
      <td>${esc(v.created_at)}</td>
      <td>
        <button class="btn subtle" data-act="load">読み込む</button>
        <button class="btn subtle danger-text" data-act="delete">削除</button>
      </td>`;
    tr.querySelector('[data-act="load"]').addEventListener("click", () => loadView(v));
    tr.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      if (!confirm(`ビュー「${v.name}」を削除しますか?`)) return;
      await api(`/api/views/${v.id}`, { method: "DELETE" });
      toast("削除しました");
      refreshViewsPage();
    });
    vBody.appendChild(tr);
  }

  const lBody = $("#labelsets-table tbody");
  lBody.innerHTML = "";
  $("#labelsets-empty").style.display = state.labelsets.length ? "none" : "";
  for (const ls of state.labelsets) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(ls.name)}</strong></td>
      <td class="num">${ls.columns.length}</td>
      <td style="max-width:420px; overflow:hidden; text-overflow:ellipsis;">${esc(ls.columns.join(", "))}</td>
      <td>${esc(ls.created_at)}</td>
      <td><button class="btn subtle danger-text">削除</button></td>`;
    tr.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`ラベルセット「${ls.name}」を削除しますか?`)) return;
      await api(`/api/labelsets/${ls.id}`, { method: "DELETE" });
      toast("削除しました");
      refreshViewsPage();
    });
    lBody.appendChild(tr);
  }
}

async function loadView(v) {
  const c = v.config || {};
  if (v.kind === "compare") {
    gotoPage("compare");
    state.cmp.tagFilter.clear();
    renderCmpTagFilter();
    renderCmpDatasets();
    $$("#cmp-datasets input").forEach((el) => { el.checked = (c.dataset_ids || []).includes(el.value); });
    state.cmp.filters = (c.filters || []).map((f) => ({ ...f }));
    await updateCmpColumns();
    const setIf = (sel, v) => {
      if (v && [...$(sel).options].some((o) => o.value === v)) $(sel).value = v;
    };
    setIf("#cmp-signal", c.signal);
    setIf("#cmp-groupby", c.group_by);
    setIf("#cmp-baseline", c.baseline);
    setIf("#cmp-curve-x", c.curve_x);
    setIf("#cmp-curve-y", c.curve_y);
    runCompare();
    toast(`ビュー「${v.name}」を読み込みました`);
    return;
  }
  if (v.kind === "timeseries") {
    gotoPage("timeseries");
    $("#ts-dataset").value = v.dataset_id || "";
    state.ts.schema = null; // change ハンドラが新しい schema を入れるまで待つ目印
    $("#ts-dataset").dispatchEvent(new Event("change"));
    await waitFor(() => state.ts.schema);
    if (c.x) $("#ts-x").value = c.x;
    setTsSelectedColumns(c.ys || []);
    state.ts.filters = (c.filters || []).map((f) => ({ ...f }));
    renderFilters("#ts-filters", state.ts);
    if (c.max_points) $("#ts-maxpoints").value = c.max_points;
    if (c.mode) $("#ts-mode").value = c.mode;
    plotTimeseries();
  } else {
    gotoPage("stats");
    $("#st-dataset").value = v.dataset_id || "";
    state.st.schema = null;
    $("#st-dataset").dispatchEvent(new Event("change"));
    await waitFor(() => state.st.schema);
    state.st.filters = (c.filters || []).map((f) => ({ ...f }));
    renderFilters("#st-filters", state.st);
    if (c.hist_col) $("#hist-col").value = c.hist_col;
    if (c.hist_bins) $("#hist-bins").value = c.hist_bins;
    if (c.sc_x) $("#sc-x").value = c.sc_x;
    if (c.sc_y) $("#sc-y").value = c.sc_y;
    if (c.sc_color != null) $("#sc-color").value = c.sc_color;
    loadSummary();
  }
  toast(`ビュー「${v.name}」を読み込みました`);
}

function waitFor(cond, timeout = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function poll() {
      if (cond() || Date.now() - t0 > timeout) return resolve();
      setTimeout(poll, 50);
    })();
  });
}

// ---------- 初期化 ----------

(async function init() {
  try {
    await refreshDatasets();
    await refreshLabelsets();
  } catch (e) {
    toast(`初期化エラー: ${e.message}`, "error");
  }
})();
