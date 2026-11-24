// Client-Side Real-Time TradingView Engine & Scalping Controller
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 
  'DOGEUSDT', 'ADAUSDT', 'XRPUSDT', 'AVAXUSDT'
];

let autoTradingEnabled = true;

async function updateDashboard() {
  try {
    // 1. Immediately load state.json first so UI never stays frozen on "Scanning..."
    let state = null;
    try {
      const stateRes = await fetch('./state.json?t=' + Date.now());
      if (stateRes.ok) {
        state = await stateRes.json();
      }
    } catch (e) {
      console.warn('State fetch error:', e);
    }

    if (!state || !state.account) return;

    const { account, recentSignals = [], marketScan = {} } = state;
    const holdings = account.holdings || {};

    // 2. Fetch live Binance tickers with an abort timeout
    let tickers = {};
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const tickerRes = await fetch('https://data-api.binance.vision/api/v3/ticker/24hr', { signal: controller.signal });
      clearTimeout(timeoutId);
      const allTickers = await tickerRes.json();
      allTickers.forEach(t => {
        if (SYMBOLS.includes(t.symbol)) tickers[t.symbol] = t;
      });
    } catch (e) {
      console.warn('Ticker fetch fallback:', e.message);
    }

    // 3. Prepare market scan results using live tickers or fallback to recorded state
    const marketScanResults = [];
    for (const sym of SYMBOLS) {
      const saved = marketScan[sym] || {};
      const tick = tickers[sym] || {};
      const price = tick.lastPrice ? parseFloat(tick.lastPrice) : (saved.price || 0);
      const priceChangePercent = tick.priceChangePercent ? parseFloat(tick.priceChangePercent) : 0;
      const candleColor = saved.candleColor || (priceChangePercent >= 0 ? 'green' : 'red');
      const brickSize = saved.brickSize || '0.00';
      const actionBadge = saved.signal === 'BUY' ? 'LONG' : (saved.signal === 'SELL' ? 'SHORT' : (candleColor === 'green' ? 'BULLISH' : 'BEARISH'));

      marketScanResults.push({
        symbol: sym,
        price,
        priceChangePercent,
        candleColor,
        brickSize,
        actionBadge
      });
    }

    // 4. Calculate Portfolio Valuation
    let holdingsValue = 0;
    const holdingsEntries = Object.entries(holdings);
    const activeHoldingsData = [];

    for (const [coin, data] of holdingsEntries) {
      const sym = `${coin}USDT`;
      const liveCoinData = marketScanResults.find(m => m.symbol === sym);
      const curPrice = liveCoinData && liveCoinData.price > 0 ? liveCoinData.price : (data.avgPrice || 0);
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

    // Render Metric Cards
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

    // Render Active Holdings Table (Immediate)
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
              <td class="price-text">$${h.avgPrice >= 1 ? h.avgPrice.toFixed(4) : h.avgPrice.toFixed(6)}</td>
              <td class="price-text">$${h.val.toFixed(2)}</td>
              <td class="${pnlClass}"><strong>${pnlSign}$${h.unrealizedPnl.toFixed(2)} (${pnlSign}${h.unrealizedPnlPct}%)</strong></td>
            </tr>
          `;
        }).join('');
      } else {
        holdingsTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted); padding: 16px;">No open positions currently held.</td></tr>`;
      }
    }

    // Render Market Scanner Table (Immediate)
    const tbody = document.getElementById('market-tbody');
    if (tbody && marketScanResults.length > 0) {
      tbody.innerHTML = marketScanResults.map(item => {
        const isUp = item.priceChangePercent >= 0;
        const changeClass = isUp ? 'positive-change' : 'negative-change';
        const changeSign = isUp ? '+' : '';
        const price = item.price;
        const stateColor = item.candleColor === 'green' ? 'state-green' : 'state-red';
        const actionClass = item.actionBadge === 'LONG' || item.actionBadge === 'BULLISH' ? 'signal-BUY' : 'signal-SELL';

        return `
          <tr>
            <td><span class="coin-badge">${item.symbol}</span></td>
            <td class="price-text">$${price >= 1 ? price.toLocaleString(undefined, { minimumFractionDigits: 2 }) : price.toFixed(6)}</td>
            <td class="${changeClass}">${changeSign}${item.priceChangePercent.toFixed(2)}%</td>
            <td><span class="state-tag ${stateColor}">${item.candleColor}</span></td>
            <td class="price-text">$${Number(item.brickSize).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</td>
            <td><span class="signal-tag ${actionClass}">${item.actionBadge}</span></td>
          </tr>
        `;
      }).join('');
    }

    // Render Recent Signals Fired
    const signalList = document.getElementById('signal-list');
    if (signalList) {
      if (recentSignals && recentSignals.length > 0) {
        signalList.innerHTML = recentSignals.map(sig => {
          const actionText = sig.action || sig.signal || 'SIGNAL';
          const isBuy = actionText.includes('LONG') || actionText.includes('BUY');
          const badgeClass = isBuy ? 'signal-BUY' : 'signal-SELL';
          return `
            <div class="feed-item">
              <div class="feed-desc">
                <strong>${sig.symbol} · ${actionText}</strong>
                <span class="feed-sub">${sig.reason || (sig.time + ' · 3m Scalp')}</span>
              </div>
              <div style="text-align: right;">
                <span class="signal-tag ${badgeClass}">${actionText}</span>
                <div class="feed-sub" style="margin-top: 4px;">$${Number(sig.price).toLocaleString()}</div>
              </div>
            </div>
          `;
        }).join('');
      } else {
        signalList.innerHTML = `<div class="empty-state">Waiting for scalp trigger...</div>`;
      }
    }

    // Render Paper Trading Execution Log
    const tradeList = document.getElementById('trade-list');
    const tradeHistory = account.tradeHistory || [];
    if (tradeList) {
      if (tradeHistory.length > 0) {
        tradeList.innerHTML = tradeHistory.map(tr => {
          const isClose = (tr.action || tr.type || '').includes('CLOSE') || (tr.action || tr.type || '').includes('SHORT') || (tr.type === 'SELL');
          const pnlVal = tr.pnl || 0;
          const pnlClass = pnlVal >= 0 ? 'positive-change' : 'negative-change';
          const pnlSign = pnlVal >= 0 ? '+' : '';
          const pnlText = isClose && tr.pnl !== undefined ? `<span class="${pnlClass}" style="display:block; font-size: 0.75rem;">${pnlSign}$${pnlVal.toFixed(2)}</span>` : '';
          const actionName = tr.action || tr.type || 'TRADE';
          const badgeClass = actionName.includes('LONG') || actionName.includes('BUY') ? 'signal-BUY' : 'signal-SELL';

          return `
            <div class="feed-item">
              <div class="feed-desc">
                <strong>${actionName} ${tr.symbol}</strong>
                <span class="feed-sub">${tr.amount || ''} @ $${Number(tr.price || tr.exitPrice || 0).toLocaleString()} · ${tr.time}</span>
              </div>
              <div style="text-align: right;">
                <span class="signal-tag ${badgeClass}">${actionName}</span>
                ${pnlText}
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

// Immediate initial run and poll every 3 seconds
updateDashboard();
setInterval(updateDashboard, 3000);
