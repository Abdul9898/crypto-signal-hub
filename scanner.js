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
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
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
    https.get(url, { headers: { 'User-Agent': 'CryptoSignalHubRunner/1.0' } }, (res) => {
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

// TradingView ta.atr() calculation using RMA (Wilder) smoothing
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
    // Exact Pine Script:
    // rClose := na(rClose[1]) ? close : close >= rClose[1] + brick ? rClose[1] + brick : close <= rClose[1] - brick ? rClose[1] - brick : rClose[1]
    // rOpen := na(rOpen[1]) ? close : rClose != rClose[1] ? rClose[1] : rOpen[1]
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
    // 5 · LINE BREAK STYLE (Exact Pine Script):
    // lbClose := na(lbClose[1]) ? close : math.abs(close - lbClose[1]) >= brick ? close : lbClose[1]
    // lbOpen := na(lbOpen[1]) ? close : lbClose != lbClose[1] ? lbClose[1] : lbOpen[1]
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

  // Exact Pine Script Signals:
  // isUp = cClose >= cOpen
  // isDown = cClose < cOpen
  // longSig = isUp and not isUp[1]
  // shortSig = isDown and not isDown[1]
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

function executePaperTrade(state, symbol, action, price) {
  const coin = symbol.replace('USDT', '');
  const { account } = state;
  const timestamp = new Date().toLocaleTimeString();

  if (action === 'BUY') {
    if (account.holdings[coin]) return;
    const allocation = account.balance * (account.riskPerTradePercent / 100);
    if (allocation < 10) return;

    const amount = allocation / price;
    account.balance -= allocation;
    account.holdings[coin] = {
      amount,
      avgPrice: price,
      boughtAt: timestamp
    };
    account.tradeHistory.unshift({
      id: Date.now(),
      symbol,
      type: 'BUY',
      price,
      amount,
      time: timestamp,
      pnl: 0,
      pnlPercent: 0
    });
    console.log(`[TRADE BUY] ${symbol} | Qty: ${amount.toFixed(4)} @ $${price}`);
  } else if (action === 'SELL') {
    if (!account.holdings[coin]) return;
    const pos = account.holdings[coin];
    const totalReturn = pos.amount * price;
    const cost = pos.amount * pos.avgPrice;
    const pnl = totalReturn - cost;
    const pnlPercent = ((pnl / cost) * 100).toFixed(2);

    account.balance += totalReturn;
    account.totalTrades++;
    if (pnl > 0) account.winningTrades++;

    account.tradeHistory.unshift({
      id: Date.now(),
      symbol,
      type: 'SELL',
      price,
      amount: pos.amount,
      time: timestamp,
      pnl: Number(pnl.toFixed(2)),
      pnlPercent: Number(pnlPercent)
    });
    delete account.holdings[coin];
    console.log(`[TRADE SELL] ${symbol} | Price: $${price} | PnL: $${pnl.toFixed(2)} (${pnlPercent}%)`);
  }

  if (account.tradeHistory.length > 50) account.tradeHistory.pop();
}

async function runScan() {
  console.log('--- Starting Cloud Scanner Run ---');
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
          console.log(`[${symbol}] Price: $${currentPrice} | Mode: ${account.chartMode} | Color: ${indicator.currColor} | Signal: ${indicator.signal}`);

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

          // Auto-Exit Rule: Sell / Close position if explicit SELL flip OR if held coin turns Red
          const shouldExit = isHolding && (indicator.signal === 'SELL' || indicator.currColor === 'red');
          // Entry Rule: Buy if explicit BUY signal and not currently holding
          const shouldEnter = !isHolding && indicator.signal === 'BUY';

          if (shouldExit) {
            console.log(`[EXIT TRIGGER] Closing ${symbol} position because candle is ${indicator.currColor.toUpperCase()}`);
            state.recentSignals.unshift({
              symbol,
              signal: 'SELL',
              price: currentPrice,
              time: new Date().toLocaleTimeString(),
              mode: account.chartMode,
              reason: `Candle turned ${indicator.currColor.toUpperCase()} [Auto-Exit]`
            });
            if (state.recentSignals.length > 30) state.recentSignals.pop();

            if (account.autoTradingEnabled) {
              executePaperTrade(state, symbol, 'SELL', currentPrice);
            }
          } else if (shouldEnter) {
            console.log(`[ENTRY TRIGGER] Opening ${symbol} LONG position on GREEN color flip`);
            state.recentSignals.unshift({
              symbol,
              signal: 'BUY',
              price: currentPrice,
              time: new Date().toLocaleTimeString(),
              mode: account.chartMode,
              reason: `Green Candle Entry`
            });
            if (state.recentSignals.length > 30) state.recentSignals.pop();

            if (account.autoTradingEnabled) {
              executePaperTrade(state, symbol, 'BUY', currentPrice);
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error processing ${symbol}:`, err.message);
    }
  }

  saveState(state);
  console.log('--- Cloud Scanner Run Completed ---');
}

runScan();
