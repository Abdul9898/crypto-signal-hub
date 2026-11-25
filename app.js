import { SYMBOLS, DEFAULT_CHART_MODE, CHART_MODES, formatPrice, processIndicator } from './indicators.js';

let liveIndicatorCache = {};
let previousStateHash = '';
let currentMode = localStorage.getItem('crypto_chart_mode') || DEFAULT_CHART_MODE;

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function fetchMarketTickers() {
  try {
    const res = await fetchWithTimeout('https://data-api.binance.vision/api/v3/ticker/24hr', {}, 3500);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const map = {};
    for (const item of data) {
      if (SYMBOLS.includes(item.symbol)) {
        map[item.symbol] = item;
      }
    }
    return map;
  } catch (err) {
    console.warn('Ticker fetch fallback:', err.message);
    return {};
  }
}

async function fetchState() {
  try {
    const res = await fetchWithTimeout(`./state.json?_t=${Date.now()}`, { cache: 'no-store' }, 3000);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    // Try local node server api if on local host
    try {
      const apiRes = await fetchWithTimeout('/api/stats', {}, 2000);
      if (apiRes.ok) {
        const stats = await apiRes.json();
        return {
          account: stats.account,
          marketScan: stats.marketData,
          recentSignals: stats.recentSignals,
          lastUpdated: stats.lastUpdated
        };
      }
    } catch (_) {}
  }
  return null;
}

