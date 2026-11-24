import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state.json');

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 
  'DOGEUSDT', 'ADAUSDT', 'XRPUSDT', 'AVAXUSDT'
];

let defaultState = {
  account: {
    initialBalance: 10000.0,
    balance: 10000.0,
    leverage: 3, // Conservative 3x Leverage Futures
    positions: {}, // { BTC: { side: 'LONG'|'SHORT', amount, entryPrice, margin, liqPrice, time } }
    tradeHistory: [],
    totalTrades: 0,
    winningTrades: 0,
    autoTradingEnabled: true,
    riskPerTradePercent: 12, // 12% of available margin balance per contract
    chartMode: "Line Break Style",
    brickMultiplier: 0.5,
    atrPeriod: 14,
    timeframe: "15m"
  },
  marketScan: {},
  recentSignals: [],
  lastUpdated: null
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (!data.account.positions) data.account.positions = {};
      if (!data.account.leverage) data.account.leverage = 3;
      return data;
    }
  } catch (e) {
    console.error('Error loading state, using default:', e);
  }
  return defaultState;
}

function saveState(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    console.log(`Saved state to ${STATE_FILE} at ${state.lastUpdated}`);
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CryptoSignalHubFutures/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ----------------------------------------------------------------------
// 100% PURE PINESCRIPT TRANSLATION: "All Charts · Sadeeq_Trading"
// Options: Normal, Heikin Ashi, Wickless, Renko Style, Line Break Style
// ----------------------------------------------------------------------
function calculateATR(highs, lows, closes, period = 14) {
  const len = closes.length;
  if (len < period + 1) return 1;
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < len; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let atr = sum / period;
  for (let i = period; i < len; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function processSadeeqIndicator(opens, highs, lows, closes, mode = "Line Break Style", brickMultiplier = 0.5, atrLen = 14) {
  const len = closes.length;
  if (len < atrLen + 2) return null;

  const atrVal = calculateATR(highs, lows, closes, atrLen);
  const brick = atrVal * brickMultiplier;

  let cOpen = [];
  let cClose = [];

  if (mode === "Normal") {
    cOpen = opens;
    cClose = closes;
  } else if (mode === "Heikin Ashi") {
    let haOpen = (opens[0] + closes[0]) / 2.0;
    for (let i = 0; i < len; i++) {
      const haClose = (opens[i] + highs[i] + lows[i] + closes[i]) / 4.0;
      if (i > 0) {
        haOpen = (haOpen + cClose[i - 1]) / 2.0;
      }
      cOpen.push(haOpen);
      cClose.push(haClose);
    }
  } else if (mode === "Wickless") {
    for (let i = 0; i < len; i++) {
      const prevClose = i > 0 ? closes[i - 1] : opens[0];
      const curClose = closes[i];
      cOpen.push(prevClose);
      cClose.push(curClose);
    }
  } else if (mode === "Renko Style") {
    let rClose = closes[0];
    let rOpen = closes[0];
    for (let i = 0; i < len; i++) {
      const cur = closes[i];
      const prevRClose = rClose;
      if (cur >= prevRClose + brick) {
        rClose = prevRClose + brick;
      } else if (cur <= prevRClose - brick) {
        rClose = prevRClose - brick;
      }
      if (rClose !== prevRClose) {
        rOpen = prevRClose;
      }
      cOpen.push(rOpen);
      cClose.push(rClose);
    }
  } else {
    // 5 · LINE BREAK STYLE (Exact Pine Script)
    let lbClose = closes[0];
    let lbOpen = closes[0];
    for (let i = 0; i < len; i++) {
      const cur = closes[i];
      const prevLbClose = lbClose;
      if (Math.abs(cur - prevLbClose) >= brick) {
        lbClose = cur;
      }
      if (lbClose !== prevLbClose) {
        lbOpen = prevLbClose;
      }
      cOpen.push(lbOpen);
      cClose.push(lbClose);
    }
  }

  const isUp = [];
  for (let i = 0; i < len; i++) {
    isUp.push(cClose[i] >= cOpen[i]);
  }

  const lastIdx = len - 1;
  const prevIdx = len - 2;

  const longSig = isUp[lastIdx] && !isUp[prevIdx];
  const shortSig = !isUp[lastIdx] && isUp[prevIdx];

  let signal = 'HOLD';
  if (longSig) signal = 'BUY';
  else if (shortSig) signal = 'SELL';

  const currColor = isUp[lastIdx] ? 'green' : 'red';
  const prevColor = isUp[prevIdx] ? 'green' : 'red';

  return {
    signal,
    currColor,
    prevColor,
    brick: brick.toFixed(4),
    atr: atrVal.toFixed(4)
  };
}

// ----------------------------------------------------------------------
// FUTURES POSITION & CONTRACT ENGINE (LONG & SHORT with 3x-5x Leverage)
// ----------------------------------------------------------------------

function closeFuturesPosition(state, symbol, exitPrice, reason = '') {
  const coin = symbol.replace('USDT', '');
  const { account } = state;
  const pos = account.positions[coin];
  if (!pos) return null;

  const timestamp = new Date().toLocaleTimeString();
  const lev = pos.leverage || account.leverage || 3;
  const notional = pos.amount * pos.entryPrice;

  let pnl = 0;
  if (pos.side === 'LONG') {
    pnl = (exitPrice - pos.entryPrice) * pos.amount;
  } else {
    // SHORT profit: when price falls
    pnl = (pos.entryPrice - exitPrice) * pos.amount;
  }

  const pnlPercent = (pnl / pos.margin) * 100;
  account.balance += (pos.margin + pnl);
  account.totalTrades++;
  if (pnl > 0) account.winningTrades++;

  const closedTrade = {
    id: Date.now(),
    symbol,
    side: pos.side,
    action: `CLOSE ${pos.side}`,
    entryPrice: pos.entryPrice,
    exitPrice,
    amount: pos.amount,
    margin: Number(pos.margin.toFixed(2)),
    leverage: lev,
    pnl: Number(pnl.toFixed(2)),
    pnlPercent: Number(pnlPercent.toFixed(2)),
    time: timestamp,
    reason
  };

  account.tradeHistory.unshift(closedTrade);
  if (account.tradeHistory.length > 50) account.tradeHistory.pop();
  delete account.positions[coin];

  console.log(`[FUTURES CLOSE] ${pos.side} ${symbol} @ $${exitPrice} | PnL: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%) | Reason: ${reason}`);
  return closedTrade;
}

function openFuturesPosition(state, symbol, side, price, reason = '') {
  const coin = symbol.replace('USDT', '');
  const { account } = state;
  const timestamp = new Date().toLocaleTimeString();
  const lev = account.leverage || 3;

  // Allocate margin percentage
  const marginAlloc = account.balance * (account.riskPerTradePercent / 100);
  if (marginAlloc < 10 || account.balance < marginAlloc) {
    console.log(`[FUTURES SKIP] Insufficient margin balance ($${account.balance.toFixed(2)}) for ${symbol}`);
    return;
  }

  const positionNotional = marginAlloc * lev;
  const amount = positionNotional / price;
  account.balance -= marginAlloc;

  // Conservative Liquidation Price Calculation
  // LONG Liq = Entry * (1 - (1 / Leverage) * 0.9)
  // SHORT Liq = Entry * (1 + (1 / Leverage) * 0.9)
  const liqDistance = (1 / lev) * 0.9;
  const liqPrice = side === 'LONG' ? price * (1 - liqDistance) : price * (1 + liqDistance);

  account.positions[coin] = {
    symbol,
    side, // 'LONG' or 'SHORT'
    amount,
    entryPrice: price,
    margin: marginAlloc,
    leverage: lev,
    liqPrice: Number(liqPrice.toFixed(4)),
    openedAt: timestamp,
    reason
  };

  account.tradeHistory.unshift({
    id: Date.now(),
    symbol,
    side,
    action: `OPEN ${side} (${lev}x)`,
    price,
    amount,
    margin: Number(marginAlloc.toFixed(2)),
    leverage: lev,
    time: timestamp,
    pnl: 0,
    pnlPercent: 0,
    reason
  });
  if (account.tradeHistory.length > 50) account.tradeHistory.pop();

  console.log(`[FUTURES OPEN] ${side} ${symbol} | Notional: $${positionNotional.toFixed(2)} (${lev}x) | Margin: $${marginAlloc.toFixed(2)} @ $${price}`);
}

async function runScan() {
  console.log('--- Starting 24/7 Futures Cloud Scanner (3x-5x Leverage) ---');
  const state = loadState();
  const { account } = state;

  for (const symbol of SYMBOLS) {
    try {
      const klineUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${account.timeframe}&limit=100`;
      const data = await fetchJSON(klineUrl);

      if (Array.isArray(data) && data.length > 20) {
        const opens = data.map(d => parseFloat(d[1]));
        const highs = data.map(d => parseFloat(d[2]));
        const lows = data.map(d => parseFloat(d[3]));
        const closes = data.map(d => parseFloat(d[4]));
        const currentPrice = closes[closes.length - 1];

        const indicator = processSadeeqIndicator(
          opens, highs, lows, closes, 
          account.chartMode, 
          account.brickMultiplier, 
          account.atrPeriod
        );

        if (indicator) {
          console.log(`[${symbol}] Price: $${currentPrice} | Color: ${indicator.currColor.toUpperCase()} | Signal: ${indicator.signal}`);

          if (!state.marketScan) state.marketScan = {};
          state.marketScan[symbol] = {
            symbol,
            price: currentPrice,
            candleColor: indicator.currColor,
            brickSize: indicator.brick,
            atr: indicator.atr,
            signal: indicator.signal
          };

          const coin = symbol.replace('USDT', '');
          const currentPos = account.positions[coin];

          // ═════════════════════════════════════════════════════════════════
          // POSITION FLIP STRATEGY (Longs and Shorts on Color Flips)
          // ═════════════════════════════════════════════════════════════════

          // 1. If currently in LONG and signal turns RED:
          // Close LONG position and flip immediately into SHORT!
          if (currentPos && currentPos.side === 'LONG' && (indicator.currColor === 'red' || indicator.signal === 'SELL')) {
            console.log(`[POSITION FLIP] ${symbol} turned RED -> Closing LONG & Flipping to SHORT`);
            state.recentSignals.unshift({
              symbol,
              signal: 'SELL / SHORT',
              price: currentPrice,
              time: new Date().toLocaleTimeString(),
              mode: account.chartMode,
              reason: 'Color flipped RED [Futures Short Flip]'
            });
            if (state.recentSignals.length > 30) state.recentSignals.pop();

            if (account.autoTradingEnabled) {
              closeFuturesPosition(state, symbol, currentPrice, 'Flipped to RED');
              openFuturesPosition(state, symbol, 'SHORT', currentPrice, 'Color Flipped RED');
            }
          }
          // 2. If currently in SHORT and signal turns GREEN:
          // Close SHORT position and flip immediately into LONG!
          else if (currentPos && currentPos.side === 'SHORT' && (indicator.currColor === 'green' || indicator.signal === 'BUY')) {
            console.log(`[POSITION FLIP] ${symbol} turned GREEN -> Closing SHORT & Flipping to LONG`);
            state.recentSignals.unshift({
              symbol,
              signal: 'BUY / LONG',
              price: currentPrice,
              time: new Date().toLocaleTimeString(),
              mode: account.chartMode,
              reason: 'Color flipped GREEN [Futures Long Flip]'
            });
            if (state.recentSignals.length > 30) state.recentSignals.pop();

            if (account.autoTradingEnabled) {
              closeFuturesPosition(state, symbol, currentPrice, 'Flipped to GREEN');
              openFuturesPosition(state, symbol, 'LONG', currentPrice, 'Color Flipped GREEN');
            }
          }
          // 3. If NO active position:
          // Enter on fresh Green (LONG) or fresh Red (SHORT) signal
          else if (!currentPos) {
            if (indicator.signal === 'BUY' || indicator.currColor === 'green') {
              console.log(`[FUTURES ENTRY] Opening new LONG contract on ${symbol}`);
              state.recentSignals.unshift({
                symbol,
                signal: 'BUY / LONG',
                price: currentPrice,
                time: new Date().toLocaleTimeString(),
                mode: account.chartMode,
                reason: 'Green Candle Entry'
              });
              if (state.recentSignals.length > 30) state.recentSignals.pop();

              if (account.autoTradingEnabled) {
                openFuturesPosition(state, symbol, 'LONG', currentPrice, 'Green Entry');
              }
            } else if (indicator.signal === 'SELL' || indicator.currColor === 'red') {
              console.log(`[FUTURES ENTRY] Opening new SHORT contract on ${symbol}`);
              state.recentSignals.unshift({
                symbol,
                signal: 'SELL / SHORT',
                price: currentPrice,
                time: new Date().toLocaleTimeString(),
                mode: account.chartMode,
                reason: 'Red Candle Entry'
              });
              if (state.recentSignals.length > 30) state.recentSignals.pop();

              if (account.autoTradingEnabled) {
                openFuturesPosition(state, symbol, 'SHORT', currentPrice, 'Red Entry');
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error processing ${symbol}:`, err.message);
    }
  }

  saveState(state);
  console.log('--- 24/7 Futures Cloud Scanner Completed ---');
}

runScan();
