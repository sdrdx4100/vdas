/* GPS・地図タブ: 上部に走行軌跡の地図、下部に信号波形。行位置で連動する */
import { $, $$, api, toast, debounce, fmtNum, esc, dsOptionLabel } from "./api.js";
import { state } from "./state.js";
import { loadSchema, columnOptions, renderFilters, activeFilters } from "./filters.js";
import { seriesColors, baseLayout, PLOT_CONFIG, renderChart, chartRegistry, cssVar } from "./charts.js";
import { openNameDialog } from "./modals.js";
import { loadAliases, openAliasManager, resolveColumn } from "./aliases.js";
import { ensureLeaflet } from "./leaflet-loader.js";
import { ensurePlotly } from "./plotly-loader.js";
import {
  withSpeedAssist, detachSpeedAssist, timelineSeconds, buildCourseAxis, matchCourseProgress,
} from "./map-align.js";

$("#mp-alias-manage").addEventListener("click", () => openAliasManager());
loadAliases();

const mapAutoPlot = debounce(() => plotMap(true), 500);
state.mp.onChange = mapAutoPlot;
const MAX_WAVE_SIGNALS = 2;
let selectedSignals = new Set();
let gpsDatasets = [];
let pairs = [];
let mapSelectsReady = false;
let mpRequestId = 0;
const playback = {
  res: null,
  index: 0,
  indexB: 0,
  playing: false,
  frameId: null,
  lastFrame: 0,
  fractionalStep: 0,
};
const PLAYBACK_POINTS_PER_SECOND = 30;

// ---------- Leaflet 地図 (実地図タイル / オフライン白地図) ----------
const MAP_STYLE_CHOICE_KEY = "vdas-mapstyle-choice";
let mapStyle = localStorage.getItem(MAP_STYLE_CHOICE_KEY) || "open-street-map";
let leafletMap = null;
let leafletMode = null;
let leafletTileLayer = null;
let leafletTrackLayer = null;
let tileErrorCount = 0;

const mapStyleSel = $("#mp-mapstyle");
if (mapStyleSel) {
  mapStyleSel.value = mapStyle;
  mapStyleSel.addEventListener("change", () => {
    mapStyle = mapStyleSel.value;
    localStorage.setItem(MAP_STYLE_CHOICE_KEY, mapStyle);
    if (playback.res) renderMap(playback.res);
    else plotMap(true);
  });
}

function fallbackToBlankMap() {
  if (mapStyle === "white-bg") return;
  mapStyle = "white-bg";
  if (mapStyleSel) mapStyleSel.value = "white-bg";
  if (leafletTileLayer && leafletMap) leafletMap.removeLayer(leafletTileLayer);
  leafletTileLayer = null;
  $("#mp-map").classList.add("leaflet-offline");
  toast("地図タイルを取得できないため白地図(オフライン)に切り替えました。実地図に戻すには「地図スタイル」で選び直してください", "error");
}

// ---------- データセット選択肢の同期 ----------

document.addEventListener("datasets-refreshed", () => {
  refreshMapSelects();
});

async function refreshMapSelects() {
  try {
    [gpsDatasets, pairs] = await Promise.all([
      api("/api/gps/datasets"),
      api("/api/gps/pairs"),
    ]);
    mapSelectsReady = true;
  } catch (_) {
    gpsDatasets = [];
    pairs = [];
    mapSelectsReady = false;
  }
  const signals = signalCandidates();
  fillSelect($("#mp-dataset"), signals, "— 信号データを選択 —");
  fillSelect($("#mp-dataset-b"), signals, "— 比較しない —");
  const gpsOptions = gpsDatasets.map((g) => g.dataset);
  const gpsHtml = '<option value="">自動 (同名から判定)</option>' +
    gpsOptions.map((d) => `<option value="${d.id}">${dsOptionLabel(d)}</option>`).join("");
  $("#mp-gps").innerHTML = gpsHtml;
  $("#mp-gps-b").innerHTML = gpsHtml;
}

// 「信号データ」として選べる候補: GPS専用ログ(座標列しかない)は除くが、
// GPSログ自体に信号列も揃っている自己完結型ログ (pairsでmatch="self") は含める。
function signalCandidates(excludeId) {
  const gpsIds = new Set(gpsDatasets.map((g) => g.dataset.id));
  const selfContainedIds = new Set(
    pairs.filter((p) => p.match === "self").map((p) => p.signal.id));
  return state.datasets.filter((d) =>
    d.id !== excludeId && (!gpsIds.has(d.id) || selfContainedIds.has(d.id)));
}

