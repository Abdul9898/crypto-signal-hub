// Shared Indicator Engine for Crypto Signal Hub (Node.js & Browser ES Module)

export const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'DOGEUSDT', 'ADAUSDT', 'XRPUSDT', 'AVAXUSDT',
  'PEPEUSDT', 'SHIBUSDT', 'NEARUSDT', 'SUIUSDT'
];

export const DEFAULT_CHART_MODE = 'Wickless SuperTrend';

export const CHART_MODES = [
  'Wickless SuperTrend',
  'Line Break Style',
  'Renko Style',
  'Heikin Ashi',
  'Wickless',
  'Normal'
];

/**
 * Format crypto price or step value cleanly without truncating micro-cap coins to $0.00.
 */
export function formatPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '$0.00';
  const abs = Math.abs(num);
  if (abs === 0) return '$0.00';
  if (abs >= 1) {
    return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (abs >= 0.01) {
    return '$' + num.toFixed(4);
  }
  if (abs >= 0.0001) {
    return '$' + num.toFixed(6);
  }
  return '$' + num.toFixed(8);
}

/**
 * Compute bar-by-bar Wilder RMA ATR series matching TradingView ta.atr(period).
 */
export function calculateATRSeries(highs, lows, closes, period = 14) {
  const len = closes.length;
  const atrArr = new Array(len).fill(0);
  if (len < 2) return atrArr;

  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < len; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  const seedLen = Math.min(period, len);
  let sum = 0;
  for (let i = 0; i < seedLen; i++) sum += tr[i];
  const startIdx = seedLen - 1;
  atrArr[startIdx] = sum / seedLen;

  for (let i = startIdx + 1; i < len; i++) {
    atrArr[i] = (atrArr[i - 1] * (period - 1) + tr[i]) / period;
  }
  for (let i = 0; i < startIdx; i++) {
    atrArr[i] = atrArr[startIdx];
  }
  return atrArr;
}

/**
 * Compute Wickless SuperTrend using close-to-close wickless bodies and real Wilder ATR bands.
 */
function computeWicklessSuperTrend(opens, highs, lows, closes, factor = 2.0, atrLen = 10) {
  const len = closes.length;
  const wOpen = [];
  const wClose = [];
  const wHigh = [];
  const wLow = [];

  for (let i = 0; i < len; i++) {
    const o = i > 0 ? closes[i - 1] : opens[0];
    const c = closes[i];
    wOpen.push(o);
    wClose.push(c);
    wHigh.push(Math.max(o, c));
    wLow.push(Math.min(o, c));
  }

  const atrArr = calculateATRSeries(highs, lows, closes, atrLen);
  const startIdx = Math.min(atrLen - 1, len - 2);
  let upBand = 0;
  let downBand = 0;
  let trend = 1;
  let prevTrend = 1;

  for (let i = startIdx; i < len; i++) {
    const hl2 = (wHigh[i] + wLow[i]) / 2;
    const atr = atrArr[i];
    const basicUp = hl2 - factor * atr;
    const basicDown = hl2 + factor * atr;

    if (i === startIdx) {
      upBand = basicUp;
      downBand = basicDown;
      trend = wClose[i] >= wOpen[i] ? 1 : -1;
      prevTrend = trend;
      continue;
    }

    const prevUp = upBand;
    const prevDown = downBand;
    prevTrend = trend;

    upBand = wClose[i - 1] > prevUp ? Math.max(basicUp, prevUp) : basicUp;
    downBand = wClose[i - 1] < prevDown ? Math.min(basicDown, prevDown) : basicDown;

    if (prevTrend === 1 && wClose[i] < prevUp) {
      trend = -1;
    } else if (prevTrend === -1 && wClose[i] > prevDown) {
      trend = 1;
    }
  }

  const lastIdx = len - 1;
  const atrVal = atrArr[lastIdx];
  const stopLevel = trend === 1 ? upBand : downBand;
  const longSig = trend === 1 && prevTrend === -1;
  const shortSig = trend === -1 && prevTrend === 1;
  const currColor = trend === 1 ? 'green' : 'red';
  const prevColor = prevTrend === 1 ? 'green' : 'red';

  return {
    signal: longSig ? 'BUY' : (shortSig ? 'SELL' : 'HOLD'),
    currColor,
    prevColor,
    longSig,
    shortSig,
    cOpen: wOpen[lastIdx],
    cClose: wClose[lastIdx],
    brickSize: Number((atrVal * factor).toFixed(8)),
    brick: String(Number((atrVal * factor).toFixed(8))),
    stopLevel: Number(stopLevel.toFixed(8)),
    atr: String(Number(atrVal.toFixed(8)))
  };
}

