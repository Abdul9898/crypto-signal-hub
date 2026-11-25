import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SYMBOLS, DEFAULT_CHART_MODE, processIndicator } from './indicators.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3000;

// Profit & Risk Constants
const TAKE_PROFIT_PCT = 1.2;
const STOP_LOSS_PCT = 1.0;

let account = {
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
  timeframe: '3m',
  takeProfitPct: TAKE_PROFIT_PCT,
  stopLossPct: STOP_LOSS_PCT,
  enableShorting: true
};

let marketData = {};
let recentSignals = [];

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

function closePosition(coin, symbol, price, reason) {
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
    const entryVal = pos.amount * pos.avgPrice;
    const exitVal = pos.amount * price;
    pnl = entryVal - exitVal;
    pnlPercent = entryVal > 0 ? (pnl / entryVal) * 100 : 0;
    returnedCapital = entryVal + pnl;
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
  if (account.tradeHistory.length > 60) account.tradeHistory.pop();
  return pnl;
}

function openPosition(coin, symbol, side, price, reason) {
  if (account.holdings[coin]) return;

  const allocation = account.balance * (account.riskPerTradePercent / 100);
  if (allocation < 15 || account.balance < allocation) return;

  const amount = allocation / price;
  account.balance -= allocation;
  const timestamp = new Date().toLocaleTimeString();

  account.holdings[coin] = {
    side,
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

  if (account.tradeHistory.length > 60) account.tradeHistory.pop();
}

async function scanMarket() {
  const tpPct = account.takeProfitPct || TAKE_PROFIT_PCT;
  const slPct = account.stopLossPct || STOP_LOSS_PCT;

  for (const symbol of SYMBOLS) {
    try {
      const klineUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${account.timeframe}&limit=150`;
      const data = await fetchJSON(klineUrl);

      if (!Array.isArray(data) || data.length < 20) continue;

      const opens = data.map(d => parseFloat(d[1]));
      const highs = data.map(d => parseFloat(d[2]));
      const lows = data.map(d => parseFloat(d[3]));
      const closes = data.map(d => parseFloat(d[4]));
      const currentPrice = closes[closes.length - 1];

      const indicatorRes = processIndicator(opens, highs, lows, closes, {
        mode: account.chartMode,
        brickMultiplier: account.brickMultiplier,
        atrLen: account.atrPeriod,
        superTrendFactor: account.superTrendFactor,
        superTrendAtrLen: account.superTrendAtrLen
      });

      if (!indicatorRes) continue;

      const candleColorUpper = (indicatorRes.currColor || 'green').toUpperCase();

      marketData[symbol] = {
        symbol,
        price: currentPrice,
        candleColor: indicatorRes.currColor,
        brickSize: indicatorRes.brick,
        stopLevel: indicatorRes.stopLevel,
        atr: indicatorRes.atr,
        signal: indicatorRes.signal,
        mode: account.chartMode,
        updatedAt: new Date().toLocaleTimeString()
      };

      const coin = symbol.replace('USDT', '');
      const pos = account.holdings[coin];

      // TP / SL Checks
      if (pos && account.autoTradingEnabled) {
        const isLong = (pos.side || 'LONG') === 'LONG';
        const priceChangePct = isLong
          ? ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100
          : ((pos.avgPrice - currentPrice) / pos.avgPrice) * 100;

        if (priceChangePct >= tpPct) {
          closePosition(coin, symbol, currentPrice, `Take-Profit Hit (+${priceChangePct.toFixed(2)}%)`);
          continue;
        } else if (priceChangePct <= -slPct) {
          closePosition(coin, symbol, currentPrice, `Stop-Loss Protected (${priceChangePct.toFixed(2)}%)`);
          continue;
        }

        if (isLong && (indicatorRes.currColor === 'red' || indicatorRes.signal === 'SELL')) {
          closePosition(coin, symbol, currentPrice, `Trend Reversal (Turned Red)`);
          continue;
        } else if (!isLong && (indicatorRes.currColor === 'green' || indicatorRes.signal === 'BUY')) {
          closePosition(coin, symbol, currentPrice, `Trend Reversal (Turned Green)`);
          continue;
        }
      }

      // New Bi-directional entry
      const openCount = Object.keys(account.holdings).length;
      if (!account.holdings[coin] && openCount < 6 && account.autoTradingEnabled) {
        const isBullish = indicatorRes.currColor === 'green' || indicatorRes.signal === 'BUY';
        const isBearish = indicatorRes.currColor === 'red' || indicatorRes.signal === 'SELL';

        if (isBullish) {
          openPosition(coin, symbol, 'LONG', currentPrice, `Green Trend [${account.chartMode}]`);
          recentSignals.unshift({
            symbol,
            action: 'LONG',
            signal: 'LONG',
            price: currentPrice,
            time: new Date().toLocaleTimeString(),
            mode: `${account.timeframe} · ${account.chartMode}`,
            reason: 'Bullish Trend Entry'
          });
          if (recentSignals.length > 30) recentSignals.pop();
        } else if (isBearish && account.enableShorting) {
          openPosition(coin, symbol, 'SHORT', currentPrice, `Red Trend [${account.chartMode}]`);
          recentSignals.unshift({
            symbol,
            action: 'SHORT',
            signal: 'SHORT',
            price: currentPrice,
            time: new Date().toLocaleTimeString(),
            mode: `${account.timeframe} · ${account.chartMode}`,
            reason: 'Bearish Trend Entry (Short)'
          });
          if (recentSignals.length > 30) recentSignals.pop();
        }
      }
    } catch (err) {
      console.error(`Error scanning ${symbol}:`, err.message);
    }
  }
}

// Simple HTTP server for local testing
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ account, recentSignals, marketData, lastUpdated: new Date().toISOString() }));
    return;
  }

  if (pathname === '/state.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ account, recentSignals, marketScan: marketData, lastUpdated: new Date().toISOString() }));
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

setInterval(scanMarket, 15000);
scanMarket();

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