function fillSelect(sel, datasets, placeholder) {
  const prev = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    datasets.map((d) => `<option value="${d.id}">${dsOptionLabel(d)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

export async function onMapPageEnter() {
  await ensureLeaflet();
  // map.js はGPSタブを開くまで遅延ロードされるため、初回は datasets-refreshed を
  // 受け取っていない。ここで一度だけGPS候補とペアを取得する。
  if (!mapSelectsReady) await refreshMapSelects();
  const sel = $("#mp-dataset");
  if (!sel.value) {
    const first = signalCandidates()[0];
    if (first) sel.value = first.id;
  }
  if (sel.value && state.mp.schema?.dataset?.id !== sel.value) {
    sel.dispatchEvent(new Event("change"));
  }
}

// ---------- 信号データセットの選択 ----------

$("#mp-dataset").addEventListener("change", async () => {
  mpRequestId += 1;
  const dsId = $("#mp-dataset").value;
  state.mp.schema = await loadSchema(dsId);
  state.mp.filters = [];
  selectedSignals = new Set();
  renderFilters("#mp-filters", state.mp);
  renderSignalColumns();
  const colorSel = $("#mp-color");
  colorSel.innerHTML = '<option value="">なし (単色の軌跡)</option>' +
    '<option value="__alt__">高度 (GPS_z)</option>' +
    columnOptions(state.mp.schema, { numericOnly: true });

  // GPS ペアを自動選択して案内する
  const pair = pairs.find((p) => p.signal.id === dsId);
  if (pair && pair.match === "self") {
    $("#mp-gps").value = pair.gps.id;
    await loadGpsSchema(pair.lat_col, pair.lon_col);
    const cols = pair.lat_col && pair.lon_col
      ? ` (${esc(pair.lat_col)} / ${esc(pair.lon_col)})`
      : ` (座標列: ${(pair.coord_cols || []).map(esc).join(", ")} — 値から自動判定)`;
    setPairStatus(`✅ このデータ自体に GPS 座標が含まれています${cols} — 別ファイルとのペアは不要です`, "ok");
  } else if (pair) {
    $("#mp-gps").value = pair.gps.id;
    await loadGpsSchema(pair.lat_col, pair.lon_col);
    const cols = pair.lat_col && pair.lon_col
      ? ` (${esc(pair.lat_col)} / ${esc(pair.lon_col)})`
      : ` (座標列: ${(pair.coord_cols || []).map(esc).join(", ")} — 値から自動判定)`;
    const how = pair.match === "timestamp" ? "ファイル名の日時で自動ペア"
      : pair.match === "tag" ? "タグで自動ペア"
      : "ファイル名で自動ペア";
    setPairStatus(`✅ GPS データ「${esc(pair.gps.name)}」を${how}${cols}`, "ok");
  } else {
    $("#mp-gps").value = "";
    await loadGpsSchema();
    setPairStatus("⚠️ 対応する GPS データが見つかりません (ファイル名の一致・日時ともに不一致)。GPS データセットを手動で選んでください。", "warn");
  }

  // 代表信号を自動選択して即描画 (速度・回転数らしい列 → 先頭の数値列)
  if (state.mp.schema) {
    const numeric = state.mp.schema.columns.filter((c) => c.kind === "numeric");
    const picks = [];
    for (const re of [/speed|km\/?h|車速/i, /rpm|回転/i]) {
      const hit = numeric.find((c) => re.test(c.name) && !picks.includes(c.name));
      if (hit) picks.push(hit.name);
    }
    for (const c of numeric) {
      if (picks.length >= 2) break;
      if (!picks.includes(c.name)) picks.push(c.name);
    }
    setSelectedSignals(picks);
    if (colorSel.querySelector(`option[value="${CSS.escape(picks[0] || "")}"]`)) {
      colorSel.value = picks[0] || "";
    }
  }
  updateComparisonRecommendation(dsId);
  plotMap(true);
});

// 走行B候補を GPS ルートの近さで並べ替え・目印付けし、おすすめを提示する
async function updateComparisonRecommendation(signalId) {
  const sel = $("#mp-dataset-b");
  const hint = $("#mp-cmp-hint");
  // 前の走行Aに対する候補や案内を即座に消し、取得失敗時も古い推薦を残さない
  hint.hidden = true;
  hint.textContent = "";
  const candidates = signalCandidates(signalId);
  fillSelect(sel, candidates, "— 比較しない —");
  let data;
  try {
    data = await api(`/api/gps/${signalId}/similar`);
  } catch (_) {
    return;
  }
  if ($("#mp-dataset").value !== signalId) return;  // 選択が変わっていたら破棄
  const prev = sel.value;
  const runs = data.runs || [];
  const proximity = (r) => {
    const dist = r.distance == null ? "" :
      ` ${fmtNum(r.distance)}${r.distance_unit === "km" ? "km" : ""}`;
    if (r.overlaps) return `GPS範囲重複${dist}`;
    if (r.nearby) return `GPS近似${dist}`;
    if (r.same_tag) return "同じタグ";
    return "";
  };
  const opt = (r) => {
    const star = r.recommended ? "⭐ " : "";
    const reason = proximity(r);
    const tag = reason ? ` (${reason})` : "";
    return `<option value="${r.signal.id}">${star}${dsOptionLabel(r.signal)}${tag}</option>`;
  };
  // GPSを自動ペアできない走行も、従来どおり手動比較できる選択肢として末尾に残す
  const rankedIds = new Set(runs.map((r) => r.signal.id));
  const others = candidates.filter((d) => !rankedIds.has(d.id))
    .map((d) => `<option value="${d.id}">${dsOptionLabel(d)}</option>`)
    .join("");
  sel.innerHTML = '<option value="">— 比較しない —</option>' + runs.map(opt).join("") + others;
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;

  const best = runs.find((r) => r.recommended);
  if (best && !sel.value) {
    const reason = proximity(best);
    hint.hidden = false;
    hint.innerHTML = `おすすめ比較: <button class="chip clickable on" id="mp-cmp-apply">⭐ ${esc(best.signal.name)}${reason ? ` (${esc(reason)})` : ""}</button>`;
    $("#mp-cmp-apply").addEventListener("click", () => {
      sel.value = best.signal.id;
      sel.dispatchEvent(new Event("change"));
      hint.hidden = true;
    });
  } else {
    hint.hidden = true;
    hint.innerHTML = "";
  }
}

function setPairStatus(html, kind) {
  const el = $("#mp-pair-status");
  el.innerHTML = html;
  el.style.color = kind === "warn" ? "var(--warn, #b8860b)" : "var(--text-secondary)";
}

async function loadGpsSchema(preLat, preLon) {
  const gpsId = $("#mp-gps").value;
  const latSel = $("#mp-lat");
  const lonSel = $("#mp-lon");
  if (!gpsId) {
    latSel.innerHTML = '<option value="">自動</option>';
    lonSel.innerHTML = '<option value="">自動</option>';
    return;
  }
  const schema = await loadSchema(gpsId);
  const opts = '<option value="">自動</option>' + columnOptions(schema, { numericOnly: true });
  latSel.innerHTML = opts;
  lonSel.innerHTML = opts;
  if (preLat) latSel.value = preLat;
  if (preLon) lonSel.value = preLon;
}

$("#mp-gps").addEventListener("change", async () => {
  await loadGpsSchema();
  const gpsId = $("#mp-gps").value;
  const g = gpsDatasets.find((d) => d.dataset.id === gpsId);
  if (g) {
    if (g.lat_col) $("#mp-lat").value = g.lat_col;
    if (g.lon_col) $("#mp-lon").value = g.lon_col;
    const cols = g.lat_col && g.lon_col
      ? ` (${esc(g.lat_col)} / ${esc(g.lon_col)})`
      : ` (座標列: ${(g.coord_cols || []).map(esc).join(", ")} — 値から自動判定)`;
    setPairStatus(`GPS データ「${esc(g.dataset.name)}」を使用${cols}`, "ok");
  }
  plotMap(true);
});

$("#mp-dataset-b").addEventListener("change", async () => {
  mpRequestId += 1;
  const dsId = $("#mp-dataset-b").value;
  state.mp.schemaB = dsId ? await loadSchema(dsId) : null;
  $("#mp-gps-b").disabled = !dsId;
  $("#mp-align-offset").value = "0";
  if (!dsId) {
    $("#mp-gps-b").value = "";
    setPairStatusB("");
    plotMap(true);
    return;
  }
  const pair = pairs.find((p) => p.signal.id === dsId);
  if (pair) {
    $("#mp-gps-b").value = pair.gps.id;
    setPairStatusB(`✅ GPS データ「${esc(pair.gps.name)}」を走行 B に自動ペア`, "ok");
  } else {
    $("#mp-gps-b").value = "";
    setPairStatusB("⚠️ 走行 B と同名の GPS データがありません。手動で選択してください。", "warn");
  }
  plotMap(true);
});

$("#mp-gps-b").addEventListener("change", () => {
  const gpsId = $("#mp-gps-b").value;
  const g = gpsDatasets.find((d) => d.dataset.id === gpsId);
  setPairStatusB(g ? `GPS データ「${esc(g.dataset.name)}」を走行 B に使用` : "");
  plotMap(true);
});

function setPairStatusB(html, kind) {
  const el = $("#mp-pair-status-b");
  el.innerHTML = html;
  el.style.color = kind === "warn" ? "var(--warn, #b8860b)" : "var(--text-secondary)";
}

$("#mp-lat").addEventListener("change", mapAutoPlot);
$("#mp-lon").addEventListener("change", mapAutoPlot);
$("#mp-color").addEventListener("change", mapAutoPlot);
$("#mp-maxpoints").addEventListener("change", mapAutoPlot);
$("#mp-sync-mode").addEventListener("change", () => {
  updateSyncHint();
  plotMap(true);
});

function updateSyncHint() {
  const course = $("#mp-sync-mode").value === "course";
  $("#mp-sync-hint").textContent = course
    ? "GPS実測点からコース進捗を求め、欠損区間は入口・出口間を推定します。"
    : "A/Bのシーク位置を基準に時間軸を合わせます。";
  $("#mp-seek-hint").textContent = course
    ? "片方を動かすと同じコース進捗へ自動追従"
    : "A/Bを別々に動かして同じ地点を選択";
}

// ---------- 波形に出す信号の選択 ----------

function renderSignalColumns() {
  const wrap = $("#mp-cols");
  wrap.innerHTML = "";
  if (!state.mp.schema) return;
  const q = $("#mp-col-search").value.trim().toLowerCase();
  for (const c of state.mp.schema.columns) {
    if (c.kind !== "numeric") continue;
    if (q && !c.name.toLowerCase().includes(q)) continue;
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${esc(c.name)}"><span>${esc(c.name)}</span><span class="col-type">${esc(c.type)}</span>`;
    label.querySelector("input").checked = selectedSignals.has(c.name);
    wrap.appendChild(label);
  }
  updateSelectionSummary();
}

