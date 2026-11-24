// Client-Side Controller for Crypto Signal Hub with Sadeeq Indicator
let autoTradingEnabled = true;

async function updateDashboard() {
  try {
    let state = null;

    // Fetch persistent state.json
    try {
      const stateRes = await fetch('./state.json?t=' + Date.now());
      if (stateRes.ok) {
        state = await stateRes.json();
      }
    } catch (e) {
      console.log('Static state fetch fallback', e);
    }

    if (!state) {
      try {
        const statsRes = await fetch('/api/stats');
        const stats = await statsRes.json();
        const marketRes = await fetch('/api/market');
        const mData = await marketRes.json();
        state = {
          account: stats,
          recentSignals: mData.recentSignals || [],
          marketData: mData.marketData || [],
          marketScan: {}
        };
      } catch (e) {
        console.error('API fetch failed', e);
      }
    }

    if (!state || !state.account) return;

    const { account, recentSignals = [], marketScan = {} } = state;

    // Live Binance Tickers for accurate pricing & unrealized PnL
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

    // Calculate dynamic portfolio and position values
    let holdingsValue = 0;
    const holdingsEntries = Object.entries(account.holdings || {});
    const activeHoldingsData = [];

    for (const [coin, data] of holdingsEntries) {
      const sym = `${coin}USDT`;
      const curPrice = prices[sym] ? parseFloat(prices[sym].lastPrice) : (data.avgPrice || 0);
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
        unrealizedPnlPct,
        boughtAt: data.boughtAt || '-'
      });
    }

    const totalPortfolioValue = (account.balance || 0) + holdingsValue;
    const netProfit = totalPortfolioValue - (account.initialBalance || 10000);
    const profitPercent = ((netProfit / (account.initialBalance || 10000)) * 100).toFixed(2);
    const winRate = account.totalTrades > 0 ? ((account.winningTrades / account.totalTrades) * 100).toFixed(1) : 0;

    // 1. Metric Cards
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

    // Mode Selector
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

    // 2. Render Active Open Holdings Table
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

    // 3. Render Market Scanner Table (Proper 6 Columns Aligned)
    const tbody = document.getElementById('market-tbody');
    if (tbody && Object.keys(prices).length > 0) {
      tbody.innerHTML = SYMBOLS.map(symbol => {
        const item = prices[symbol] || { lastPrice: '0', priceChangePercent: '0' };
        const price = parseFloat(item.lastPrice);
        const changePct = parseFloat(item.priceChangePercent);
        const isUp = changePct >= 0;
        const changeClass = isUp ? 'positive-change' : 'negative-change';
        const changeSign = isUp ? '+' : '';

        // Exact indicator calculation from cloud scanner
        const scan = marketScan[symbol];
        const candleColor = scan ? scan.candleColor : (isUp ? 'green' : 'red');
        const brickSizeDisplay = scan && scan.brickSize ? `$${Number(scan.brickSize).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : '-';
        const action = scan ? scan.signal : 'HOLD';

        return `
          <tr>
            <td><span class="coin-badge">${symbol}</span></td>
            <td class="price-text">$${price >= 1 ? price.toLocaleString(undefined, { minimumFractionDigits: 2 }) : price.toFixed(5)}</td>
            <td class="${changeClass}">${changeSign}${changePct.toFixed(2)}%</td>
            <td><span class="state-tag state-${candleColor}">${candleColor}</span></td>
            <td class="price-text">${brickSizeDisplay}</td>
            <td><span class="signal-tag signal-${action}">${action}</span></td>
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
              <span class="feed-sub">${sig.time} · ${sig.mode || 'Line Break'}</span>
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

// Initial fetch and poll every 5 seconds
updateDashboard();
setInterval(updateDashboard, 5000);
