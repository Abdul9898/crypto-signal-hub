// Client-Side Controller for Crypto Signal Hub with Sadeeq Indicator
let autoTradingEnabled = true;

async function updateDashboard() {
  try {
    const statsRes = await fetch('/api/stats');
    const stats = await statsRes.json();

    document.getElementById('val-portfolio').textContent = `$${stats.totalPortfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('val-cash').textContent = `Cash: $${stats.cashBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDT`;
    
    const profitEl = document.getElementById('val-profit');
    const profitSign = stats.netProfit >= 0 ? '+' : '';
    profitEl.textContent = `${profitSign}$${stats.netProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    profitEl.className = `m-value ${stats.netProfit >= 0 ? 'positive' : 'negative'}`;
    
    document.getElementById('val-profit-pct').textContent = `${profitSign}${stats.profitPercent}%`;
    document.getElementById('val-winrate').textContent = `${stats.winRate}%`;
    document.getElementById('val-trades').textContent = `${stats.totalTrades} closed trades`;
    document.getElementById('val-holdings-val').textContent = `$${stats.holdingsValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    // Sync Mode Selector
    const modeSelect = document.getElementById('chart-mode-select');
    if (document.activeElement !== modeSelect) {
      modeSelect.value = stats.chartMode;
    }

    autoTradingEnabled = stats.autoTradingEnabled;
    const botBtn = document.getElementById('toggle-bot-btn');
    if (autoTradingEnabled) {
      botBtn.className = 'bot-btn active';
      botBtn.innerHTML = '<span class="dot"></span> BOT ACTIVE';
    } else {
      botBtn.className = 'bot-btn inactive';
      botBtn.innerHTML = '<span class="dot"></span> BOT PAUSED';
    }

    // 2. Fetch Market Data & Signals
    const marketRes = await fetch('/api/market');
    const { marketData, recentSignals, holdings, tradeHistory } = await marketRes.json();

    const holdingCount = Object.keys(holdings || {}).length;
    document.getElementById('val-holdings-count').textContent = `${holdingCount} active position${holdingCount === 1 ? '' : 's'}`;

    // Render Market Table
    const tbody = document.getElementById('market-tbody');
    if (marketData && marketData.length > 0) {
      tbody.innerHTML = marketData.map(item => {
        const isUp = parseFloat(item.priceChange24h) >= 0;
        const changeClass = isUp ? 'positive-change' : 'negative-change';
        const changeSign = isUp ? '+' : '';

        return `
          <tr>
            <td><span class="coin-badge">${item.symbol}</span></td>
            <td class="price-text">$${Number(item.currentPrice).toLocaleString()}</td>
            <td class="${changeClass}">${changeSign}${item.priceChange24h}%</td>
            <td><span class="state-tag state-${item.candleColor}">${item.candleColor}</span></td>
            <td class="price-text">$${item.brickSize}</td>
            <td><span class="signal-tag signal-${item.action}">${item.action}</span></td>
          </tr>
        `;
      }).join('');
    }

    // Render Recent Signals
    const signalList = document.getElementById('signal-list');
    if (recentSignals && recentSignals.length > 0) {
      signalList.innerHTML = recentSignals.map(sig => `
        <div class="feed-item">
          <div class="feed-desc">
            <strong style="color: ${sig.action === 'LONG' ? '#34d399' : '#f87171'}">${sig.symbol} · ${sig.action}</strong>
            <span class="feed-sub">${sig.reason}</span>
          </div>
          <div style="text-align: right;">
            <span class="price-text">$${sig.price}</span>
            <div class="feed-sub">${sig.time}</div>
          </div>
        </div>
      `).join('');
    }

    // Render Trade History
    const tradeList = document.getElementById('trade-list');
    if (tradeHistory && tradeHistory.length > 0) {
      tradeList.innerHTML = tradeHistory.map(tr => {
        const isLong = tr.type === 'LONG';
        const pnlText = !isLong ? (tr.pnl >= 0 ? `+$${tr.pnl}` : `-$${Math.abs(tr.pnl)}`) : '';
        const pnlColor = tr.pnl >= 0 ? 'var(--green)' : 'var(--red)';

        return `
          <div class="feed-item">
            <div class="feed-desc">
              <strong style="color: ${isLong ? 'var(--accent-cyan)' : '#f87171'}">${tr.type} ${tr.symbol}</strong>
              <span class="feed-sub">${tr.amount} @ $${tr.price} (${tr.totalUSDT} USDT)</span>
            </div>
            <div style="text-align: right;">
              <span style="font-weight: 700; color: ${pnlColor}">${pnlText}</span>
              <div class="feed-sub">${tr.time}</div>
            </div>
          </div>
        `;
      }).join('');
    }

  } catch (err) {
    console.error('Error refreshing dashboard:', err);
  }
}

// Switch Chart Type
document.getElementById('chart-mode-select').addEventListener('change', async (e) => {
  await fetch('/api/set-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chartMode: e.target.value })
  });
  updateDashboard();
});

document.getElementById('toggle-bot-btn').addEventListener('click', async () => {
  await fetch('/api/toggle-bot', { method: 'POST' });
  updateDashboard();
});

document.getElementById('reset-account-btn').addEventListener('click', async () => {
  if (confirm('Reset paper trading balance back to $10,000 USDT?')) {
    await fetch('/api/reset', { method: 'POST' });
    updateDashboard();
  }
});

updateDashboard();
setInterval(updateDashboard, 2000);
