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
    holdings: {},
    tradeHistory: [],
    totalTrades: 0,
    winningTrades: 0,
    autoTradingEnabled: true,
    riskPerTradePercent: 12,
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
      if (!data.account.holdings) data.account.holdings = {};
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
    https.get(url, { headers: { 'User-Agent': 'CryptoSignalHubSpot/1.0' } }, (res) => {
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

  const currColor = isUp[lastIdx] ? 'green' : 'red';
  const prevColor = isUp[prevIdx] ? 'green' : 'red';

  let signal = 'HOLD';
  if (longSig) signal = 'BUY';
  else if (shortSig) signal = 'SELL';

  return {
    signal,
    currColor,
    prevColor,
    longSig,
    shortSig,
    brick: brick.toFixed(4),
    atr: atrVal.toFixed(4)
  };
}

// ----------------------------------------------------------------------
// YESTERDAY'S PROVEN SPOT STRATEGY:
// 1. Enter LONG on Green candle or Green Color Flip
// 2. CLOSE / SHORT on Red candle immediately to lock in profit / cut loss
// ----------------------------------------------------------------------

function executePaperTrade(state, symbol, action, price, reason = '') {
  const coin = symbol.replace('USDT', '');
  const { account } = state;
  const timestamp = new Date().toLocaleTimeString();

  if (action === 'BUY' || action === 'LONG') {
    if (account.holdings[coin]) return;
    const allocation = account.balance * (account.riskPerTradePercent / 100);
    if (allocation < 15 || account.balance < allocation) return;

    const amount = allocation / price;
    account.balance -= allocation;
    account.holdings[coin] = {
      amount,
      avgPrice: price,
      boughtAt: timestamp
    };

    account.totalTrades++;
    account.tradeHistory.unshift({
      id: Date.now(),
      symbol,
      type: 'LONG',
      action: 'LONG',
      price,
      amount: Number(amount.toFixed(4)),
      totalUSDT: Number(allocation.toFixed(2)),
      time: timestamp,
      pnl: 0,
      pnlPercent: 0,
      reason
    });
    console.log(`[TRADE BUY] LONG ${symbol} | Qty: ${amount.toFixed(4)} @ $${price}`);
  } else if (action === 'SELL' || action === 'SHORT') {
    if (!account.holdings[coin]) return;
    const pos = account.holdings[coin];
    const revenue = pos.amount * price;
    const cost = pos.amount * pos.avgPrice;
    const pnl = revenue - cost;
    const pnlPercent = cost > 0 ? ((pnl / cost) * 100).toFixed(2) : 0;

    account.balance += revenue;
    account.totalTrades++;
    if (pnl > 0) account.winningTrades++;

    account.tradeHistory.unshift({
      id: Date.now(),
      symbol,
      type: 'CLOSE / SHORT',
      action: 'CLOSE / SHORT',
      price,
      amount: Number(pos.amount.toFixed(4)),
      totalUSDT: Number(revenue.toFixed(2)),
      time: timestamp,
      pnl: Number(pnl.toFixed(2)),
      pnlPercent: Number(pnlPercent),
      reason
    });
    delete account.holdings[coin];
    console.log(`[TRADE SELL] CLOSE / SHORT ${symbol} @ $${price} | PnL: $${pnl.toFixed(2)} (${pnlPercent}%)`);
  }

  if (account.tradeHistory.length > 50) account.tradeHistory.pop();
}

async function runScan() {
  console.log('--- Starting 24/7 Spot Scanner (Yesterday Proven Rule: 15m) ---');
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
          const isHolding = !!account.holdings[coin];

          // 1. Should Exit: If held coin turns RED (protect profit & prevent drawdowns)
          const shouldExit = isHolding && (indicator.currColor === 'red' || indicator.signal === 'SELL');

          // 2. Should Enter: If coin is GREEN and we do not hold it yet
          const shouldEnter = !isHolding && (indicator.signal === 'BUY' || indicator.currColor === 'green');

          if (shouldExit) {
            console.log(`[EXIT TRIGGER] Red Candle Exit on ${symbol}`);
            state.recentSignals.unshift({
              symbol,
              signal: 'SHORT',
              action: 'SHORT',
              price: currentPrice,
              time: new Date().toLocaleTimeString(),
              mode: account.chartMode,
              reason: `Red Candle Exit [${account.chartMode}]`
            });
            if (state.recentSignals.length > 30) state.recentSignals.pop();

            if (account.autoTradingEnabled) {
              executePaperTrade(state, symbol, 'SELL', currentPrice, 'Red Candle Exit');
            }
          } else if (shouldEnter) {
            console.log(`[ENTRY TRIGGER] Green Candle Entry on ${symbol}`);
            state.recentSignals.unshift({
              symbol,
              signal: 'LONG',
              action: 'LONG',
              price: currentPrice,
              time: new Date().toLocaleTimeString(),
              mode: account.chartMode,
              reason: `Green Candle Entry [${account.chartMode}]`
            });
            if (state.recentSignals.length > 30) state.recentSignals.pop();

            if (account.autoTradingEnabled) {
              executePaperTrade(state, symbol, 'BUY', currentPrice, 'Green Candle Entry');
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error processing ${symbol}:`, err.message);
    }
  }

  saveState(state);
  console.log('--- 24/7 Spot Scanner Completed ---');
}

runScan();