$("#mp-col-search").addEventListener("input", renderSignalColumns);

$("#mp-cols").addEventListener("change", (event) => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  if (input.checked && !selectedSignals.has(input.value)
      && selectedSignals.size >= MAX_WAVE_SIGNALS) {
    input.checked = false;
    toast(`波形は同時に${MAX_WAVE_SIGNALS}つまで選択できます`, "error");
    return;
  }
  input.checked ? selectedSignals.add(input.value) : selectedSignals.delete(input.value);
  updateSelectionSummary();
  mapAutoPlot();
});

function selectedSignalList() {
  return (state.mp.schema?.columns || [])
    .map((c) => c.name)
    .filter((n) => selectedSignals.has(n));
}

function setSelectedSignals(cols) {
  selectedSignals = new Set(cols.slice(0, MAX_WAVE_SIGNALS));
  $$("#mp-cols input").forEach((el) => { el.checked = selectedSignals.has(el.value); });
  updateSelectionSummary();
}

function updateSelectionSummary() {
  const summary = $("#mp-selection-summary");
  if (summary) summary.textContent = `${selectedSignals.size} / ${MAX_WAVE_SIGNALS} 信号選択中`;
  const atLimit = selectedSignals.size >= MAX_WAVE_SIGNALS;
  $$("#mp-cols input").forEach((input) => {
    input.disabled = atLimit && !selectedSignals.has(input.value);
  });
}

$("#mp-clear-selection").addEventListener("click", () => {
  setSelectedSignals([]);
  mapAutoPlot();
});

$("#mp-add-filter").addEventListener("click", () => {
  if (!state.mp.schema) return toast("先に信号データセットを選択してください", "error");
  state.mp.filters.push({ column: state.mp.schema.columns[0]?.name, op: "eq", value: "" });
  renderFilters("#mp-filters", state.mp);
});

$("#mp-plot").addEventListener("click", () => plotMap());

// ---------- 描画 ----------

