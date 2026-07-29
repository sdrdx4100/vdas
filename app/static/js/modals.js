/* チップ式タグエディタ・タグ編集モーダル・名前入力モーダル (prompt() の代替) */
import { $, esc, toast } from "./api.js";
import { state } from "./state.js";

// ---------- チップ式タグエディタ ----------

export function chipEditor(areaEl, inputEl, onChange = () => {}) {
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

export function updateTagDatalist() {
  $("#tag-suggestions").innerHTML =
    state.tags.map((t) => `<option value="${esc(t)}"></option>`).join("");
}

// ---------- タグ編集モーダル ----------

const tagModal = { editor: null, resolve: null, suggestions: [] };

export function openTagEditor({ title, tags = [], suggestions = null }) {
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

export function openNameDialog(title, value = "") {
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

// ---------- 結合モーダル (分割ログの連結: 順序指定 + 名前) ----------

const concatModal = { resolve: null, items: [] };

export function openConcatDialog(datasets, defaultName = "") {
  return new Promise((resolve) => {
    if (!concatModal.bound) {
      concatModal.bound = true;
      const close = (result) => {
        $("#concat-backdrop").hidden = true;
        const r = concatModal.resolve;
        concatModal.resolve = null;
        if (r) r(result);
      };
      $("#concatmodal-save").addEventListener("click", () =>
        close({ order: concatModal.items.map((d) => d.id), name: $("#concatmodal-name").value.trim() || null }));
      $("#concatmodal-cancel").addEventListener("click", () => close(null));
      $("#concat-backdrop").addEventListener("mousedown", (e) => {
        if (e.target.id === "concat-backdrop") close(null);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !$("#concat-backdrop").hidden) close(null);
      });
    }
    concatModal.resolve = resolve;
    concatModal.items = [...datasets];
    $("#concatmodal-name").value = defaultName;
    renderConcatList();
    $("#concat-backdrop").hidden = false;
    $("#concatmodal-name").focus();
  });
}

function renderConcatList() {
  const wrap = $("#concatmodal-list");
  wrap.innerHTML = "";
  concatModal.items.forEach((d, i) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid var(--card-border); border-radius:6px;";
    row.innerHTML =
      `<span style="min-width:20px; font-weight:600; color:var(--accent);">${i + 1}</span>` +
      `<span style="flex:1;">${esc(d.name)} <small style="color:var(--text-muted);">(${d.row_count.toLocaleString("ja-JP")}行)</small></span>` +
      `<button class="btn subtle" data-act="up" title="上へ"${i === 0 ? " disabled" : ""}>↑</button>` +
      `<button class="btn subtle" data-act="down" title="下へ"${i === concatModal.items.length - 1 ? " disabled" : ""}>↓</button>`;
    row.querySelector('[data-act="up"]').addEventListener("click", () => moveConcatItem(i, -1));
    row.querySelector('[data-act="down"]').addEventListener("click", () => moveConcatItem(i, 1));
    wrap.appendChild(row);
  });
}

function moveConcatItem(i, dir) {
  const j = i + dir;
  const items = concatModal.items;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  renderConcatList();
}
