// Client-Side Real-Time TradingView Engine & Dashboard Controller
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'XRPUSDT', 'AVAXUSDT'];

// Pure Pine Script math: "All Charts · Sadeeq_Trading"
function calculatePineIndicator(klines, brickMultiplier = 0.5, atrLen = 14) {
  if (!Array.isArray(klines) || klines.length < atrLen + 2) return null;

  const opens = klines.map(d => parseFloat(d[1]));
  const highs = klines.map(d => parseFloat(d[2]));
  const lows = klines.map(d => parseFloat(d[3]));
  const closes = klines.map(d => parseFloat(d[4]));
  const len = closes.length;

  // Exact TradingView RMA Wilder ATR
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < len; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let atrArr = new Array(len).fill(0);
  let sum = 0;
  for (let i = 0; i < atrLen; i++) sum += tr[i];
  atrArr[atrLen - 1] = sum / atrLen;
  for (let i = atrLen; i < len; i++) {
    atrArr[i] = (atrArr[i - 1] * (atrLen - 1) + tr[i]) / atrLen;
  }

  // Exact Line Break Style from Pine Script:
  // lbClose := na(lbClose[1]) ? close : math.abs(close - lbClose[1]) >= brick ? close : lbClose[1]
  // lbOpen  := na(lbOpen[1])  ? close : lbClose != lbClose[1] ? lbClose[1] : lbOpen[1]
  let lbClose = closes[0];
  let lbOpen = closes[0];
  let cClose = [];
  let cOpen = [];

  for (let i = 0; i < len; i++) {
    const c = closes[i];
    const brick = atrArr[i] * brickMultiplier;
    const prevLbClose = lbClose;
    if (Math.abs(c - prevLbClose) >= brick) {
      lbClose = c;
    }
    if (lbClose !== prevLbClose) {
      lbOpen = prevLbClose;
    }
    cClose.push(lbClose);
    cOpen.push(lbOpen);
  }

  const isUp = [];
  for (let i = 0; i < len; i++) {
    isUp.push(cClose[i] >= cOpen[i]);
  }

  const last = len - 1;
  const prev = len - 2;
  const longSig = isUp[last] && !isUp[prev];
  const shortSig = !isUp[last] && isUp[prev];
  const currColor = isUp[last] ? 'green' : 'red';

  return {
    price: closes[last],
    candleColor: currColor,
    signal: longSig ? 'BUY' : (shortSig ? 'SELL' : (currColor === 'green' ? 'BULLISH' : 'BEARISH')),
    actionBadge: longSig ? 'BUY' : (shortSig ? 'SELL' : (currColor === 'green' ? 'LONG BIAS' : 'SHORT BIAS')),
    actionType: longSig ? 'BUY' : (shortSig ? 'SELL' : 'HOLD'),
    brickSize: (atrArr[last] * brickMultiplier).toFixed(4),
    atr: atrArr[last].toFixed(4),
    time: new Date(klines[last][0]).toLocaleTimeString()
  };
}

let autoTradingEnabled = true;