export async function plotMap(auto = false) {
  const dsId = $("#mp-dataset").value;
  if (!dsId) return auto || toast("信号データセットを選択してください", "error");
  const dsIdB = $("#mp-dataset-b").value;

  const requestId = ++mpRequestId;
  stopPlayback();
  setPlaybackEnabled(false);
  setMapLoading(true);
  try {
    const filters = activeFilters(state.mp);
    const selectedA = selectedSignalList();
    const signalRequestA = withSpeedAssist(state.mp.schema, selectedA);
    const requestTrack = (id, body) => api(`/api/gps/${id}/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const colorValue = $("#mp-color").value;
    const requestA = requestTrack(dsId, {
      signals: signalRequestA.signals,
      // 高度(__alt__)は常に返る alt_values を使うため信号としては要求しない
      color_signal: (dsIdB || colorValue === "__alt__") ? null : (colorValue || null),
      gps_id: $("#mp-gps").value || null,
      lat_col: $("#mp-lat").value || null,
      lon_col: $("#mp-lon").value || null,
      filters,
      max_points: +$("#mp-maxpoints").value || 5000,
    });
    let requestB = null;
    let signalRequestB = null;
    let requestBError = null;
    let bToDisplayName = null;
    if (dsIdB) {
      const columnsB = new Set((state.mp.schemaB?.columns || []).map((c) => c.name));
      const aliasList = await loadAliases();
      // 列名がAと完全一致しなくても、エイリアスで同じ意味と分かっていれば
      // Bの実列名で要求し、結果は表示上Aの列名に戻す (renameSignalsToDisplayName)。
      bToDisplayName = new Map();
      const signalsB = [];
      for (const name of selectedA) {
        const resolved = resolveColumn(name, columnsB, aliasList);
        if (resolved) {
          signalsB.push(resolved);
          bToDisplayName.set(resolved, name);
        }
      }
      signalRequestB = withSpeedAssist(state.mp.schemaB, signalsB);
      const filtersB = filters
        .map((f) => {
          const resolved = resolveColumn(f.column, columnsB, aliasList);
          return resolved ? { ...f, column: resolved } : null;
        })
        .filter(Boolean);
      // .catch を作成と同じ tick で付けておく (await requestA の完了を待つ間に
      // requestB が失敗すると、後から catch してもブラウザに未処理rejectionとして
      // 検出されてしまうため)。失敗時は null を返し、理由は requestBError に控える。
      requestB = requestTrack(dsIdB, {
        signals: signalRequestB.signals,
        color_signal: null,
        gps_id: $("#mp-gps-b").value || null,
        lat_col: null,
        lon_col: null,
        filters: filtersB,
        max_points: +$("#mp-maxpoints").value || 5000,
      }).catch((e) => {
        requestBError = e;
        return null;
      });
    }
    // 走行 A が取れなければ何も表示できないので致命的エラーとして扱う。
    // 走行 B は失敗しても A だけで表示を続ける (二走行比較で片方だけ失敗して
    // 画面全体が真っ白になっていた問題への対応)。
    const res = await requestA;
    detachSpeedAssist(res, signalRequestA.assist);
    let resB = requestB ? await requestB : null;
    if (requestB && resB) {
      detachSpeedAssist(resB, signalRequestB?.assist);
      // Bの実列名(エイリアス解決済み)をAの表示名に戻し、renderWave等が
      // 列名の完全一致を前提にしていても重ねて表示できるようにする。
      if (bToDisplayName?.size) {
        const renamed = {};
        for (const [key, values] of Object.entries(resB.signals)) {
          renamed[bToDisplayName.get(key) || key] = values;
        }
        resB.signals = renamed;
      }
    } else if (requestB && !resB) {
      toast(`走行 B の取得に失敗しました: ${requestBError?.message} (走行 A のみ表示します)`, "error");
    }
    const view = buildTrackView(res, resB);
    if (requestId !== mpRequestId) return;
    state.mp.track = res;
    state.mp.trackB = resB;
    // 自動判定された座標列・モードを選択欄と案内に反映する
    reflectResolvedCoords(res);
    const modeChip = res.mode === "planar"
      ? `<span class="chip">平面座標 (${esc(res.px_col)} / ${esc(res.py_col)})</span>`
      : `<span class="chip">地図 (緯度 ${esc(res.lat_col)} / 経度 ${esc(res.lon_col)})</span>`;
    const alignChip = res.align_mode === "time"
      ? '<span class="chip" title="GPSと信号の記録開始時刻・サンプリング周期のズレを補正して対応づけました">🕒 時刻ベースで整列</span> '
      : res.align_mode === "self"
      ? '<span class="chip" title="GPS座標と信号がすべて同じファイルに含まれています">📍 単一ファイル (GPS+波形)</span> '
      : "";
    const mismatchChip = view.mapMismatch
      ? '<span class="chip" style="color:var(--warn, #b8860b);">⚠ 走行Bは座標形式が異なるため地図には表示していません (波形は比較表示)</span> '
      : "";
    // 自己完結型 (GPS=信号) の場合は「GPS: xxx」チップが走行Aと同名で重複するので省く
    const gpsChip = res.align_mode === "self"
      ? "" : `<span class="chip">GPS: ${esc(res.gps_dataset.name)}</span> `;
    $("#mp-meta").innerHTML =
      `<span class="chip accent">走行 A: ${esc(res.signal_dataset.name)} / ${fmtNum(res.returned_rows)} 点</span> ` +
      (resB ? `<span class="chip">走行 B: ${esc(resB.signal_dataset.name)} / ${fmtNum(resB.returned_rows)} 点</span> ` : "") +
      (view.runs.some((run) => run.course.estimatedCount)
        ? `<span class="chip">GPS補間 A:${fmtNum(view.runs[0].course.estimatedCount)}点` +
          (resB ? ` / B:${fmtNum(view.runs[1].course.estimatedCount)}点` : "") + "</span> "
        : "") +
      `${gpsChip}${modeChip} ${alignChip}${mismatchChip}`;
    // 地図は Leaflet、波形は Plotly と描画系を分離する。片方の初期化状態が
    // もう片方を壊さないよう、地図の準備後に波形を描画する。
    await renderChart("mp-map", () => renderMap(view));
    if (requestId !== mpRequestId) return;
    let waveReady = false;
    try {
      await ensurePlotly();
      if (requestId !== mpRequestId) return;
      await renderChart("mp-wave", () => renderWave(view));
      waveReady = true;
    } catch (waveError) {
      chartRegistry.delete("mp-wave");
      $("#mp-wave").innerHTML =
        `<div class="empty-note" style="padding:24px;">波形ライブラリの読み込みに失敗しました。地図と走行再生は利用できます。<br>${esc(waveError.message)}</div>`;
      toast("波形の読み込みに失敗しましたが、地図は表示を続けます", "error");
    }
    if (requestId !== mpRequestId) return;
    // 連動・再生の初期化で万一エラーが出ても、描画済みの地図は消さない
    try {
      if (waveReady) wireLinkedCursor(view);
      resetPlayback(view);
    } catch (linkErr) {
      console.warn("連動/再生の初期化に失敗しました:", linkErr);
    }
  } catch (e) {
    if (requestId === mpRequestId) {
      clearPlayback();
      toast(`エラー: ${e.message}`, "error");
      clearLeafletMap();
      window.Plotly?.purge?.("mp-wave");
      chartRegistry.delete("mp-map");
      chartRegistry.delete("mp-wave");
    }
  } finally {
    if (requestId === mpRequestId) setMapLoading(false);
  }
}

function setMapLoading(loading) {
  const button = $("#mp-plot");
  button.disabled = loading;
  button.textContent = loading ? "更新中…" : "🔄 更新";
  $("#mp-map").setAttribute("aria-busy", String(loading));
}

const HIGHLIGHT_COLOR = "#e3008c";

// バックエンドが値から決めた座標列・モードを選択欄に反映する
function reflectResolvedCoords(res) {
  if (res.mode === "geographic") {
    if (res.lat_col && $(`#mp-lat option[value="${CSS.escape(res.lat_col)}"]`)) $("#mp-lat").value = res.lat_col;
    if (res.lon_col && $(`#mp-lon option[value="${CSS.escape(res.lon_col)}"]`)) $("#mp-lon").value = res.lon_col;
  }
}

function buildTrackView(primary, secondary = null) {
  const colors = seriesColors();
  const primaryTimes = timelineSeconds(primary);
  const runs = [
    { key: "a", label: "走行 A", res: primary, times: primaryTimes, color: colors[0],
      course: buildCourseAxis(primary, primaryTimes), mapCompatible: true },
  ];
  // 走行Bの座標形式 (地図/平面) がAと違うと地図には重ねられない。波形比較は
  // 座標形式に関係なく使えるので、地図だけ諦めて全体を消さないようにする。
  const mapMismatch = !!secondary && secondary.mode !== primary.mode;
  if (secondary) {
    const secondaryTimes = timelineSeconds(secondary);
    runs.push({ key: "b", label: "走行 B", res: secondary,
      times: secondaryTimes, color: colors[1],
      course: buildCourseAxis(secondary, secondaryTimes), mapCompatible: !mapMismatch });
    if (!mapMismatch && runs.every((run) => run.course.usable)) {
      runs[1].course.localProgress = runs[1].course.progress;
      runs[1].course.progress = matchCourseProgress(runs[0], runs[1]);
    }
  }
  const view = {
    primary, secondary, runs, mode: primary.mode, offsetB: 0, mapMismatch,
    timeUnit: primary.x && secondary?.x ? "秒" : "サンプル",
    syncMode: secondary ? $("#mp-sync-mode").value : "manual",
  };
  if (view.syncMode === "course" && (mapMismatch || runs.some((run) => !run.course.usable))) {
    view.syncMode = "manual";
    $("#mp-sync-mode").value = "manual";
    updateSyncHint();
    toast(mapMismatch
      ? "走行 A と B で座標形式が異なるため、コース位置同期は使えません。時間・手動同期に切り替えました。"
      : "GPS実測点が不足しているため、時間・手動同期に切り替えました。", "error");
  }
  const alignment = $("#mp-alignment");
  alignment.hidden = !secondary || view.syncMode === "course";
  if (secondary) {
    const duration = Math.max(runs[0].times.at(-1) || 0, runs[1].times.at(-1) || 0, 60);
    const limit = Math.ceil(duration);
    $("#mp-align-offset").min = String(-limit);
    $("#mp-align-offset").max = String(limit);
    $("#mp-align-offset").step = view.timeUnit === "秒" ? "0.1" : "1";
    view.offsetB = Math.max(-limit, Math.min(limit, Number($("#mp-align-offset").value) || 0));
    $("#mp-align-offset").value = String(view.offsetB);
    updateAlignmentLabel(view.offsetB, view.timeUnit);
  } else {
    $("#mp-align-offset").value = "0";
    updateAlignmentLabel(0, view.timeUnit);
  }
  return view;
}

function renderMap(view) {
  return ensureLeaflet().then(() => {
    const map = ensureLeafletMap(view.mode);
    configureTileLayer(view.mode);
    if (leafletTrackLayer) map.removeLayer(leafletTrackLayer);
    leafletTrackLayer = createTrackCanvasLayer(view).addTo(map);
    fitLeafletBounds(view);
    map.invalidateSize(false);
  });
}

// 軌跡の色分け指定を決める (単独走行のみ)。信号 or 高度(GPS_z) → {値, ラベル}
function mapColorSpec(res, comparison) {
  if (comparison) return null;  // 2走行比較は走行色で区別するため色分けしない
  const v = $("#mp-color").value;
  if (v === "__alt__" && res.alt_values) return { values: res.alt_values, label: res.alt_col || "高度" };
  if (v && res.color_signal && res.color_values) return { values: res.color_values, label: res.color_signal };
  return null;
}

function ensureLeafletMap(mode) {
  if (leafletMap && leafletMode === mode) return leafletMap;
  destroyLeafletMap();
  const mapEl = $("#mp-map");
  if (mapEl._fullLayout && window.Plotly) Plotly.purge(mapEl);
  mapEl.innerHTML = "";
  leafletMode = mode;
  leafletMap = L.map(mapEl, {
    crs: mode === "planar" ? L.CRS.Simple : L.CRS.EPSG3857,
    attributionControl: mode !== "planar",
    zoomControl: true,
    minZoom: mode === "planar" ? -8 : 2,
    maxZoom: mode === "planar" ? 12 : 18,
    preferCanvas: true,
  });
  L.control.scale({ imperial: false, maxWidth: 140 }).addTo(leafletMap);
  return leafletMap;
}

function configureTileLayer(mode) {
  const mapEl = $("#mp-map");
  if (leafletTileLayer && leafletMap) leafletMap.removeLayer(leafletTileLayer);
  leafletTileLayer = null;
  tileErrorCount = 0;
  mapEl.classList.toggle("leaflet-planar", mode === "planar");
  mapEl.classList.toggle("leaflet-offline", mode === "planar" || mapStyle === "white-bg");
  if (mapStyleSel) mapStyleSel.disabled = mode === "planar";
  if (mode === "planar" || mapStyle === "white-bg") return;
  const layer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  });
  layer.on("tileerror", () => {
    if (leafletTileLayer !== layer) return;
    tileErrorCount += 1;
    if (tileErrorCount >= 3) fallbackToBlankMap();
  });
  layer.on("load", () => { tileErrorCount = 0; });
  leafletTileLayer = layer.addTo(leafletMap);
}

