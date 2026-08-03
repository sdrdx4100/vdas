/* エントリポイント: 各タブモジュールを読み込み (副作用でイベント登録)、初期データを読み込む */
import "./api.js";
import "./charts.js";
import "./nav.js";
import "./timeseries.js";
import "./stats.js";
import "./explore.js";
import "./analysis.js";
import "./tscompare.js";
import "./clustering.js";
import "./workspace.js";
import { refreshDatasets } from "./datasets.js";
import { refreshLabelsets } from "./views.js";
import { toast } from "./api.js";
import { preloadPlotly } from "./plotly-loader.js";

// データ管理画面の初期表示を妨げず、ブラウザが空いた時点でグラフエンジンを先読みする。
preloadPlotly();

(async function init() {
  try {
    await refreshDatasets();
    await refreshLabelsets();
  } catch (e) {
    toast(`初期化エラー: ${e.message}`, "error");
  }
})();
