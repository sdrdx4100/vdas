/* 重い Plotly 本体は初期画面を塞がずに読み込み、失敗時は一度だけ再試行する。 */

const PLOTLY_URL = "/vendor/plotly.min.js";
let plotlyPromise = null;

function loadScript(attempt) {
  return new Promise((resolve, reject) => {
    if (window.Plotly) return resolve(window.Plotly);

    const script = document.createElement("script");
    script.src = attempt ? `${PLOTLY_URL}?retry=${attempt}` : PLOTLY_URL;
    script.async = true;
    script.dataset.vdasPlotly = String(attempt);
    script.onload = () => {
      if (window.Plotly) resolve(window.Plotly);
      else reject(new Error("Plotly の初期化を確認できませんでした"));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("Plotly の JavaScript を読み込めませんでした"));
    };
    document.head.appendChild(script);
  });
}

export function ensurePlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (plotlyPromise) return plotlyPromise;

  plotlyPromise = (async () => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await loadScript(attempt);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  })().catch((error) => {
    // 次にタブを開いたときは再度試せるようにする。
    plotlyPromise = null;
    throw error;
  });
  return plotlyPromise;
}

export function preloadPlotly() {
  const start = () => ensurePlotly().catch(() => {
    // 先読みの失敗は操作時の ensurePlotly で再試行し、そこでユーザーへ通知する。
  });
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(start, { timeout: 1500 });
  } else {
    setTimeout(start, 0);
  }
}