function destroyLeafletMap() {
  if (leafletMap) leafletMap.remove();
  leafletMap = null;
  leafletMode = null;
  leafletTileLayer = null;
  leafletTrackLayer = null;
}

function clearLeafletMap() {
  if (leafletMap && leafletTrackLayer) leafletMap.removeLayer(leafletTrackLayer);
  leafletTrackLayer = null;
}

function fitLeafletBounds(view) {
  // 前回表示したルート用の制限を解除してから、今回のルートへ合わせる。
  // fitBounds 後は初期表示の前後2段だけに絞り、ルートを見失うほどの
  // 拡大・縮小を防ぐ。
  const absoluteMin = view.mode === "planar" ? -8 : 2;
  const absoluteMax = view.mode === "planar" ? 12 : 18;
  leafletMap.setMinZoom(absoluteMin);
  leafletMap.setMaxZoom(absoluteMax);
  const bounds = L.latLngBounds([]);
  let pointCount = 0;
  let onlyPoint = null;
  for (const run of view.runs) {
    if (!run.mapCompatible) continue;
    for (let i = 0; i < run.course.filledX.length; i += 1) {
      const x = Number(run.course.filledX[i]);
      const y = Number(run.course.filledY[i]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        onlyPoint = [y, x];
        bounds.extend(onlyPoint);
        pointCount += 1;
      }
    }
  }
  if (!pointCount) return;
  if (pointCount === 1) {
    leafletMap.setView(onlyPoint, view.mode === "planar" ? 0 : 16);
  } else {
    leafletMap.fitBounds(bounds, { padding: [28, 28], maxZoom: 17 });
  }
  const fittedZoom = leafletMap.getZoom();
  leafletMap.setMinZoom(Math.max(absoluteMin, fittedZoom - 2));
  leafletMap.setMaxZoom(Math.min(absoluteMax, fittedZoom + 2));
}

const VIRIDIS = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];

function viridisColor(value, min, max) {
  if (!Number.isFinite(Number(value))) return "#999999";
  const ratio = max > min ? Math.max(0, Math.min(1, (Number(value) - min) / (max - min))) : 0.5;
  const scaled = ratio * (VIRIDIS.length - 1);
  const index = Math.min(VIRIDIS.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = VIRIDIS[index].match(/\w\w/g).map((part) => parseInt(part, 16));
  const b = VIRIDIS[index + 1].match(/\w\w/g).map((part) => parseInt(part, 16));
  const rgb = a.map((channel, i) => Math.round(channel + (b[i] - channel) * mix));
  return `rgb(${rgb.join(",")})`;
}

// Leaflet の地図操作だけを借り、軌跡は一枚の Canvas にまとめて描く。
// 点ごとの Leaflet レイヤーを作らないため、最大5万点でも初期化負荷が増えにくい。
function createTrackCanvasLayer(view) {
  const TrackCanvasLayer = L.Layer.extend({
    initialize(trackView) {
      this._view = trackView;
      this._highlightLayers = new Map();
      this._hoverFrame = null;
      this._drawFrame = null;
      this._lastHover = null;
    },

    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create("canvas", "vdas-track-canvas leaflet-zoom-animated");
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on("moveend zoomend resize", this._scheduleDraw, this);
      map.on("mousemove", this._onMouseMove, this);
      map.on("click", this._onClick, this);
      this._leave = () => this._clearHover(true);
      map.getContainer().addEventListener("mouseleave", this._leave);
      this._scheduleDraw();
    },

    onRemove(map) {
      map.off("moveend zoomend resize", this._scheduleDraw, this);
      map.off("mousemove", this._onMouseMove, this);
      map.off("click", this._onClick, this);
      map.getContainer().removeEventListener("mouseleave", this._leave);
      cancelAnimationFrame(this._drawFrame);
      cancelAnimationFrame(this._hoverFrame);
      for (const marker of this._highlightLayers.values()) map.removeLayer(marker);
      this._highlightLayers.clear();
      this._canvas?.remove();
      this._clearHover(false);
    },

    setHighlight(runIndex, pointIndex) {
      const run = this._view.runs[runIndex];
      if (!run?.mapCompatible || pointIndex == null) return;
      const latlng = [run.course.filledY[pointIndex], run.course.filledX[pointIndex]];
      let marker = this._highlightLayers.get(runIndex);
      if (!marker) {
        marker = L.circleMarker(latlng, {
          radius: 7,
          color: "#fff",
          weight: 3,
          opacity: 1,
          fillColor: HIGHLIGHT_COLOR,
          fillOpacity: 1,
          interactive: false,
        }).addTo(this._map);
        this._highlightLayers.set(runIndex, marker);
      } else {
        marker.setLatLng(latlng).setStyle({ opacity: 1, fillOpacity: 1 });
      }
    },

    hideHighlight(runIndex) {
      this._highlightLayers.get(runIndex)?.setStyle({ opacity: 0, fillOpacity: 0 });
    },

    _scheduleDraw() {
      cancelAnimationFrame(this._drawFrame);
      this._drawFrame = requestAnimationFrame(() => this._draw());
    },

    _draw() {
      if (!this._map || !this._canvas) return;
      const size = this._map.getSize();
      const ratio = window.devicePixelRatio || 1;
      const topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      this._canvas.style.width = `${size.x}px`;
      this._canvas.style.height = `${size.y}px`;
      this._canvas.width = Math.max(1, Math.round(size.x * ratio));
      this._canvas.height = Math.max(1, Math.round(size.y * ratio));
      const ctx = this._canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      const comparison = this._view.runs.filter((run) => run.mapCompatible).length > 1;
      this._screenPoints = new Map();
      for (const [runIndex, run] of this._view.runs.entries()) {
        if (!run.mapCompatible) continue;
        const screenPoints = run.course.filledX.map((x, i) =>
          this._map.latLngToContainerPoint([run.course.filledY[i], x]));
        this._screenPoints.set(runIndex, screenPoints);
        this._drawRun(ctx, run, runIndex, comparison, screenPoints);
      }
      this._drawLegend(ctx, size, comparison);
    },

    _drawRun(ctx, run, runIndex, comparison, screenPoints) {
      const estimated = run.course.estimated;
      const count = run.course.filledX.length;
      const cspec = mapColorSpec(run.res, comparison);
      const drawSegments = (estimatedSegment) => {
        ctx.beginPath();
        let active = false;
        for (let i = 1; i < count; i += 1) {
          const belongs = !!(estimated[i - 1] || estimated[i]);
          if (belongs !== estimatedSegment) {
            active = false;
            continue;
          }
          const from = screenPoints[i - 1];
          const to = screenPoints[i];
          if (!Number.isFinite(from.x + from.y + to.x + to.y)) {
            active = false;
            continue;
          }
          if (!active) ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
          active = true;
        }
        ctx.strokeStyle = run.color;
        ctx.lineWidth = estimatedSegment ? 4 : 3;
        ctx.globalAlpha = estimatedSegment ? 0.45 : 1;
        ctx.setLineDash(estimatedSegment ? [7, 6] : []);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      };
      drawSegments(false);
      if (run.course.estimatedCount) drawSegments(true);

      const stride = Math.max(1, Math.ceil(count / 12000));
      let min = Infinity;
      let max = -Infinity;
      for (const value of cspec?.values || []) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) continue;
        min = Math.min(min, numeric);
        max = Math.max(max, numeric);
      }
      if (!Number.isFinite(min)) [min, max] = [0, 1];
      for (let i = 0; i < count; i += stride) {
        if (estimated[i]) continue;
        const point = screenPoints[i];
        if (!Number.isFinite(point.x + point.y)) continue;
        ctx.beginPath();
        ctx.arc(point.x, point.y, cspec ? 3.2 : 2, 0, Math.PI * 2);
        ctx.fillStyle = cspec ? viridisColor(cspec.values[i], min, max) : run.color;
        ctx.fill();
      }
      run._leafletColorSpec = cspec ? { ...cspec, min, max } : null;
      run._leafletRunIndex = runIndex;
    },

    _drawLegend(ctx, size, comparison) {
      ctx.save();
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.textBaseline = "middle";
      if (comparison) {
        const width = 104;
        const height = 24 * this._view.runs.filter((run) => run.mapCompatible).length + 8;
        ctx.fillStyle = "rgba(255,255,255,.9)";
        ctx.fillRect(size.x - width - 10, 10, width, height);
        let y = 30;
        for (const run of this._view.runs) {
          if (!run.mapCompatible) continue;
          ctx.fillStyle = run.color;
          ctx.fillRect(size.x - width, y - 5, 18, 4);
          ctx.fillStyle = "#202020";
          ctx.fillText(run.label, size.x - width + 26, y - 3);
          y += 24;
        }
      }
      const spec = this._view.runs.find((run) => run._leafletColorSpec)?._leafletColorSpec;
      if (spec) {
        const x = size.x - 190;
        const y = size.y - 38;
        ctx.fillStyle = "rgba(255,255,255,.9)";
        ctx.fillRect(x - 8, y - 22, 188, 52);
        const gradient = ctx.createLinearGradient(x, 0, x + 160, 0);
        VIRIDIS.forEach((color, i) => gradient.addColorStop(i / (VIRIDIS.length - 1), color));
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, 160, 10);
        ctx.fillStyle = "#202020";
        ctx.fillText(spec.label, x, y - 10);
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.fillText(fmtNum(spec.min), x, y + 22);
        const maxText = fmtNum(spec.max);
        ctx.fillText(maxText, x + 160 - ctx.measureText(maxText).width, y + 22);
      }
      ctx.restore();
    },

    _nearest(latlng, limit = 12) {
      const cursor = this._map.latLngToContainerPoint(latlng);
      let nearest = null;
      let best = limit * limit;
      for (const [runIndex, run] of this._view.runs.entries()) {
        if (!run.mapCompatible) continue;
        const screenPoints = this._screenPoints?.get(runIndex) || [];
        for (let i = 0; i < screenPoints.length; i += 1) {
          const point = screenPoints[i];
          const distance = (point.x - cursor.x) ** 2 + (point.y - cursor.y) ** 2;
          if (distance <= best) {
            best = distance;
            nearest = { runIndex, pointIndex: i };
          }
        }
      }
      return nearest;
    },

    _onMouseMove(event) {
      this._pendingLatLng = event.latlng;
      if (this._hoverFrame) return;
      this._hoverFrame = requestAnimationFrame(() => {
        this._hoverFrame = null;
        const point = this._nearest(this._pendingLatLng);
        if (!point) return this._clearHover(true);
        this._lastHover = point;
        this._map.getContainer().style.cursor = "pointer";
        showLinkedForPoint(this._view, point);
        this._showTooltip(point, this._pendingLatLng);
      });
    },

    _onClick(event) {
      const point = this._nearest(event.latlng, 14);
      if (!point) return;
      stopPlayback();
      seekRunIndependently(point.runIndex, point.pointIndex);
    },

    _showTooltip(point, latlng) {
      const run = this._view.runs[point.runIndex];
      const res = run.res;
      const i = point.pointIndex;
      const coord = this._view.mode === "planar"
        ? `${res.px_col}: ${fmtNum(run.course.filledX[i])} / ${res.py_col}: ${fmtNum(run.course.filledY[i])}`
        : `緯度 ${Number(run.course.filledY[i]).toFixed(5)} / 経度 ${Number(run.course.filledX[i]).toFixed(5)}`;
      const color = run._leafletColorSpec;
      const extra = color ? `\n${color.label}: ${fmtNum(color.values[i])}` : "";
      const content = document.createElement("div");
      content.textContent = `${run.label}\n${coord}${extra}`;
      content.style.whiteSpace = "pre-line";
      if (!this._tooltip) this._tooltip = L.tooltip({ direction: "top", offset: [0, -8] });
      this._tooltip.setLatLng(latlng).setContent(content).openOn(this._map);
    },

    _clearHover(restore) {
      this._lastHover = null;
      if (this._map) {
        this._map.getContainer().style.cursor = "";
        if (this._tooltip) this._map.closeTooltip(this._tooltip);
      }
      if (restore) restorePlaybackPosition();
    },
  });
  return new TrackCanvasLayer(view);
}

