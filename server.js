import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SYMBOLS, DEFAULT_CHART_MODE, processIndicator } from './indicators.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3000;

// In-Memory Paper Trading State & Simulated Account
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
  timeframe: '3m'
};

let marketData = {};
let recentSignals = [];

function fetchJSON(url, timeoutMs = 10000) {
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

// Market Scanner
async function scanMarket() {
  for (const symbol of SYMBOLS) {
    try {
      const klines = await fetchJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${account.timeframe || '3m'}&limit=150`);
      if (!Array.isArray(klines)) continue;

      const opens = klines.map(k => parseFloat(k[1]));
      const highs = klines.map(k => parseFloat(k[2]));
      const lows = klines.map(k => parseFloat(k[3]));
      const closes = klines.map(k => parseFloat(k[4]));

      const currentPrice = closes[closes.length - 1];
      const priceChange24h = ((currentPrice - closes[0]) / closes[0] * 100).toFixed(2);

      const indicatorRes = processIndicator(opens, highs, lows, closes, {
        mode: account.chartMode,
        brickMultiplier: account.brickMultiplier,
        atrLen: account.atrPeriod,
        superTrendFactor: account.superTrendFactor,
        superTrendAtrLen: account.superTrendAtrLen
      });

      if (!indicatorRes) continue;

      const candleColorUpper = indicatorRes.currColor.toUpperCase();
      let action = 'NEUTRAL';
      let confidence = 60;
      let reason = `Holding ${candleColorUpper} ${account.chartMode}`;

      if (indicatorRes.longSig) {
        action = 'LONG';
        confidence = 88;
        reason = `Flipped GREEN [${account.chartMode}]`;
      } else if (indicatorRes.shortSig) {
        action = 'SHORT';
        confidence = 88;
        reason = `Flipped RED [${account.chartMode}]`;
      } else if (candleColorUpper === 'GREEN') {
        action = 'BULLISH';
        reason = `Sustained Green [${account.chartMode}]`;
      } else {
        action = 'BEARISH';
        reason = `Sustained Red [${account.chartMode}]`;
      }

      marketData[symbol] = {
        symbol,
        currentPrice,
        priceChange24h,
        candleColor: indicatorRes.currColor,
        cOpen: indicatorRes.cOpen,
        cClose: indicatorRes.cClose,
        brickSize: indicatorRes.brickSize,
        stopLevel: indicatorRes.stopLevel,
        action,
        confidence,
        reason,
        timestamp: new Date().toISOString()
      };

      const coin = symbol.replace('USDT', '');
      const shouldEnterLong = indicatorRes.longSig || (candleColorUpper === 'GREEN' && !account.holdings[coin]);
      const shouldExit = indicatorRes.shortSig || (candleColorUpper === 'RED' && account.holdings[coin]);

      if (shouldEnterLong || shouldExit) {
        const signalObj = {
          id: Date.now() + Math.random().toString(36).substr(2, 4),
          symbol,
          action: shouldEnterLong ? 'LONG' : 'SHORT',
          price: currentPrice,
          confidence,
          reason: shouldEnterLong ? `Green Entry [${account.chartMode}]` : `Red Exit [${account.chartMode}]`,
          time: new Date().toLocaleTimeString()
        };

        const lastSig = recentSignals[0];
        if (!lastSig || lastSig.symbol !== symbol || lastSig.action !== signalObj.action || (Date.now() - (lastSig._timestamp || 0) > 30000)) {
          signalObj._timestamp = Date.now();
          recentSignals.unshift(signalObj);
          if (recentSignals.length > 30) recentSignals.pop();

          if (account.autoTradingEnabled) {
            executePaperTrade(signalObj);
          }
        }
      }
    } catch (err) {
      console.error(`Error scanning ${symbol}:`, err.message);
    }
  }
}

// Paper Trade Execution
function executePaperTrade(signal) {
  const coin = signal.symbol.replace('USDT', '');
  const price = signal.price;

  if (signal.action === 'LONG') {
    const tradeAlloc = account.balance * (account.riskPerTradePercent / 100);
    if (tradeAlloc > 20) {
      const amount = tradeAlloc / price;
      account.balance -= tradeAlloc;

      if (!account.holdings[coin]) {
        account.holdings[coin] = { amount: 0, avgPrice: 0 };
      }

      const totalCost = (account.holdings[coin].amount * account.holdings[coin].avgPrice) + tradeAlloc;
      account.holdings[coin].amount += amount;
      account.holdings[coin].avgPrice = totalCost / account.holdings[coin].amount;

      account.totalTrades++;
      account.tradeHistory.unshift({
        type: 'LONG',
        action: 'LONG',
        symbol: signal.symbol,
        price,
        amount: Number(amount.toFixed(4)),
        totalUSDT: Number(tradeAlloc.toFixed(2)),
        time: new Date().toLocaleTimeString(),
        pnl: 0
      });
    }
  } else if (signal.action === 'SHORT') {
    if (account.holdings[coin] && account.holdings[coin].amount > 0) {
      const amount = account.holdings[coin].amount;
      const avgPrice = account.holdings[coin].avgPrice;
      const revenue = amount * price;
      const profitLoss = revenue - (amount * avgPrice);

      account.balance += revenue;
      delete account.holdings[coin];

      account.totalTrades++;
      if (profitLoss > 0) account.winningTrades++;

      account.tradeHistory.unshift({
        type: 'CLOSE / SHORT',
        action: 'CLOSE / SHORT',
        symbol: signal.symbol,
        price,
        amount: Number(amount.toFixed(4)),
        totalUSDT: Number(revenue.toFixed(2)),
        time: new Date().toLocaleTimeString(),
        pnl: Number(profitLoss.toFixed(2))
      });
    }
  }
  if (account.tradeHistory.length > 50) account.tradeHistory.pop();
}

function getPortfolioStats() {
  let holdingsValue = 0;
  for (const [coin, data] of Object.entries(account.holdings)) {
    const symbol = `${coin}USDT`;
    const curPrice = marketData[symbol]?.currentPrice || data.avgPrice;
    holdingsValue += data.amount * curPrice;
  }
  const totalValue = account.balance + holdingsValue;
  const netProfit = totalValue - account.initialBalance;
  const profitPercent = ((netProfit / account.initialBalance) * 100).toFixed(2);
  const winRate = account.totalTrades > 0 ? ((account.winningTrades / account.totalTrades) * 100).toFixed(1) : 0;

  return {
    initialBalance: account.initialBalance,
    balance: Number(account.balance.toFixed(2)),
    cashBalance: Number(account.balance.toFixed(2)),
    holdingsValue: Number(holdingsValue.toFixed(2)),
    totalPortfolioValue: Number(totalValue.toFixed(2)),
    netProfit: Number(netProfit.toFixed(2)),
    profitPercent,
    winRate,
    totalTrades: account.totalTrades,
    winningTrades: account.winningTrades,
    autoTradingEnabled: account.autoTradingEnabled,
    chartMode: account.chartMode,
    brickMultiplier: account.brickMultiplier,
    atrPeriod: account.atrPeriod,
    superTrendFactor: account.superTrendFactor,
    superTrendAtrLen: account.superTrendAtrLen,
    timeframe: account.timeframe,
    holdings: account.holdings,
    tradeHistory: account.tradeHistory.slice(0, 20)
  };
}

// Server Endpoints
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const reqPath = (req.url || '/').split('?')[0];

  if (reqPath === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPortfolioStats()));
    return;
  }

  if (reqPath === '/api/market') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      marketData: Object.values(marketData),
      recentSignals,
      holdings: account.holdings,
      tradeHistory: account.tradeHistory.slice(0, 20)
    }));
    return;
  }

  if (reqPath === '/api/toggle-bot' && req.method === 'POST') {
    account.autoTradingEnabled = !account.autoTradingEnabled;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ autoTradingEnabled: account.autoTradingEnabled }));
    return;
  }

  if (reqPath === '/api/set-mode' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.chartMode) account.chartMode = data.chartMode;
        if (data.brickMultiplier) account.brickMultiplier = parseFloat(data.brickMultiplier);
        if (data.superTrendFactor) account.superTrendFactor = parseFloat(data.superTrendFactor);
        scanMarket();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', chartMode: account.chartMode, brickMultiplier: account.brickMultiplier }));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  if (reqPath === '/api/reset' && req.method === 'POST') {
    account.balance = account.initialBalance;
    account.holdings = {};
    account.tradeHistory = [];
    account.totalTrades = 0;
    account.winningTrades = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'Account reset' }));
    return;
  }

  const filePath = path.join(__dirname, 'public', reqPath === '/' ? 'index.html' : reqPath);
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      const ext = path.extname(filePath);
      const mimeMap = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json'
      };
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'text/plain' });
      res.end(content);
    }
  });
});

scanMarket();
setInterval(scanMarket, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Crypto Signal Hub (${account.chartMode} Engine) on http://localhost:${PORT}`);
});
