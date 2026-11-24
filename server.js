import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3000;

// In-Memory Paper Trading State & Simulated Account
let account = {
  initialBalance: 10000.0,
  balance: 10000.0, // USDT
  holdings: {},     // { BTC: { amount: 0.1, avgPrice: 65000 } }
  tradeHistory: [],
  totalTrades: 0,
  winningTrades: 0,
  autoTradingEnabled: true,
  riskPerTradePercent: 12,
  chartMode: "Line Break Style",
  brickMultiplier: 0.5,
  atrPeriod: 14,
  timeframe: "1m" // Fast scalping timeframe (1m / 1s tick updates)
};

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 
  'DOGEUSDT', 'ADAUSDT', 'XRPUSDT', 'AVAXUSDT'
];

let marketData = {};
let recentSignals = [];

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CryptoSignalHub/1.0' } }, (res) => {
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
// SADEED_TRADING PINESCRIPT ALGORITHM PORT TO JAVASCRIPT
// Supports: Normal, Heikin Ashi, Renko Style, Line Break Style
// Trigger: Real-time Color Flip (Green Flip = LONG, Red Flip = SHORT)
// ----------------------------------------------------------------------

// Calculate True Range (TR) & ATR
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
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
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
  } else if (mode === "Renko Style") {
    let rClose = closes[0];
    let rOpen = closes[0];
    for (let i = 0; i < len; i++) {
      const cur = closes[i];
      let newRClose = rClose;
      if (cur >= rClose + brick) {
        newRClose = rClose + brick;
      } else if (cur <= rClose - brick) {
        newRClose = rClose - brick;
      }
      const newROpen = (newRClose !== rClose) ? rClose : rOpen;
      rClose = newRClose;
      rOpen = newROpen;
      cOpen.push(rOpen);
      cClose.push(rClose);
    }
  } else {
    // Default: LINE BREAK STYLE (as defined in your script)
    let lbClose = closes[0];
    let lbOpen = closes[0];
    for (let i = 0; i < len; i++) {
      const cur = closes[i];
      let newLbClose = lbClose;
      if (Math.abs(cur - lbClose) >= brick) {
        newLbClose = cur;
      }
      const newLbOpen = (newLbClose !== lbClose) ? lbClose : lbOpen;
      lbClose = newLbClose;
      lbOpen = newLbOpen;
      cOpen.push(lbOpen);
      cClose.push(lbClose);
    }
  }

  // Evaluate Signals (Forming / Latest Bar Color Flip)
  const lastIdx = len - 1;
  const prevIdx = len - 2;

  const isUpCurrent = cClose[lastIdx] >= cOpen[lastIdx];
  const isUpPrev = cClose[prevIdx] >= cOpen[prevIdx];

  const longSig = isUpCurrent && !isUpPrev;
  const shortSig = !isUpCurrent && isUpPrev;

  return {
    cOpen: cOpen[lastIdx],
    cClose: cClose[lastIdx],
    candleColor: isUpCurrent ? "GREEN" : "RED",
    longSig,
    shortSig,
    brickSize: Number(brick.toFixed(4)),
    atrVal: Number(atrVal.toFixed(4))
  };
}

