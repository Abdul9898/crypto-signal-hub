// Client-Side Controller for Crypto Signal Hub with Sadeeq Indicator
let autoTradingEnabled = true;

async function updateDashboard() {
  try {
    let state = null;

    // Try fetching state.json (works on GitHub Pages or static host)
    try {
      const stateRes = await fetch('./state.json?t=' + Date.now());
      if (stateRes.ok) {
        state = await stateRes.json();
      }
    } catch (e) {
      console.log('Static state fetch fallback', e);
    }

    // Fallback to local server API if running locally
    if (!state) {
      try {
        const statsRes = await fetch('/api/stats');
        const stats = await statsRes.json();
        const marketRes = await fetch('/api/market');
        const mData = await marketRes.json();
        state = {
          account: stats,
          recentSignals: mData.recentSignals || [],
          marketData: mData.marketData || []
        };
      } catch (e) {
        console.error('API fetch failed', e);
      }
    }

    if (!state || !state.account) return;

    const { account, recentSignals = [] } = state;

    // Fetch live market prices directly from Binance Vision API (CORS friendly)
    const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'XRPUSDT', 'AVAXUSDT'];
    let prices = {};
    try {
      const tickerRes = await fetch('https://data-api.binance.vision/api/v3/ticker/24hr');
      const tickers = await tickerRes.json();
      tickers.forEach(t => {
        if (SYMBOLS.includes(t.symbol)) {
          prices[t.symbol] = t;
        }
      });
    } catch (e) {
      console.warn('Ticker fetch fallback', e);
    }

    // Calculate dynamic values
    let holdingsValue = 0;
    for (const [coin, data] of Object.entries(account.holdings || {})) {
      const sym = `${coin}USDT`;
      const curPrice = prices[sym] ? parseFloat(prices[sym].lastPrice) : (data.avgPrice || 0);
      holdingsValue += data.amount * curPrice;
    }

    const totalPortfolioValue = (account.balance || 0) + holdingsValue;
    const netProfit = totalPortfolioValue - (account.initialBalance || 10000);
    const profitPercent = ((netProfit / (account.initialBalance || 10000)) * 100).toFixed(2);
    const winRate = account.totalTrades > 0 ? ((account.winningTrades / account.totalTrades) * 100).toFixed(1) : 0;

    // 1. Update Metric Cards
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

    // Sync Mode Selector
    const modeSelect = document.getElementById('chart-mode-select');
    if (document.activeElement !== modeSelect && account.chartMode) {
      modeSelect.value = account.chartMode;
    }

    autoTradingEnabled = account.autoTradingEnabled ?? true;
    const botBtn = document.getElementById('toggle-bot-btn');
    if (autoTradingEnabled) {
      botBtn.className = 'bot-btn active';
      botBtn.innerHTML = '<span class="dot"></span> BOT ACTIVE (24/7)';
    } else {
      botBtn.className = 'bot-btn inactive';
      botBtn.innerHTML = '<span class="dot"></span> BOT PAUSED';
    }

    const holdingCount = Object.keys(account.holdings || {}).length;
    document.getElementById('val-holdings-count').textContent = `${holdingCount} active position${holdingCount === 1 ? '' : 's'}`;

    // Render Market Table
    const tbody = document.getElementById('market-tbody');
    if (Object.keys(prices).length > 0) {
      tbody.innerHTML = SYMBOLS.map(symbol => {
        const item = prices[symbol] || { lastPrice: '0', priceChangePercent: '0' };
        const price = parseFloat(item.lastPrice);
        const changePct = parseFloat(item.priceChangePercent);
        const isUp = changePct >= 0;
        const changeClass = isUp ? 'positive-change' : 'negative-change';
        const changeSign = isUp ? '+' : '';

        // Find last signal
        const sig = recentSignals.find(s => s.symbol === symbol);
        const action = sig ? sig.signal : 'HOLD';
        const candleColor = action === 'BUY' ? 'green' : (action === 'SELL' ? 'red' : 'green');

        return `
          <tr>
            <td><span class="coin-badge">${symbol}</span></td>
            <td class="price-text">$${price >= 1 ? price.toLocaleString(undefined, { minimumFractionDigits: 2 }) : price.toFixed(5)}</td>
            <td class="${changeClass}">${changeSign}${changePct.toFixed(2)}%</td>
            <td><span class="state-tag state-${candleColor}">${candleColor}</span></td>
            <td><span class="signal-tag signal-${action}">${action}</span></td>
            <td><span class="status-indicator">SCANNING</span></td>
          </tr>
        `;
      }).join('');
    }

    // Render Signals Feed
    const feed = document.getElementById('signals-feed');
    if (recentSignals && recentSignals.length > 0) {
      feed.innerHTML = recentSignals.map(sig => `
        <div class="signal-card signal-${sig.signal}">
          <div class="signal-head">
            <strong>${sig.symbol}</strong>
            <span class="tag tag-${sig.signal}">${sig.signal}</span>
          </div>
          <div class="signal-body">
            <span>Price: $${Number(sig.price).toLocaleString()}</span>
            <small>${sig.time} (${sig.mode || 'Line Break'})</small>
          </div>
        </div>
      `).join('');
    } else {
      feed.innerHTML = `<div class="empty-state">No recent signals yet. Monitoring markets...</div>`;
    }

    // Render Trade Log
    const logTbody = document.getElementById('trades-tbody');
    const tradeHistory = account.tradeHistory || [];
    if (tradeHistory.length > 0) {
      logTbody.innerHTML = tradeHistory.map(tr => {
        const isSell = tr.type === 'SELL';
        const pnlClass = tr.pnl >= 0 ? 'positive-change' : 'negative-change';
        const pnlText = isSell ? `${tr.pnl >= 0 ? '+' : ''}$${tr.pnl} (${tr.pnlPercent}%)` : '-';
        return `
          <tr>
            <td>${tr.time}</td>
            <td><strong>${tr.symbol}</strong></td>
            <td><span class="signal-tag signal-${tr.type}">${tr.type}</span></td>
            <td class="price-text">$${Number(tr.price).toLocaleString()}</td>
            <td>${Number(tr.amount).toFixed(4)}</td>
            <td class="${isSell ? pnlClass : ''}">${pnlText}</td>
          </tr>
        `;
      }).join('');
    } else {
      logTbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted); padding: 20px;">No simulated trades executed yet. Bot will auto-trade on signals.</td></tr>`;
    }

  } catch (err) {
    console.error('Error rendering dashboard:', err);
  }
}

// Initial fetch and poll
updateDashboard();
setInterval(updateDashboard, 5000);
