/* GPS タブ専用の Leaflet 遅延ローダー。CDN に依存せず同梱版を使う。 */
const LEAFLET_JS_URL = "/static/vendor/leaflet/leaflet.js";
const LEAFLET_CSS_URL = "/static/vendor/leaflet/leaflet.css";
let leafletPromise = null;
let stylesheetPromise = null;

function ensureStylesheet() {
  const existing = document.querySelector(`link[href="${LEAFLET_CSS_URL}"]`);
  if (existing?.sheet) return Promise.resolve();
  if (stylesheetPromise) return stylesheetPromise;
  stylesheetPromise = new Promise((resolve, reject) => {
    const link = existing || document.createElement("link");
    link.rel = "stylesheet";
    link.href = LEAFLET_CSS_URL;
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", () => {
      link.remove();
      stylesheetPromise = null;
      reject(new Error("Leaflet のスタイル読み込みに失敗しました"));
    }, { once: true });
    if (!existing) document.head.appendChild(link);
  });
  return stylesheetPromise;
}

function loadScript() {
  return new Promise((resolve, reject) => {
    const stale = document.querySelector(`script[src="${LEAFLET_JS_URL}"]`);
    stale?.remove();
    const script = document.createElement("script");
    script.src = LEAFLET_JS_URL;
    script.async = true;
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error("Leaflet の読み込みがタイムアウトしました"));
    }, 10000);
    script.addEventListener("load", () => {
      clearTimeout(timer);
      window.L ? resolve(window.L) : reject(new Error("Leaflet を初期化できませんでした"));
    }, { once: true });
    script.addEventListener("error", () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error("Leaflet の読み込みに失敗しました"));
    }, { once: true });
    document.head.appendChild(script);
  });
}

export function ensureLeaflet() {
  if (window.L?.map) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = (async () => {
    await ensureStylesheet();
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await loadScript();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  })().catch((error) => {
    leafletPromise = null;
    throw error;
  });
  return leafletPromise;
}