/**
 * Unified Indicator Processor supporting Wickless SuperTrend and all Sadeeq_Trading modes.
 */
export function processIndicator(opens, highs, lows, closes, options = {}) {
  const {
    mode = DEFAULT_CHART_MODE,
    brickMultiplier = 0.5,
    atrLen = 14,
    superTrendFactor = 2.0,
    superTrendAtrLen = 10
  } = typeof options === 'string' ? { mode: options } : options;

  const len = closes.length;
  const minRequired = Math.max(atrLen, superTrendAtrLen) + 2;
  if (len < minRequired) return null;

  if (mode === 'Wickless SuperTrend') {
    return computeWicklessSuperTrend(opens, highs, lows, closes, superTrendFactor, superTrendAtrLen);
  }

  const atrArr = calculateATRSeries(highs, lows, closes, atrLen);
  const atrVal = atrArr[len - 1];
  const brick = atrVal * brickMultiplier;

  let cOpen = [];
  let cClose = [];

  if (mode === 'Normal') {
    cOpen = opens;
    cClose = closes;
  } else if (mode === 'Heikin Ashi') {
    let haOpen = (opens[0] + closes[0]) / 2.0;
    for (let i = 0; i < len; i++) {
      const haClose = (opens[i] + highs[i] + lows[i] + closes[i]) / 4.0;
      if (i > 0) {
        haOpen = (haOpen + cClose[i - 1]) / 2.0;
      }
      cOpen.push(haOpen);
      cClose.push(haClose);
    }
  } else if (mode === 'Wickless') {
    for (let i = 0; i < len; i++) {
      cOpen.push(i > 0 ? closes[i - 1] : opens[0]);
      cClose.push(closes[i]);
    }
  } else if (mode === 'Renko Style') {
    let rClose = closes[0];
    let rOpen = closes[0];
    for (let i = 0; i < len; i++) {
      const cur = closes[i];
      const barBrick = atrArr[i] * brickMultiplier;
      const prevRClose = rClose;
      if (cur >= prevRClose + barBrick) {
        rClose = prevRClose + barBrick;
      } else if (cur <= prevRClose - barBrick) {
        rClose = prevRClose - barBrick;
      }
      if (rClose !== prevRClose) {
        rOpen = prevRClose;
      }
      cOpen.push(rOpen);
      cClose.push(rClose);
    }
  } else {
    // Line Break Style (Pine Script)
    let lbClose = closes[0];
    let lbOpen = closes[0];
    for (let i = 0; i < len; i++) {
      const cur = closes[i];
      const barBrick = atrArr[i] * brickMultiplier;
      const prevLbClose = lbClose;
      if (Math.abs(cur - prevLbClose) >= barBrick) {
        lbClose = cur;
      }
      if (lbClose !== prevLbClose) {
        lbOpen = prevLbClose;
      }
      cOpen.push(lbOpen);
      cClose.push(lbClose);
    }
  }

  const lastIdx = len - 1;
  const prevIdx = len - 2;
  const isUpCurrent = cClose[lastIdx] >= cOpen[lastIdx];
  const isUpPrev = cClose[prevIdx] >= cOpen[prevIdx];
  const longSig = isUpCurrent && !isUpPrev;
  const shortSig = !isUpCurrent && isUpPrev;

  return {
    signal: longSig ? 'BUY' : (shortSig ? 'SELL' : 'HOLD'),
    currColor: isUpCurrent ? 'green' : 'red',
    prevColor: isUpPrev ? 'green' : 'red',
    longSig,
    shortSig,
    cOpen: cOpen[lastIdx],
    cClose: cClose[lastIdx],
    brickSize: Number(brick.toFixed(8)),
    brick: String(Number(brick.toFixed(8))),
    stopLevel: null,
    atr: String(Number(atrVal.toFixed(8)))
  };
}
