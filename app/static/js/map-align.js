/* GPS・地図タブの走行整列・コース幾何ロジック (純関数のみ)。
 *
 * 波形の時間軸化・GPS欠損区間の補間・走行A/Bのコース位置対応づけなど、
 * DOM やモジュール状態に依存しない計算をここに集約する。map.js から
 * 引数と戻り値だけでやり取りする。 */

// 波形に速度らしい信号が無ければ、コース補間に使うため一時的に付け足す。
export function withSpeedAssist(schema, selected) {
  const speed = schema?.columns.find((column) => column.kind === "numeric" &&
    /speed|vehicle.*spd|車速|km.?h/i.test(column.name))?.name;
  return {
    signals: speed && !selected.includes(speed) ? [...selected, speed] : selected,
    assist: speed && !selected.includes(speed) ? speed : null,
  };
}

// 付け足した速度信号は波形には出さず、コース補間用に退避する。
export function detachSpeedAssist(res, assist) {
  if (!assist || !(assist in res.signals)) return;
  res.sync_speed_values = res.signals[assist];
  delete res.signals[assist];
}

export function timelineSeconds(res) {
  const values = res.x_values || res.index;
  if (!values.length) return [];
  const dateValues = values.map((value) => {
    if (typeof value !== "string" || !/[-T:/]/.test(value)) return NaN;
    return new Date(value).getTime();
  });
  if (dateValues.every(Number.isFinite)) {
    const first = dateValues[0];
    return dateValues.map((value) => (value - first) / 1000);
  }
  const numeric = values.map(Number);
  if (numeric.every(Number.isFinite)) {
    const first = numeric[0];
    const positiveDeltas = numeric.slice(1)
      .map((value, i) => value - numeric[i])
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
    const medianDelta = positiveDeltas[Math.floor(positiveDeltas.length / 2)] || 1;
    const scale = Math.abs(first) > 1e11 || medianDelta > 1000 ? 1000 : 1;
    return numeric.map((value) => (value - first) / scale);
  }
  return values.map((_, i) => i);
}

export function buildCourseAxis(res, times) {
  const geographic = res.mode === "geographic";
  const sourceX = geographic ? res.lon : res.px;
  const sourceY = geographic ? res.lat : res.py;
  const x = sourceX.map(toFiniteNumber);
  const y = sourceY.map(toFiniteNumber);
  const hasRealOrigin = geographic && x.some((value, i) =>
    Number.isFinite(value) && Number.isFinite(y[i]) &&
    (Math.abs(value) > 0.000001 || Math.abs(y[i]) > 0.000001));
  const valid = x.map((value, i) => Number.isFinite(value) && Number.isFinite(y[i]) &&
    (!geographic || (Math.abs(y[i]) <= 90 && Math.abs(value) <= 180)) &&
    (!hasRealOrigin || Math.abs(value) > 0.000001 || Math.abs(y[i]) > 0.000001));
  const speed = findSpeedSeries(res);
  if (speed) {
    let lastMovingAnchor = valid.findIndex(Boolean);
    for (let i = lastMovingAnchor + 1; i < valid.length; i += 1) {
      if (!valid[i]) continue;
      const unchanged = Math.abs(x[i] - x[lastMovingAnchor]) < 1e-10 &&
        Math.abs(y[i] - y[lastMovingAnchor]) < 1e-10;
      if (unchanged && Number(speed[i]) > 0.5) {
        valid[i] = false;
      } else {
        lastMovingAnchor = i;
      }
    }
  }
  const estimated = valid.map((isValid) => !isValid);
  const filledX = [...x];
  const filledY = [...y];
  const anchors = valid.map((isValid, i) => isValid ? i : -1).filter((i) => i >= 0);

  if (!anchors.length) {
    const fallback = res.index.map((_, i) => res.index.length > 1 ? i / (res.index.length - 1) : 0);
    return { progress: fallback, filledX, filledY, estimated,
      estimatedCount: estimated.length, usable: false };
  }

  const first = anchors[0];
  for (let i = 0; i < first; i += 1) {
    filledX[i] = filledX[first];
    filledY[i] = filledY[first];
  }
  for (let a = 0; a < anchors.length - 1; a += 1) {
    const start = anchors[a];
    const end = anchors[a + 1];
    if (end === start + 1) continue;
    const fractions = gapFractions(res, times, start, end);
    for (let i = start + 1; i < end; i += 1) {
      const fraction = fractions[i - start];
      filledX[i] = filledX[start] + (filledX[end] - filledX[start]) * fraction;
      filledY[i] = filledY[start] + (filledY[end] - filledY[start]) * fraction;
    }
  }
  const last = anchors.at(-1);
  for (let i = last + 1; i < filledX.length; i += 1) {
    filledX[i] = filledX[last];
    filledY[i] = filledY[last];
  }

  const distance = [0];
  for (let i = 1; i < filledX.length; i += 1) {
    const segment = geographic
      ? haversineMeters(filledY[i - 1], filledX[i - 1], filledY[i], filledX[i])
      : Math.hypot(filledX[i] - filledX[i - 1], filledY[i] - filledY[i - 1]);
    distance.push(distance.at(-1) + (Number.isFinite(segment) ? segment : 0));
  }
  const total = distance.at(-1);
  const progress = total > 0
    ? distance.map((value) => value / total)
    : distance.map((_, i) => distance.length > 1 ? i / (distance.length - 1) : 0);
  return {
    progress, filledX, filledY, estimated,
    estimatedCount: estimated.filter(Boolean).length,
    usable: anchors.length >= 2,
  };
}