// 波形: 信号ごとに帯を積み重ね、X軸 (時間/サンプル) を共有
function renderWave(view) {
  const el = $("#mp-wave");
  const signals = Object.keys(view.primary.signals);
  if (!signals.length) {
    Plotly.purge("mp-wave");
    el.innerHTML = '<div class="empty-note" style="padding:24px;">波形に表示する信号を選択してください。</div>';
    return Promise.resolve();
  }
  el.innerHTML = "";
  const comparison = view.runs.length > 1;
  const xlabel = comparison && view.syncMode === "course"
    ? "コース進捗 (%)"
    : comparison ? `経過${view.timeUnit === "秒" ? "時間" : "位置"} (${view.timeUnit}・走行 B はオフセット適用)` :
    (view.primary.x || "サンプル番号");
  const k = signals.length;
  const rowHeight = 130;
  const chartHeight = Math.max(320, rowHeight * k + 80);
  const gap = Math.min(0.04, 0.14 / k);
  const bandH = (1 - gap * (k - 1)) / k;

  const layout = baseLayout({
    height: chartHeight,
    showlegend: false,
    hovermode: "x unified",
    margin: { l: 64, r: 20, t: 20, b: 44 },
    annotations: [],
    shapes: [],
  });
  const gridStyle = layout.yaxis;
  delete layout.yaxis;

  const traces = [];
  signals.forEach((name, signalIndex) => {
    view.runs.forEach((run, runIndex) => {
      if (!(name in run.res.signals)) return;
      const offset = runIndex === 1 ? view.offsetB : 0;
      const xvals = comparison
        ? (view.syncMode === "course"
          ? run.course.progress.map((value) => value * 100)
          : run.times.map((value) => value + offset))
        : (run.res.x_values || run.res.index);
      traces.push({
        type: "scattergl", mode: "lines",
        name: comparison ? `${name} · ${run.label}` : name,
        x: xvals, y: run.res.signals[name],
        yaxis: signalIndex === 0 ? "y" : `y${signalIndex + 1}`,
        line: { width: comparison ? 1.8 : 2, color: run.color },
        customdata: run.res.index.map((_, pointIndex) => ({ runIndex, pointIndex })),
        hovertemplate: `%{y}<extra>${esc(name)}${comparison ? ` · ${run.label}` : ""}</extra>`,
      });
    });
  });

  signals.forEach((name, i) => {
    const top = 1 - i * (bandH + gap);
    const bottom = Math.max(0, top - bandH);
    const headerH = Math.min(20 / chartHeight, bandH * 0.3);
    layout[i === 0 ? "yaxis" : `yaxis${i + 1}`] = Object.assign({}, gridStyle, {
      domain: [bottom, Math.max(bottom + 0.01, top - headerH)],
      tickfont: { size: 10 },
    });
    layout.annotations.push({
      xref: "paper", yref: "paper", x: 0, y: top,
      xanchor: "left", yanchor: "top", showarrow: false, align: "left",
      text: `<b>${esc(name)}</b>`,
      font: { size: 11, color: cssVar("--text-primary") },
    });
  });
  layout.xaxis = Object.assign(layout.xaxis, {
    domain: [0, 1], anchor: k === 1 ? "y" : `y${k}`, title: { text: xlabel },
  });
  return Plotly.react("mp-wave", traces, layout, PLOT_CONFIG);
}