async function updateDashboard() {
  try {
    let state = null;

    // Load persistent paper trading state
    try {
      const stateRes = await fetch('./state.json?t=' + Date.now());
      if (stateRes.ok) {
        state = await stateRes.json();
      }
    } catch (e) {
      console.log('State fetch error:', e);
    }

    if (!state || !state.account) return;

    const { account, recentSignals = [] } = state;

    // Fetch 24h ticker for daily volume & change
    let tickers = {};
    try {
      const tickerRes = await fetch('https://data-api.binance.vision/api/v3/ticker/24hr');
      const allTickers = await tickerRes.json();
      allTickers.forEach(t => {
        if (SYMBOLS.includes(t.symbol)) tickers[t.symbol] = t;
      });
    } catch (e) {
      console.warn('Ticker fetch error:', e);
    }

    // Run Real-Time 15m Pine Script Indicator Directly in Browser for every coin
    const marketScanResults = [];
    for (const sym of SYMBOLS) {
      try {
        const klineRes = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=15m&limit=150`);
        const klines = await klineRes.json();
        const ind = calculatePineIndicator(klines, account.brickMultiplier || 0.5, account.atrPeriod || 14);
        if (ind) {
          const tick = tickers[sym] || { priceChangePercent: '0' };
          marketScanResults.push({
            symbol: sym,
            price: ind.price,
            priceChangePercent: parseFloat(tick.priceChangePercent),
            candleColor: ind.candleColor,
            brickSize: ind.brickSize,
            actionBadge: ind.actionBadge,
            actionType: ind.actionType,
            signal: ind.signal,
            time: ind.time
          });
        }
      } catch (err) {
        console.warn(`Error scanning ${sym}:`, err);
      }
    }

    // Dynamic Portfolio & Holdings Valuation
    let holdingsValue = 0;
    const holdingsEntries = Object.entries(account.holdings || {});
    const activeHoldingsData = [];

    for (const [coin, data] of holdingsEntries) {
      const sym = `${coin}USDT`;
      const liveCoinData = marketScanResults.find(m => m.symbol === sym);
      const curPrice = liveCoinData ? liveCoinData.price : (data.avgPrice || 0);
      const val = data.amount * curPrice;
      const cost = data.amount * data.avgPrice;
      const unrealizedPnl = val - cost;
      const unrealizedPnlPct = cost > 0 ? ((unrealizedPnl / cost) * 100).toFixed(2) : '0.00';

      holdingsValue += val;
      activeHoldingsData.push({
        coin,
        amount: data.amount,
        avgPrice: data.avgPrice,
        curPrice,
        val,
        unrealizedPnl,
        unrealizedPnlPct
      });
    }

    const totalPortfolioValue = (account.balance || 0) + holdingsValue;
    const netProfit = totalPortfolioValue - (account.initialBalance || 10000);
    const profitPercent = ((netProfit / (account.initialBalance || 10000)) * 100).toFixed(2);
    const winRate = account.totalTrades > 0 ? ((account.winningTrades / account.totalTrades) * 100).toFixed(1) : 0;

    // 1. Update Portfolio Metric Cards
    document.getElementById('val-portfolio').textContent = `$${totalPortfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('val-cash').textContent = `Cash: $${(account.balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
    
    const profitEl = document.getElementById('val-profit');
    const profitSign = netProfit >= 0 ? '+' : '';
    profitEl.textContent = `${profitSign}$${netProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    profitEl.className = `m-value ${netProfit >= 0 ? 'positive' : 'negative'}`;
    
    document.getElementById('val-profit-pct').textContent = `${profitSign}${profitPercent}%`;
    document.getElementById('val-winrate').textContent = `${winRate}%`;
    document.getElementById('val-trades').textContent = `${account.totalTrades || 0} closed trades`;
    document.getElementById('val-holdings-val').textContent = `$${holdingsValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('val-holdings-count').textContent = `${holdingsEntries.length} active position${holdingsEntries.length === 1 ? '' : 's'}`;

    // 2. Render Active Holdings
    const holdingsTbody = document.getElementById('holdings-tbody');
    if (holdingsTbody) {
      if (activeHoldingsData.length > 0) {
        holdingsTbody.innerHTML = activeHoldingsData.map(h => {
          const isPnlPositive = h.unrealizedPnl >= 0;
          const pnlClass = isPnlPositive ? 'positive-change' : 'negative-change';
          const pnlSign = isPnlPositive ? '+' : '';
          return `
            <tr>
              <td><span class="coin-badge">${h.coin}</span></td>
              <td>${h.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${h.coin}</td>
              <td class="price-text">$${h.avgPrice.toFixed(4)}</td>
              <td class="price-text">$${h.val.toFixed(2)}</td>
              <td class="${pnlClass}"><strong>${pnlSign}$${h.unrealizedPnl.toFixed(2)} (${pnlSign}${h.unrealizedPnlPct}%)</strong></td>
            </tr>
          `;
        }).join('');
      } else {
        holdingsTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted); padding: 16px;">No open positions currently held.</td></tr>`;
      }
    }

    // 3. Render Real-Time Market Table Directly Synchronized with Pine Script
    const tbody = document.getElementById('market-tbody');
    if (tbody && marketScanResults.length > 0) {
      tbody.innerHTML = marketScanResults.map(item => {
        const isUp = item.priceChangePercent >= 0;
        const changeClass = isUp ? 'positive-change' : 'negative-change';
        const changeSign = isUp ? '+' : '';
        const price = item.price;

        return `
          <tr>
            <td><span class="coin-badge">${item.symbol}</span></td>
            <td class="price-text">$${price >= 1 ? price.toLocaleString(undefined, { minimumFractionDigits: 2 }) : price.toFixed(5)}</td>
            <td class="${changeClass}">${changeSign}${item.priceChangePercent.toFixed(2)}%</td>
            <td><span class="state-tag state-${item.candleColor}">${item.candleColor}</span></td>
            <td class="price-text">$${Number(item.brickSize).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
            <td><span class="signal-tag signal-${item.actionBadge.replace(' ', '_')}">${item.actionBadge}</span></td>
          </tr>
        `;
      }).join('');
    }

    // 4. Render Recent Signals Fired
    const signalList = document.getElementById('signal-list');
    if (signalList) {
      if (recentSignals && recentSignals.length > 0) {
        signalList.innerHTML = recentSignals.map(sig => `
          <div class="feed-item">
            <div class="feed-desc">
              <strong>${sig.symbol}</strong>
              <span class="feed-sub">${sig.time} · Line Break Style</span>
            </div>
            <div style="text-align: right;">
              <span class="signal-tag signal-${sig.signal}">${sig.signal}</span>
              <div class="feed-sub" style="margin-top: 4px;">$${Number(sig.price).toLocaleString()}</div>
            </div>
          </div>
        `).join('');
      } else {
        signalList.innerHTML = `<div class="empty-state">Waiting for color flip trigger...</div>`;
      }
    }

    // 5. Render Paper Trading Execution Log
    const tradeList = document.getElementById('trade-list');
    const tradeHistory = account.tradeHistory || [];
    if (tradeList) {
      if (tradeHistory.length > 0) {
        tradeList.innerHTML = tradeHistory.map(tr => {
          const isSell = tr.type === 'SELL';
          const pnlClass = tr.pnl >= 0 ? 'positive-change' : 'negative-change';
          const pnlSign = tr.pnl >= 0 ? '+' : '';
          const pnlInfo = isSell ? `<span class="${pnlClass}" style="display:block; font-size: 0.75rem;">${pnlSign}$${tr.pnl} (${tr.pnlPercent}%)</span>` : '';

          return `
            <div class="feed-item">
              <div class="feed-desc">
                <strong>${tr.symbol} (${Number(tr.amount).toFixed(2)})</strong>
                <span class="feed-sub">${tr.time} · @ $${Number(tr.price).toLocaleString()}</span>
              </div>
              <div style="text-align: right;">
                <span class="signal-tag signal-${tr.type}">${tr.type}</span>
                ${pnlInfo}
              </div>
            </div>
          `;
        }).join('');
      } else {
        tradeList.innerHTML = `<div class="empty-state">No executed trades yet. Bot is scanning...</div>`;
      }
    }

  } catch (err) {
    console.error('Error rendering dashboard:', err);
  }
}

// Live update every 4 seconds directly in your browser
updateDashboard();
setInterval(updateDashboard, 4000);