function gapFractions(res, times, start, end) {
  const speed = findSpeedSeries(res);
  const weights = [];
  for (let i = start + 1; i <= end; i += 1) {
    const dt = Math.max(0.000001, (times[i] ?? i) - (times[i - 1] ?? (i - 1)));
    const velocity = speed
      ? Math.max(0, (Number(speed[i - 1]) + Number(speed[i])) / 2)
      : 1;
    weights.push(Number.isFinite(velocity) && velocity > 0 ? velocity * dt : dt);
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cumulative = 0;
  return [0, ...weights.map((weight) => {
    cumulative += weight;
    return total > 0 ? cumulative / total : cumulative / weights.length;
  })];
}

function findSpeedSeries(res) {
  if (res.sync_speed_values) return res.sync_speed_values;
  const entry = Object.entries(res.signals).find(([name]) =>
    /speed|vehicle.*spd|車速|km.?h/i.test(name));
  return entry?.[1] || null;
}

function toFiniteNumber(value) {
  if (value == null || value === "") return NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function matchCourseProgress(referenceRun, targetRun) {
  const reference = referenceRun.course;
  const target = targetRun.course;
  const refLength = reference.progress.length;
  const targetLength = target.progress.length;
  if (!refLength || !targetLength) return target.progress;
  const geographic = referenceRun.res.mode === "geographic";
  let previous = nearestCoursePoint(reference, target, 0, 0, refLength - 1, geographic);
  const matched = [reference.progress[previous]];
  const typicalAdvance = Math.max(1, refLength / Math.max(1, targetLength));
  const searchAhead = Math.max(40, Math.ceil(typicalAdvance * 30));
  for (let i = 1; i < targetLength; i += 1) {
    const end = Math.min(refLength - 1, previous + searchAhead);
    previous = nearestCoursePoint(reference, target, i, previous, end, geographic);
    matched.push(reference.progress[previous]);
  }
  return matched;
}

function nearestCoursePoint(reference, target, targetIndex, start, end, geographic) {
  let best = start;
  let bestDistance = Infinity;
  const tx = target.filledX[targetIndex];
  const ty = target.filledY[targetIndex];
  const lonScale = geographic ? Math.cos(ty * Math.PI / 180) : 1;
  for (let i = start; i <= end; i += 1) {
    const dx = (reference.filledX[i] - tx) * lonScale;
    const dy = reference.filledY[i] - ty;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