function renderDashboard(state, tickers, activeMode) {
  const { account, recentSignals = [], marketScan = {} } = state;
  const holdings = account.holdings || {};
  const useLiveModeCache = liveIndicatorCache._mode === activeMode;

  const marketScanResults = SYMBOLS.map(sym => {
    const liveInd = useLiveModeCache ? liveIndicatorCache[sym] : null;
    const saved = (marketScan[sym] && (!marketScan[sym].mode || marketScan[sym].mode === activeMode)) ? marketScan[sym] : {};
    const tick = tickers[sym] || {};

    const price = tick.lastPrice ? parseFloat(tick.lastPrice) : (liveInd?.price || saved.price || 0);
    const priceChangePercent = tick.priceChangePercent ? parseFloat(tick.priceChangePercent) : 0;

    const candleColor = liveInd?.currColor || saved.candleColor || (priceChangePercent >= 0 ? 'green' : 'red');
    const stopOrBrick = liveInd
      ? (liveInd.stopLevel != null ? liveInd.stopLevel : liveInd.brickSize)
      : (saved.stopLevel != null ? saved.stopLevel : (saved.brickSize || 0));
    const sig = liveInd?.signal || saved.signal || 'HOLD';
    const actionBadge = sig === 'BUY' ? 'LONG' : (sig === 'SELL' ? 'SHORT' : (candleColor === 'green' ? 'BULLISH' : 'BEARISH'));

    return {
      symbol: sym,
      price,
      priceChangePercent,
      candleColor,
      stopOrBrick,
      actionBadge
    };
  });

  // Portfolio & Holdings Valuation (Bi-directional Support: LONG & SHORT)
  let holdingsValue = 0;
  let totalMarginLocked = 0;
  const holdingsEntries = Object.entries(holdings);
  const activeHoldingsData = [];

  for (const [coin, data] of holdingsEntries) {
    const sym = `${coin}USDT`;
    const liveCoinData = marketScanResults.find(m => m.symbol === sym);
    const curPrice = liveCoinData && liveCoinData.price > 0 ? liveCoinData.price : (data.avgPrice || 0);
    const isLong = (data.side || 'LONG') === 'LONG';
    const initialMargin = data.initialMargin || (data.amount * data.avgPrice);
    totalMarginLocked += initialMargin;

    let unrealizedPnl = 0;
    let unrealizedPnlPct = '0.00';
    let currentVal = initialMargin;

    if (isLong) {
      currentVal = data.amount * curPrice;
      const cost = data.amount * data.avgPrice;
      unrealizedPnl = currentVal - cost;
      unrealizedPnlPct = cost > 0 ? ((unrealizedPnl / cost) * 100).toFixed(2) : '0.00';
    } else {
      // Short position calculation
      const entryVal = data.amount * data.avgPrice;
      const exitVal = data.amount * curPrice;
      unrealizedPnl = entryVal - exitVal;
      unrealizedPnlPct = entryVal > 0 ? ((unrealizedPnl / entryVal) * 100).toFixed(2) : '0.00';
      currentVal = Math.max(0, entryVal + unrealizedPnl);
    }

    holdingsValue += currentVal;
    activeHoldingsData.push({
      coin,
      side: data.side || 'LONG',
      amount: data.amount,
      avgPrice: data.avgPrice,
      val: currentVal,
      unrealizedPnl,
      unrealizedPnlPct
    });
  }

  const cashBal = account.balance ?? account.cashBalance ?? 0;
  const initialBal = account.initialBalance || 10000;
  const totalPortfolioValue = cashBal + holdingsValue;
  const netProfit = totalPortfolioValue - initialBal;
  const profitPercent = ((netProfit / initialBal) * 100).toFixed(2);
  const winRate = account.totalTrades > 0 ? (((account.winningTrades || 0) / account.totalTrades) * 100).toFixed(1) : '0.0';

  document.getElementById('val-portfolio').textContent = formatPrice(totalPortfolioValue);
  document.getElementById('val-cash').textContent = `Cash: ${formatPrice(cashBal)} USDT`;

  const profitEl = document.getElementById('val-profit');
  const profitSign = netProfit >= 0 ? '+' : '';
  profitEl.textContent = `${profitSign}${formatPrice(netProfit)}`;
  profitEl.className = `m-value ${netProfit >= 0 ? 'positive' : 'negative'}`;

  document.getElementById('val-profit-pct').textContent = `${profitSign}${profitPercent}%`;
  document.getElementById('val-winrate').textContent = `${winRate}%`;
  document.getElementById('val-trades').textContent = `${account.totalTrades || 0} closed trades`;
  document.getElementById('val-holdings-val').textContent = formatPrice(holdingsValue);
  document.getElementById('val-holdings-count').textContent = `${holdingsEntries.length} active position${holdingsEntries.length === 1 ? '' : 's'}`;

  // Active Holdings Table
  const holdingsTbody = document.getElementById('holdings-tbody');
  if (holdingsTbody) {
    if (activeHoldingsData.length > 0) {
      holdingsTbody.innerHTML = activeHoldingsData.map(h => {
        const isPnlPositive = h.unrealizedPnl >= 0;
        const pnlClass = isPnlPositive ? 'positive-change' : 'negative-change';
        const pnlSign = isPnlPositive ? '+' : '';
        const sideBadgeClass = h.side === 'LONG' ? 'signal-BUY' : 'signal-SELL';
        return `
          <tr>
            <td>
              <span class="coin-badge">${h.coin}</span>
              <span class="signal-tag ${sideBadgeClass}" style="margin-left: 6px; padding: 2px 6px; font-size: 0.7rem;">${h.side}</span>
            </td>
            <td>${h.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${h.coin}</td>
            <td class="price-text">${formatPrice(h.avgPrice)}</td>
            <td class="price-text">${formatPrice(h.val)}</td>
            <td class="${pnlClass}"><strong>${pnlSign}${formatPrice(h.unrealizedPnl)} (${pnlSign}${h.unrealizedPnlPct}%)</strong></td>
          </tr>
        `;
      }).join('');
    } else {
      holdingsTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted); padding: 16px;">No open positions currently held.</td></tr>`;
    }
  }

  // Market Scanner Table
  const tbody = document.getElementById('market-tbody');
  if (tbody && marketScanResults.length > 0) {
    tbody.innerHTML = marketScanResults.map(item => {
      const isUp = item.priceChangePercent >= 0;
      const changeClass = isUp ? 'positive-change' : 'negative-change';
      const changeSign = isUp ? '+' : '';
      const stateColor = item.candleColor === 'green' ? 'state-green' : 'state-red';
      const actionClass = item.actionBadge === 'LONG' || item.actionBadge === 'BULLISH' ? 'signal-BUY' : 'signal-SELL';

      return `
        <tr>
          <td><span class="coin-badge">${item.symbol}</span></td>
          <td class="price-text">${formatPrice(item.price)}</td>
          <td class="${changeClass}">${changeSign}${item.priceChangePercent.toFixed(2)}%</td>
          <td><span class="state-tag ${stateColor}">${item.candleColor}</span></td>
          <td class="price-text">${formatPrice(item.stopOrBrick)}</td>
          <td><span class="signal-tag ${actionClass}">${item.actionBadge}</span></td>
        </tr>
      `;
    }).join('');
  }

  // Recent Signals Feed
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
              <span class="feed-sub">${sig.reason || `${sig.time} · ${sig.mode || activeMode}`}</span>
            </div>
            <div style="text-align: right;">
              <span class="signal-tag ${badgeClass}">${actionText}</span>
              <div class="feed-sub" style="margin-top: 4px;">${formatPrice(sig.price)}</div>
            </div>
          </div>
        `;
      }).join('');
    } else {
      signalList.innerHTML = `<div class="empty-state">Waiting for color flip trigger...</div>`;
    }
  }

  // Execution Log
  const tradeList = document.getElementById('trade-list');
  const tradeHistory = account.tradeHistory || [];
  if (tradeList) {
    if (tradeHistory.length > 0) {
      tradeList.innerHTML = tradeHistory.map(tr => {
        const actionName = tr.action || tr.type || 'TRADE';
        const isClose = actionName.includes('CLOSE');
        const pnlVal = tr.pnl || 0;
        const pnlClass = pnlVal >= 0 ? 'positive-change' : 'negative-change';
        const pnlSign = pnlVal >= 0 ? '+' : '';
        const pnlText = isClose && tr.pnl !== undefined ? `<span class="${pnlClass}" style="display:block; font-size: 0.75rem;">${pnlSign}${formatPrice(pnlVal)} (${pnlSign}${tr.pnlPercent || 0}%)</span>` : '';
        const badgeClass = actionName.includes('LONG') ? 'signal-BUY' : 'signal-SELL';

        return `
          <div class="feed-item">
            <div class="feed-desc">
              <strong>${actionName} ${tr.symbol}</strong>
              <span class="feed-sub">${tr.amount || ''} @ ${formatPrice(tr.price || tr.exitPrice || 0)} · ${tr.time}</span>
              <span class="feed-sub" style="display:block; font-size: 0.7rem; color: var(--text-muted);">${tr.reason || ''}</span>
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
}