// ---------- 地図 ⇔ 波形 の連動カーソル ----------

function wireLinkedCursor(view) {
  const waveEl = $("#mp-wave");
  waveEl.removeAllListeners?.("plotly_hover");
  waveEl.removeAllListeners?.("plotly_unhover");
  waveEl.removeAllListeners?.("plotly_click");

  // 波形にホバー → 地図の対応点を光らせる
  waveEl.on?.("plotly_hover", (ev) => {
    const point = ev.points?.[0]?.customdata;
    if (!point) return;
    showLinkedForPoint(view, point);
  });
  waveEl.on?.("plotly_unhover", restorePlaybackPosition);
  waveEl.on?.("plotly_click", (ev) => seekFromPlotEvent(view, ev));
}

function highlightMapPoint(view, runIndex, idx) {
  const run = view.runs[runIndex];
  if (!run?.mapCompatible) return;
  leafletTrackLayer?.setHighlight(runIndex, idx);
}

function verticalLine(x) {
  return {
    type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1,
    line: { color: HIGHLIGHT_COLOR, width: 1.5, dash: "dot" },
  };
}

// ---------- 走行再生 ----------

$("#mp-play-toggle").addEventListener("click", () => {
  if (!playback.res) return;
  playback.playing ? stopPlayback() : startPlayback();
});

$("#mp-play-reset").addEventListener("click", () => {
  stopPlayback();
  playback.indexB = 0;
  if (playback.res?.secondary) {
    setAlignmentFromSelectedPositions(0, 0);
    applyAlignment();
  }
  setPlaybackIndex(0);
});

$("#mp-play-seek").addEventListener("input", (event) => {
  stopPlayback();
  seekRunIndependently(0, Number(event.target.value));
});

$("#mp-play-seek-b").addEventListener("input", (event) => {
  stopPlayback();
  seekRunIndependently(1, Number(event.target.value));
});

const applyAlignment = debounce(() => {
  if (!playback.res?.secondary || !window.Plotly) return;
  renderWave(playback.res);
  wireLinkedCursor(playback.res);
  setPlaybackIndex(playback.index);
}, 80);

$("#mp-align-offset").addEventListener("input", (event) => {
  if (!playback.res?.secondary) return;
  playback.res.offsetB = Number(event.target.value) || 0;
  updateAlignmentLabel(playback.res.offsetB, playback.res.timeUnit);
  applyAlignment();
});

$("#mp-align-reset").addEventListener("click", () => {
  $("#mp-align-offset").value = "0";
  $("#mp-align-offset").dispatchEvent(new Event("input"));
});

function updateAlignmentLabel(offset, unit = "秒") {
  const digits = unit === "秒" ? 1 : 0;
  $("#mp-align-value").textContent = `${offset >= 0 ? "+" : ""}${offset.toFixed(digits)} ${unit}`;
}

function resetPlayback(view) {
  stopPlayback();
  playback.res = view;
  playback.index = 0;
  playback.indexB = 0;
  playback.fractionalStep = 0;
  const seek = $("#mp-play-seek");
  seek.min = "0";
  seek.max = String(Math.max(0, view.primary.index.length - 1));
  seek.value = "0";
  const seekB = $("#mp-play-seek-b");
  seekB.min = "0";
  seekB.max = String(Math.max(0, (view.secondary?.index.length || 1) - 1));
  seekB.value = "0";
  $("#mp-playback-secondary").hidden = !view.secondary;
  setPlaybackEnabled(view.primary.index.length > 0);
  setPlaybackIndex(0);
}

function clearPlayback() {
  stopPlayback();
  playback.res = null;
  playback.index = 0;
  playback.indexB = 0;
  playback.fractionalStep = 0;
  setPlaybackEnabled(false);
  $("#mp-play-seek").max = "0";
  $("#mp-play-seek").value = "0";
  $("#mp-play-position").textContent = "— / —";
  $("#mp-play-seek-b").max = "0";
  $("#mp-play-seek-b").value = "0";
  $("#mp-play-position-b").textContent = "— / —";
  $("#mp-playback-secondary").hidden = true;
  $("#mp-alignment").hidden = true;
}

function setPlaybackEnabled(enabled) {
  $("#mp-play-toggle").disabled = !enabled;
  $("#mp-play-reset").disabled = !enabled;
  $("#mp-play-seek").disabled = !enabled;
  $("#mp-play-seek-b").disabled = !enabled || !playback.res?.secondary;
}

function startPlayback() {
  if (!playback.res?.primary.index.length) return;
  if (playback.index >= playback.res.primary.index.length - 1) setPlaybackIndex(0);
  playback.playing = true;
  playback.lastFrame = 0;
  playback.fractionalStep = 0;
  $("#mp-play-toggle").textContent = "⏸ 一時停止";
  playback.frameId = requestAnimationFrame(playbackFrame);
}

function stopPlayback() {
  playback.playing = false;
  if (playback.frameId != null) cancelAnimationFrame(playback.frameId);
  playback.frameId = null;
  playback.lastFrame = 0;
  $("#mp-play-toggle").textContent = "▶ 再生";
}

function playbackFrame(timestamp) {
  if (!playback.playing || !playback.res) return;
  if (!playback.lastFrame) playback.lastFrame = timestamp;
  const elapsedSeconds = Math.min(0.25, (timestamp - playback.lastFrame) / 1000);
  playback.lastFrame = timestamp;
  const speed = Number($("#mp-play-speed").value) || 1;
  playback.fractionalStep += elapsedSeconds * PLAYBACK_POINTS_PER_SECOND * speed;
  const steps = Math.floor(playback.fractionalStep);
  if (steps > 0) {
    playback.fractionalStep -= steps;
    const last = playback.res.primary.index.length - 1;
    setPlaybackIndex(Math.min(last, playback.index + steps));
    if (playback.index >= last) {
      stopPlayback();
      return;
    }
  }
  playback.frameId = requestAnimationFrame(playbackFrame);
}

function setPlaybackIndex(index) {
  if (!playback.res?.primary.index.length) return;
  const view = playback.res;
  const last = playback.res.primary.index.length - 1;
  playback.index = Math.max(0, Math.min(last, Math.round(index)));
  const masterTime = view.runs[0].times[playback.index];
  if (view.secondary) {
    playback.indexB = view.syncMode === "course"
      ? nearestIndex(view.runs[1].course.progress,
        view.runs[0].course.progress[playback.index])
      : nearestIndex(view.runs[1].times, masterTime - view.offsetB);
  }
  $("#mp-play-seek").value = String(playback.index);
  $("#mp-play-seek-b").value = String(playback.indexB);
  updatePlaybackPositionLabels(view, masterTime);
  if (view.syncMode === "course" && view.secondary) {
    showLinkedAtCourseProgress(view, view.runs[0].course.progress[playback.index]);
  } else {
    showLinkedAtTime(view, masterTime);
  }
}

function seekRunIndependently(runIndex, index) {
  const view = playback.res;
  if (!view) return;
  if (runIndex === 0) {
    playback.index = clampIndex(index, view.primary.index.length);
  } else if (view.secondary) {
    playback.indexB = clampIndex(index, view.secondary.index.length);
  }
  if (view.secondary) {
    if (view.syncMode === "course") {
      const sourceRun = view.runs[runIndex];
      const sourceIndex = runIndex === 0 ? playback.index : playback.indexB;
      const progress = sourceRun.course.progress[sourceIndex];
      playback.index = nearestIndex(view.runs[0].course.progress, progress);
      playback.indexB = nearestIndex(view.runs[1].course.progress, progress);
      $("#mp-play-seek").value = String(playback.index);
      $("#mp-play-seek-b").value = String(playback.indexB);
      updatePlaybackPositionLabels(view, view.runs[0].times[playback.index]);
      showLinkedAtCourseProgress(view, progress);
      return;
    }
    setAlignmentFromSelectedPositions(playback.index, playback.indexB);
    applyAlignment();
  } else {
    setPlaybackIndex(playback.index);
  }
}

