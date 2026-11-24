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
    timeframe: "1m"
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

function calculateATR(highs, lows, closes, period = 14) {
  if (closes.length < 2) return 1;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  if (trs.length < period) {
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }
  let atr = trs.slice(period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
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
    let haOpen = (opens[0] + closes[0]) / 2;
    for (let i = 0; i < len; i++) {
      const haClose = (opens[i] + highs[i] + lows[i] + closes[i]) / 4;
      if (i > 0) {
        haOpen = (haOpen + (opens[i - 1] + highs[i - 1] + lows[i - 1] + closes[i - 1]) / 4) / 2;
      }
      cOpen.push(haOpen);
      cClose.push(haClose);
    }
  } else if (mode === "Line Break Style") {
    let trend = closes[0] >= opens[0] ? 1 : -1;
    let lastBoxClose = closes[0];
    for (let i = 0; i < len; i++) {
      const c = closes[i];
      if (trend === 1) {
        if (c > lastBoxClose + brick) {
          lastBoxClose = c;
        } else if (c < lastBoxClose - (brick * 2)) {
          trend = -1;
          lastBoxClose = c;
        }
      } else {
        if (c < lastBoxClose - brick) {
          lastBoxClose = c;
        } else if (c > lastBoxClose + (brick * 2)) {
          trend = 1;
          lastBoxClose = c;
        }
      }
      cOpen.push(trend === 1 ? lastBoxClose - brick : lastBoxClose + brick);
      cClose.push(lastBoxClose);
    }
  } else {
    let renkoClose = closes[0];
    for (let i = 0; i < len; i++) {
      const c = closes[i];
      if (c >= renkoClose + brick) {
        renkoClose += brick;
        cOpen.push(renkoClose - brick);
        cClose.push(renkoClose);
      } else if (c <= renkoClose - brick) {
        renkoClose -= brick;
        cOpen.push(renkoClose + brick);
        cClose.push(renkoClose);
      } else {
        cOpen.push(cOpen[cOpen.length - 1] || c);
        cClose.push(renkoClose);
      }
    }
  }

  const currColor = cClose[len - 1] >= cOpen[len - 1] ? 'green' : 'red';
  const prevColor = cClose[len - 2] >= cOpen[len - 2] ? 'green' : 'red';

  let signal = 'HOLD';
  if (prevColor === 'red' && currColor === 'green') signal = 'BUY';
  else if (prevColor === 'green' && currColor === 'red') signal = 'SELL';

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

          if (indicator.signal === 'BUY' || indicator.signal === 'SELL') {
            state.recentSignals.unshift({
              symbol,
              signal: indicator.signal,
              price: currentPrice,
              time: new Date().toLocaleTimeString(),
              mode: account.chartMode
            });
            if (state.recentSignals.length > 30) state.recentSignals.pop();

            if (account.autoTradingEnabled) {
              executePaperTrade(state, symbol, indicator.signal, currentPrice);
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