async function refreshLiveIndicators(state, activeMode) {
  const { account } = state;
  const timeframe = account.timeframe || '3m';

  const results = await Promise.allSettled(
    SYMBOLS.map(async sym => {
      const res = await fetchWithTimeout(
        `https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${timeframe}&limit=150`,
        {},
        3000
      );
      if (!res.ok) return null;
      const klines = await res.json();
      if (!Array.isArray(klines) || klines.length < 20) return null;

      const opens = klines.map(d => parseFloat(d[1]));
      const highs = klines.map(d => parseFloat(d[2]));
      const lows = klines.map(d => parseFloat(d[3]));
      const closes = klines.map(d => parseFloat(d[4]));

      const ind = processIndicator(opens, highs, lows, closes, {
        mode: activeMode,
        brickMultiplier: account.brickMultiplier || 0.5,
        atrLen: account.atrPeriod || 14,
        superTrendFactor: account.superTrendFactor || 2.0,
        superTrendAtrLen: account.superTrendAtrLen || 10
      });

      return {
        symbol: sym,
        price: closes[closes.length - 1],
        currColor: ind.currColor,
        brickSize: ind.brickSize,
        stopLevel: ind.stopLevel,
        atr: ind.atr,
        signal: ind.signal
      };
    })
  );

  const newCache = { _mode: activeMode };
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      newCache[r.value.symbol] = r.value;
    }
  }
  liveIndicatorCache = newCache;
}

function updateStrategyBanner(mode) {
  const banner = document.getElementById('strategy-banner');
  if (!banner) return;

  if (mode === 'Wickless SuperTrend') {
    banner.innerHTML = `
      <div class="strategy-badge">WICKLESS SUPERTREND + TP/SL SCALPER</div>
      <div class="strategy-desc">
        <strong>Bi-Directional Futures Scalper:</strong> Pure close-to-close momentum without wick fakeouts.
        Locks profit at <strong>+1.2% TP</strong>, protects capital with <strong>-1.0% SL</strong>, and profits from both bull & bear trends (Long & Short).
      </div>
    `;
  } else {
    banner.innerHTML = `
      <div class="strategy-badge">SADEEQ_TRADING RULES</div>
      <div class="strategy-desc">
        <strong>${mode} Strategy:</strong> Dynamic brick calculation. Fires <strong>LONG</strong> when candle turns <strong>Green</strong> and <strong>SHORT / CLOSE</strong> when candle turns <strong>Red</strong>.
      </div>
    `;
  }
}

async function mainLoop() {
  const modeSelector = document.getElementById('chart-mode-select');
  if (modeSelector && modeSelector.value !== currentMode) {
    modeSelector.value = currentMode;
  }
  updateStrategyBanner(currentMode);

  // 1. Fetch State
  const state = await fetchState() || {
    account: {
      initialBalance: 10000,
      balance: 10000,
      holdings: {},
      tradeHistory: [],
      totalTrades: 0,
      winningTrades: 0,
      chartMode: currentMode
    },
    marketScan: {},
    recentSignals: []
  };

  // 2. Fetch Tickers
  const tickers = await fetchMarketTickers();

  // 3. Immediate Fast Render
  renderDashboard(state, tickers, currentMode);

  // 4. Background Indicator Refresh
  refreshLiveIndicators(state, currentMode).then(() => {
    renderDashboard(state, tickers, currentMode);
  }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  const modeSelector = document.getElementById('chart-mode-select');
  if (modeSelector) {
    modeSelector.value = currentMode;
    modeSelector.addEventListener('change', (e) => {
      currentMode = e.target.value;
      localStorage.setItem('crypto_chart_mode', currentMode);
      updateStrategyBanner(currentMode);
      liveIndicatorCache = {};
      mainLoop();
    });
  }

  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (confirm('Reset paper trading balance to $10,000.00?')) {
        localStorage.clear();
        window.location.reload();
      }
    });
  }

  mainLoop();
  setInterval(mainLoop, 15000);
});