function setAlignmentFromSelectedPositions(indexA, indexB) {
  const view = playback.res;
  if (!view?.secondary) return;
  view.offsetB = view.runs[0].times[indexA] - view.runs[1].times[indexB];
  const slider = $("#mp-align-offset");
  const limit = Math.max(Math.abs(Number(slider.min)), Math.abs(Number(slider.max)),
    Math.ceil(Math.abs(view.offsetB)));
  slider.min = String(-limit);
  slider.max = String(limit);
  slider.value = String(view.offsetB);
  updateAlignmentLabel(view.offsetB, view.timeUnit);
  $("#mp-play-seek").value = String(indexA);
  $("#mp-play-seek-b").value = String(indexB);
  updatePlaybackPositionLabels(view, view.runs[0].times[indexA]);
  highlightMapPoint(view, 0, indexA);
  highlightMapPoint(view, 1, indexB);
}

function clampIndex(index, length) {
  return Math.max(0, Math.min(length - 1, Math.round(index)));
}

function showLinkedAtTime(view, masterTime) {
  view.runs.forEach((run, runIndex) => {
    const rawTime = masterTime - (runIndex === 1 ? view.offsetB : 0);
    if (rawTime < run.times[0] || rawTime > run.times.at(-1)) {
      hideMapPoint(runIndex);
      return;
    }
    const idx = nearestIndex(run.times, rawTime);
    highlightMapPoint(view, runIndex, idx);
  });
  if (window.Plotly && Object.keys(view.primary.signals).length) {
    const x = view.secondary
      ? masterTime
      : (view.primary.x_values || view.primary.index)[nearestIndex(view.runs[0].times, masterTime)];
    Plotly.relayout("mp-wave", { shapes: [verticalLine(x)] });
  }
}

function showLinkedAtCourseProgress(view, progress) {
  view.runs.forEach((run, runIndex) => {
    const idx = nearestIndex(run.course.progress, progress);
    highlightMapPoint(view, runIndex, idx);
  });
  if (window.Plotly && Object.keys(view.primary.signals).length) {
    Plotly.relayout("mp-wave", { shapes: [verticalLine(progress * 100)] });
  }
}

function showLinkedForPoint(view, point) {
  if (view.syncMode === "course" && view.secondary) {
    const run = view.runs[point.runIndex];
    showLinkedAtCourseProgress(view, run.course.progress[point.pointIndex]);
  } else {
    showLinkedAtTime(view, masterTimeForPoint(view, point));
  }
}

function hideMapPoint(runIndex) {
  leafletTrackLayer?.hideHighlight(runIndex);
}

function restorePlaybackPosition() {
  if (playback.res) {
    if (playback.res.syncMode === "course" && playback.res.secondary) {
      showLinkedAtCourseProgress(playback.res,
        playback.res.runs[0].course.progress[playback.index]);
    } else {
      showLinkedAtTime(playback.res, playback.res.runs[0].times[playback.index]);
    }
  }
}

function seekFromPlotEvent(view, event) {
  const point = event.points?.[0]?.customdata;
  if (!point) return;
  stopPlayback();
  seekRunIndependently(point.runIndex, point.pointIndex);
}

function masterTimeForPoint(view, point) {
  const run = view.runs[point.runIndex];
  return run.times[point.pointIndex] + (point.runIndex === 1 ? view.offsetB : 0);
}

function nearestIndex(values, target) {
  if (!values.length) return 0;
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  if (low > 0 && Math.abs(values[low - 1] - target) <= Math.abs(values[low] - target)) {
    return low - 1;
  }
  return low;
}

function updatePlaybackPositionLabels(view, masterTime) {
  $("#mp-play-position").textContent = runPositionLabel(view.runs[0], playback.index);
  if (!view.secondary) return;
  if (view.syncMode === "course") {
    $("#mp-play-position-b").textContent = runPositionLabel(view.runs[1], playback.indexB);
    return;
  }
  const rawTimeB = masterTime - view.offsetB;
  const inRange = rawTimeB >= view.runs[1].times[0] && rawTimeB <= view.runs[1].times.at(-1);
  $("#mp-play-position-b").textContent = inRange
    ? runPositionLabel(view.runs[1], playback.indexB)
    : "範囲外";
}

function runPositionLabel(run, index) {
  const res = run.res;
  const value = (res.x_values || res.index)[index];
  const estimate = run.course.estimated[index] ? "・GPS推定" : "";
  return `${formatPositionValue(value)}  (${index + 1} / ${res.index.length}${estimate})`;
}

function formatPositionValue(value) {
  if (value == null) return "—";
  if (typeof value === "number") return fmtNum(value);
  const text = String(value);
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /[-T:/]/.test(text)) {
    return parsed.toLocaleString("ja-JP");
  }
  return text;
}

export async function loadMapView(view) {
  const config = view.config || {};
  $("#mp-dataset").value = view.dataset_id || "";
  $("#mp-dataset").dispatchEvent(new Event("change"));
  await waitForMap(() => state.mp.schema?.dataset?.id === view.dataset_id);
  setSelectedSignals((config.signals || []).filter((name) =>
    state.mp.schema?.columns.some((column) => column.name === name)));
  state.mp.filters = (config.filters || []).map((filter) => ({ ...filter }));
  renderFilters("#mp-filters", state.mp);
  if (config.gps_id) $("#mp-gps").value = config.gps_id;
  if (config.lat_col) $("#mp-lat").value = config.lat_col;
  if (config.lon_col) $("#mp-lon").value = config.lon_col;
  if (config.color_signal) $("#mp-color").value = config.color_signal;
  if (config.max_points) $("#mp-maxpoints").value = config.max_points;
  if (config.sync_mode) {
    $("#mp-sync-mode").value = config.sync_mode;
    updateSyncHint();
  }
  if (config.dataset_id_b) {
    $("#mp-dataset-b").value = config.dataset_id_b;
    $("#mp-dataset-b").dispatchEvent(new Event("change"));
    await waitForMap(() => state.mp.schemaB?.dataset?.id === config.dataset_id_b);
    if (config.gps_id_b) $("#mp-gps-b").value = config.gps_id_b;
  }
  $("#mp-align-offset").value = String(config.offset_b || 0);
  await plotMap();
}

function waitForMap(condition, timeout = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    (function poll() {
      if (condition() || Date.now() - started > timeout) return resolve();
      setTimeout(poll, 50);
    })();
  });
}

// ---------- ビュー保存 ----------

$("#mp-save-view").addEventListener("click", async () => {
  const dsId = $("#mp-dataset").value;
  if (!dsId) return toast("信号データセットを選択してください", "error");
  const name = await openNameDialog("GPS・地図ビューを保存");
  if (!name) return;
  await api("/api/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, kind: "map", dataset_id: dsId,
      config: {
        signals: selectedSignalList(),
        color_signal: $("#mp-color").value || null,
        gps_id: $("#mp-gps").value || null,
        dataset_id_b: $("#mp-dataset-b").value || null,
        gps_id_b: $("#mp-gps-b").value || null,
        offset_b: Number($("#mp-align-offset").value) || 0,
        sync_mode: $("#mp-sync-mode").value,
        lat_col: $("#mp-lat").value || null,
        lon_col: $("#mp-lon").value || null,
        filters: activeFilters(state.mp),
        max_points: +$("#mp-maxpoints").value || 5000,
      },
    }),
  });
  toast(`ビュー「${name}」を保存しました`);
});
