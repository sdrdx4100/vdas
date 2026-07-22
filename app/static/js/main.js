/* エントリポイント: 各タブモジュールを読み込み (副作用でイベント登録)、初期データを読み込む */
import "./api.js";
import "./charts.js";
import "./nav.js";
import "./timeseries.js";
import "./stats.js";
import "./explore.js";
import "./analysis.js";
import "./clustering.js";
import "./workspace.js";
import { refreshDatasets } from "./datasets.js";
import { refreshLabelsets } from "./views.js";
import { toast } from "./api.js";

(async function init() {
  try {
    await refreshDatasets();
    await refreshLabelsets();
  } catch (e) {
    toast(`初期化エラー: ${e.message}`, "error");
  }
})();
