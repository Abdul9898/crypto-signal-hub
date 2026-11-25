import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SYMBOLS, DEFAULT_CHART_MODE, processIndicator } from './indicators.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state.json');

// Profit & Risk Constants for 3m Scalping
const TAKE_PROFIT_PCT = 1.2; // Bank profit at +1.2%
const STOP_LOSS_PCT = 1.0;   // Hard stop at -1.0%

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
    chartMode: DEFAULT_CHART_MODE, // Wickless SuperTrend
    brickMultiplier: 0.5,
    atrPeriod: 14,
    superTrendFactor: 2.0,
    superTrendAtrLen: 10,
    timeframe: '3m',
    takeProfitPct: TAKE_PROFIT_PCT,
    stopLossPct: STOP_LOSS_PCT,
    enableShorting: true
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
      data.account.chartMode = DEFAULT_CHART_MODE; // Enforce Wickless SuperTrend
      data.account.takeProfitPct = TAKE_PROFIT_PCT;
      data.account.stopLossPct = STOP_LOSS_PCT;
      data.account.enableShorting = true;
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
    console.error('Error saving state:', e);
  }
}

function fetchJSON(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'CryptoSignalHub/2.0' } }, (res) => {
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

function closePosition(account, coin, symbol, price, reason) {
  const pos = account.holdings[coin];
  if (!pos) return null;

  const isLong = (pos.side || 'LONG') === 'LONG';
  let pnl = 0;
  let pnlPercent = 0;
  let returnedCapital = 0;

  if (isLong) {
    const revenue = pos.amount * price;
    const cost = pos.amount * pos.avgPrice;
    pnl = revenue - cost;
    pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
    returnedCapital = revenue;
  } else {
    // SHORT position: profit when price drops
    const entryVal = pos.amount * pos.avgPrice;
    const exitVal = pos.amount * price;
    pnl = entryVal - exitVal;
    pnlPercent = entryVal > 0 ? (pnl / entryVal) * 100 : 0;
    returnedCapital = entryVal + pnl; // Margin return + profit/loss
  }

  account.balance += Math.max(0, returnedCapital);
  account.totalTrades++;
  if (pnl > 0) account.winningTrades++;

  const actionType = isLong ? 'CLOSE LONG' : 'CLOSE SHORT';
  const timestamp = new Date().toLocaleTimeString();

  account.tradeHistory.unshift({
    id: Date.now(),
    symbol,
    type: actionType,
    action: actionType,
    price,
    amount: Number(pos.amount.toFixed(4)),
    totalUSDT: Number((pos.amount * price).toFixed(2)),
    time: timestamp,
    pnl: Number(pnl.toFixed(2)),
    pnlPercent: Number(pnlPercent.toFixed(2)),
    reason
  });

  delete account.holdings[coin];
  console.log(`[${actionType}] ${symbol} @ $${price} | PnL: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%) | Reason: ${reason}`);

  if (account.tradeHistory.length > 60) account.tradeHistory.pop();
  return pnl;
}

function openPosition(account, coin, symbol, side, price, reason) {
  if (account.holdings[coin]) return;

  const allocation = account.balance * (account.riskPerTradePercent / 100);
  if (allocation < 15 || account.balance < allocation) return;

  const amount = allocation / price;
  account.balance -= allocation;
  const timestamp = new Date().toLocaleTimeString();

  account.holdings[coin] = {
    side, // 'LONG' or 'SHORT'
    amount,
    avgPrice: price,
    boughtAt: timestamp,
    initialMargin: allocation
  };

  account.totalTrades++;
  account.tradeHistory.unshift({
    id: Date.now(),
    symbol,
    type: side,
    action: side,
    price,
    amount: Number(amount.toFixed(4)),
    totalUSDT: Number(allocation.toFixed(2)),
    time: timestamp,
    pnl: 0,
    pnlPercent: 0,
    reason
  });

  console.log(`[OPEN ${side}] ${symbol} | Qty: ${amount.toFixed(4)} @ $${price} | Reason: ${reason}`);
  if (account.tradeHistory.length > 60) account.tradeHistory.pop();
}

async function scanOnce(state) {
  const { account } = state;
  const tpPct = account.takeProfitPct || TAKE_PROFIT_PCT;
  const slPct = account.stopLossPct || STOP_LOSS_PCT;

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
          const pos = account.holdings[coin];

          // 1. CHECK TAKE-PROFIT & STOP-LOSS ON EXISTING POSITIONS FIRST
          if (pos && account.autoTradingEnabled) {
            const isLong = (pos.side || 'LONG') === 'LONG';
            const priceChangePct = isLong
              ? ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100
              : ((pos.avgPrice - currentPrice) / pos.avgPrice) * 100;

            if (priceChangePct >= tpPct) {
              closePosition(account, coin, symbol, currentPrice, `Take-Profit Hit (+${priceChangePct.toFixed(2)}%)`);
              continue;
            } else if (priceChangePct <= -slPct) {
              closePosition(account, coin, symbol, currentPrice, `Stop-Loss Protected (${priceChangePct.toFixed(2)}%)`);
              continue;
            }

            // Trend Reversal Exits
            if (isLong && (indicator.currColor === 'red' || indicator.signal === 'SELL')) {
              closePosition(account, coin, symbol, currentPrice, `Trend Reversal (Turned Red)`);
              continue;
            } else if (!isLong && (indicator.currColor === 'green' || indicator.signal === 'BUY')) {
              closePosition(account, coin, symbol, currentPrice, `Trend Reversal (Turned Green)`);
              continue;
            }
          }

          // 2. CHECK NEW ENTRY SIGNALS (BI-DIRECTIONAL: LONG & SHORT)
          const openHoldingsCount = Object.keys(account.holdings).length;
          if (!account.holdings[coin] && openHoldingsCount < 6 && account.autoTradingEnabled) {
            const isBullish = indicator.currColor === 'green' || indicator.signal === 'BUY';
            const isBearish = indicator.currColor === 'red' || indicator.signal === 'SELL';

            if (isBullish) {
              openPosition(account, coin, symbol, 'LONG', currentPrice, `Green Trend [${account.chartMode}]`);
              state.recentSignals.unshift({
                symbol,
                signal: 'LONG',
                action: 'LONG',
                price: currentPrice,
                time: new Date().toLocaleTimeString(),
                mode: `${account.timeframe} · ${account.chartMode}`,
                reason: `Bullish Trend Entry`
              });
              if (state.recentSignals.length > 30) state.recentSignals.pop();
            } else if (isBearish && account.enableShorting) {
              openPosition(account, coin, symbol, 'SHORT', currentPrice, `Red Trend [${account.chartMode}]`);
              state.recentSignals.unshift({
                symbol,
                signal: 'SHORT',
                action: 'SHORT',
                price: currentPrice,
                time: new Date().toLocaleTimeString(),
                mode: `${account.timeframe} · ${account.chartMode}`,
                reason: `Bearish Trend Entry (Short)`
              });
              if (state.recentSignals.length > 30) state.recentSignals.pop();
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

// Multi-Cycle Execution: Runs 4 continuous sweeps per GitHub Actions session
async function runHighFrequencyRunner() {
  const state = loadState();
  console.log(`--- Starting 3m Runner [${state.account.chartMode}] with TP: +${state.account.takeProfitPct}% / SL: -${state.account.stopLossPct}% & Bi-directional Trading ---`);

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