// Market Scanner
async function scanMarket() {
  for (const symbol of SYMBOLS) {
    try {
      // Fast 1m candles for high-frequency signal detection
      const klines = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${account.timeframe || '1m'}&limit=100`);
      if (!Array.isArray(klines)) continue;

      const opens = klines.map(k => parseFloat(k[1]));
      const highs = klines.map(k => parseFloat(k[2]));
      const lows = klines.map(k => parseFloat(k[3]));
      const closes = klines.map(k => parseFloat(k[4]));

      const currentPrice = closes[closes.length - 1];
      const priceChange24h = ((currentPrice - closes[0]) / closes[0] * 100).toFixed(2);

      const indicatorRes = processSadeeqIndicator(
        opens, highs, lows, closes, 
        account.chartMode, 
        account.brickMultiplier, 
        account.atrPeriod
      );

      if (!indicatorRes) continue;

      let action = 'NEUTRAL';
      let confidence = 60;
      let reason = `Holding ${indicatorRes.candleColor} ${account.chartMode}`;

      if (indicatorRes.longSig) {
        action = 'LONG';
        confidence = 88;
        reason = `Color flipped GREEN [${account.chartMode} Breakout: +Brick ${indicatorRes.brickSize}]`;
      } else if (indicatorRes.shortSig) {
        action = 'SHORT';
        confidence = 88;
        reason = `Color flipped RED [${account.chartMode} Breakdown: -Brick ${indicatorRes.brickSize}]`;
      } else if (indicatorRes.candleColor === 'GREEN') {
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
        candleColor: indicatorRes.candleColor,
        cOpen: indicatorRes.cOpen,
        cClose: indicatorRes.cClose,
        brickSize: indicatorRes.brickSize,
        action,
        confidence,
        reason,
        timestamp: new Date().toISOString()
      };

      // Fired Signals on Flip or if Green and no active position yet
      const coin = symbol.replace('USDT', '');
      const shouldEnterLong = indicatorRes.longSig || (indicatorRes.candleColor === 'GREEN' && !account.holdings[coin]);
      const shouldExit = indicatorRes.shortSig || (indicatorRes.candleColor === 'RED' && account.holdings[coin]);

      if (shouldEnterLong || shouldExit) {
        const signalObj = {
          id: Date.now() + Math.random().toString(36).substr(2, 4),
          symbol,
          action: shouldEnterLong ? 'LONG' : 'SHORT',
          price: currentPrice,
          confidence,
          reason: shouldEnterLong ? `Green Candle Entry [${account.chartMode}]` : `Red Candle Exit [${account.chartMode}]`,
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
        symbol: signal.symbol,
        price,
        amount: Number(amount.toFixed(4)),
        totalUSDT: Number(tradeAlloc.toFixed(2)),
        time: new Date().toLocaleTimeString(),
        pnl: 0
      });
    }
  } else if (signal.action === 'SHORT') {
    // If we have an existing spot/paper long position on this coin, close it for profit/loss
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
    cashBalance: Number(account.balance.toFixed(2)),
    holdingsValue: Number(holdingsValue.toFixed(2)),
    totalPortfolioValue: Number(totalValue.toFixed(2)),
    netProfit: Number(netProfit.toFixed(2)),
    profitPercent,
    winRate,
    totalTrades: account.totalTrades,
    autoTradingEnabled: account.autoTradingEnabled,
    chartMode: account.chartMode,
    brickMultiplier: account.brickMultiplier
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

  if (req.url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPortfolioStats()));
    return;
  }

  if (req.url === '/api/market') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      marketData: Object.values(marketData),
      recentSignals,
      holdings: account.holdings,
      tradeHistory: account.tradeHistory.slice(0, 15)
    }));
    return;
  }

  if (req.url === '/api/toggle-bot' && req.method === 'POST') {
    account.autoTradingEnabled = !account.autoTradingEnabled;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ autoTradingEnabled: account.autoTradingEnabled }));
    return;
  }

  if (req.url === '/api/set-mode' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.chartMode) account.chartMode = data.chartMode;
        if (data.brickMultiplier) account.brickMultiplier = parseFloat(data.brickMultiplier);
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

  if (req.url === '/api/reset' && req.method === 'POST') {
    account.balance = account.initialBalance;
    account.holdings = {};
    account.tradeHistory = [];
    account.totalTrades = 0;
    account.winningTrades = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'Account reset' }));
    return;
  }

  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      const ext = path.extname(filePath);
      let contentType = 'text/html';
      if (ext === '.css') contentType = 'text/css';
      if (ext === '.js') contentType = 'application/javascript';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

// Fast scan every 3 seconds for rapid ticks and color-flips
scanMarket();
setInterval(scanMarket, 3000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Crypto Signal Hub (Fast Sadeeq Indicator Engine) on http://localhost:${PORT}`);
});
