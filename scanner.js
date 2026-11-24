import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SYMBOLS, DEFAULT_CHART_MODE, processIndicator } from './indicators.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state.json');

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
    chartMode: DEFAULT_CHART_MODE,
    brickMultiplier: 0.5,
    atrPeriod: 14,
    superTrendFactor: 2.0,
    superTrendAtrLen: 10,
    timeframe: '3m'
  },
  marketScan: {},
  recentSignals: [],
  lastUpdated: null
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (!data.account) data.account = { ...defaultState.account };
      if (!data.account.holdings) data.account.holdings = {};
      if (!data.account.chartMode) data.account.chartMode = DEFAULT_CHART_MODE;
      if (!data.account.superTrendFactor) data.account.superTrendFactor = 2.0;
      if (!data.account.superTrendAtrLen) data.account.superTrendAtrLen = 10;
      if (!data.account.timeframe) data.account.timeframe = '3m';
      return data;
    }
  } catch (e) {
    console.error('Error loading state:', e);
  }
  return defaultState;
}

function saveState(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

function fetchJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'CryptoSignalHubScalper/2.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

function executePaperTrade(state, symbol, action, price, reason = '') {
  const coin = symbol.replace('USDT', '');
  const { account } = state;
  const timestamp = new Date().toLocaleTimeString();

  if (action === 'BUY' || action === 'LONG') {
    if (account.holdings[coin]) return;
    const allocation = account.balance * (account.riskPerTradePercent / 100);
    if (allocation < 10 || account.balance < allocation) return;

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
    console.log(`[SCALP BUY] LONG ${symbol} | Qty: ${amount.toFixed(4)} @ $${price}`);
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
    console.log(`[SCALP CLOSE] ${symbol} @ $${price} | PnL: $${pnl.toFixed(2)} (${pnlPercent}%)`);
  }

  if (account.tradeHistory.length > 50) account.tradeHistory.pop();
}

async function scanOnce(state) {
  const { account } = state;

  for (const symbol of SYMBOLS) {
    try {
      const klineUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${account.timeframe}&limit=150`;
      const data = await fetchJSON(klineUrl);

      if (Array.isArray(data) && data.length > 20) {
        const opens = data.map(d => parseFloat(d[1]));
        const highs = data.map(d => parseFloat(d[2]));
        const lows = data.map(d => parseFloat(d[3]));
        const closes = data.map(d => parseFloat(d[4]));
        const currentPrice = closes[closes.length - 1];

        const indicator = processIndicator(opens, highs, lows, closes, {
          mode: account.chartMode,
          brickMultiplier: account.brickMultiplier,
          atrLen: account.atrPeriod,
          superTrendFactor: account.superTrendFactor || 2.0,
          superTrendAtrLen: account.superTrendAtrLen || 10
        });

        if (indicator) {
          if (!state.marketScan) state.marketScan = {};
          state.marketScan[symbol] = {
            symbol,
            price: currentPrice,
            candleColor: indicator.currColor,
            brickSize: indicator.brick,
            stopLevel: indicator.stopLevel,
            atr: indicator.atr,
            signal: indicator.signal,
            mode: account.chartMode
          };

          const coin = symbol.replace('USDT', '');
          const isHolding = !!account.holdings[coin];

          // Auto-Exit: Close position if trend flips red or fires SELL
          const shouldExit = isHolding && (indicator.currColor === 'red' || indicator.signal === 'SELL');
          // Entry: Open LONG on green impulse/flip while under 6 concurrent holdings
          const openHoldingsCount = Object.keys(account.holdings).length;
          const shouldEnter = !isHolding && openHoldingsCount < 6 && (indicator.signal === 'BUY' || indicator.currColor === 'green');

          if (shouldExit) {
            console.log(`[EXIT] ${symbol} Red Flip [${account.chartMode}]`);
            state.recentSignals.unshift({
              symbol,
              signal: 'SHORT',
              action: 'SHORT',
              price: currentPrice,
              time: new Date().toLocaleTimeString(),
              mode: `${account.timeframe} · ${account.chartMode}`,
              reason: `Red Impulse Exit [${account.chartMode}]`
            });
            if (state.recentSignals.length > 30) state.recentSignals.pop();

            if (account.autoTradingEnabled) {
              executePaperTrade(state, symbol, 'SELL', currentPrice, `Red Exit [${account.chartMode}]`);
            }
          } else if (shouldEnter) {
            console.log(`[ENTRY] ${symbol} Green Flip [${account.chartMode}]`);
            state.recentSignals.unshift({
              symbol,
              signal: 'LONG',
              action: 'LONG',
              price: currentPrice,
              time: new Date().toLocaleTimeString(),
              mode: `${account.timeframe} · ${account.chartMode}`,
              reason: `Green Impulse Entry [${account.chartMode}]`
            });
            if (state.recentSignals.length > 30) state.recentSignals.pop();

            if (account.autoTradingEnabled) {
              executePaperTrade(state, symbol, 'BUY', currentPrice, `Green Entry [${account.chartMode}]`);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`Error scanning ${symbol}:`, err.message);
    }
  }

  saveState(state);
}

// Multi-Cycle Execution: Runs 4 continuous sweeps in each runner session
async function runHighFrequencyRunner() {
  const state = loadState();
  console.log(`--- Starting ${state.account.timeframe} Runner [${state.account.chartMode}] ---`);

  for (let cycle = 1; cycle <= 4; cycle++) {
    console.log(`[Cycle ${cycle}/4] Running market sweep...`);
    await scanOnce(state);
    if (cycle < 4) {
      await new Promise(r => setTimeout(r, 12000));
    }
  }

  console.log('--- Runner Session Completed ---');
}

runHighFrequencyRunner();
