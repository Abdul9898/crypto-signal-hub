import { SYMBOLS, DEFAULT_CHART_MODE, processIndicator, formatPrice } from './indicators.js';

const MODE_DESCRIPTIONS = {
  'Wickless SuperTrend': {
    badge: 'WICKLESS SUPERTREND',
    html: '<strong>Pure Wickless SuperTrend Engine:</strong> Eliminates stop-hunt wick fakeouts using pure close-to-close bodies (<code>wOpen = close[1]</code>, <code>wClose = close</code>) with dynamic Wilder ATR(10) x 2.0 trailing bands. Fires <strong>LONG</strong> on fast upside breakouts and <strong>SHORT / CLOSE</strong> on trend breakdown.'
  },
  'Line Break Style': {
    badge: 'SADEEQ_TRADING RULES',
    html: '<strong>Line Break Style Strategy:</strong> Uses dynamic ATR(14) x 0.5 Line Break bricks. Fires <strong>LONG</strong> when candle turns <strong>Green</strong> and <strong>SHORT / CLOSE</strong> when candle turns <strong>Red</strong>.'
  },
  'Renko Style': {
    badge: 'RENKO STYLE',
    html: '<strong>ATR Renko Brick Strategy:</strong> Filters micro-noise into fixed ATR(14) x 0.5 blocks. Flips color only on full brick breakouts.'
  },
  'Heikin Ashi': {
    badge: 'HEIKIN ASHI',
    html: '<strong>Heikin Ashi Trend Smoothing:</strong> Averages OHLC bodies to highlight sustained momentum waves.'
  },
  'Wickless': {
    badge: 'WICKLESS BODIES',
    html: '<strong>Pure Wickless Bodies:</strong> Plots only close-to-close directional momentum with wicks completely removed.'
  },
  'Normal': {
    badge: 'NORMAL CANDLESTICK',
    html: '<strong>Standard Candlestick Color Flip:</strong> Direct OHLC candle direction flips.'
  }
};

let autoTradingEnabled = true;
let isLocalApi = false;
let isUpdating = false;
let lastKlineFetchAt = 0;
let liveIndicatorCache = {};
let userSelectedMode = localStorage.getItem('preferredChartMode') || null;

function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

function updateStrategyBanner(mode) {
  const info = MODE_DESCRIPTIONS[mode] || MODE_DESCRIPTIONS[DEFAULT_CHART_MODE];
  const labelEl = document.getElementById('scanner-mode-label');
  const badgeEl = document.getElementById('strategy-badge');
  const descEl = document.getElementById('strategy-desc');
  if (labelEl) labelEl.textContent = mode;
  if (badgeEl) badgeEl.textContent = info.badge;
  if (descEl) descEl.innerHTML = info.html;
}

async function loadStateData() {
  try {
    const stateRes = await fetchWithTimeout('./state.json?t=' + Date.now(), {}, 3000);
    if (stateRes.ok) {
      isLocalApi = false;
      return await stateRes.json();
    }
  } catch (e) {
    // Fallback below to local API if running via server.js
  }

  try {
    const [statsRes, marketRes] = await Promise.all([
      fetchWithTimeout('/api/stats', {}, 3000),
      fetchWithTimeout('/api/market', {}, 3000)
    ]);
    if (statsRes.ok && marketRes.ok) {
      isLocalApi = true;
      const stats = await statsRes.json();
      const market = await marketRes.json();
      const marketScan = {};
      for (const item of market.marketData || []) {
        marketScan[item.symbol] = {
          symbol: item.symbol,
          price: item.currentPrice,
          candleColor: (item.candleColor || 'green').toLowerCase(),
          brickSize: item.brickSize,
          stopLevel: item.stopLevel ?? null,
          signal: item.action === 'LONG' ? 'BUY' : (item.action === 'SHORT' ? 'SELL' : 'HOLD'),
          mode: stats.chartMode
        };
      }
      return {
        account: stats,
        recentSignals: market.recentSignals || [],
        marketScan
      };
    }
  } catch (e) {
    console.warn('State/API load failed:', e.message);
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

  // Portfolio & Holdings Valuation
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
      val,
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
        return `
          <tr>
            <td><span class="coin-badge">${h.coin}</span></td>
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
        const isClose = actionName.includes('CLOSE') || actionName.includes('SHORT') || tr.type === 'SELL';
        const pnlVal = tr.pnl || 0;
        const pnlClass = pnlVal >= 0 ? 'positive-change' : 'negative-change';
        const pnlSign = pnlVal >= 0 ? '+' : '';
        const pnlText = isClose && tr.pnl !== undefined ? `<span class="${pnlClass}" style="display:block; font-size: 0.75rem;">${pnlSign}${formatPrice(pnlVal)}</span>` : '';
        const badgeClass = actionName.includes('LONG') || actionName.includes('BUY') ? 'signal-BUY' : 'signal-SELL';

        return `
          <div class="feed-item">
            <div class="feed-desc">
              <strong>${actionName} ${tr.symbol}</strong>
              <span class="feed-sub">${tr.amount || ''} @ ${formatPrice(tr.price || tr.exitPrice || 0)} · ${tr.time}</span>
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
      if (!ind) return null;
      return { sym, price: closes[closes.length - 1], ...ind };
    })
  );

  const nextCache = { _mode: activeMode };
  let updatedCount = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      nextCache[r.value.sym] = r.value;
      updatedCount++;
    }
  }
  if (updatedCount > 0) {
    liveIndicatorCache = nextCache;
    lastKlineFetchAt = Date.now();
  }
  return updatedCount > 0;
}

async function updateDashboard(forceKlines = false) {
  if (isUpdating) return;
  isUpdating = true;

  try {
    const state = await loadStateData();
    if (!state || !state.account) return;

    const { account } = state;
    const activeMode = userSelectedMode || account.chartMode || DEFAULT_CHART_MODE;

    const modeSelect = document.getElementById('chart-mode-select');
    if (modeSelect && document.activeElement !== modeSelect) {
      modeSelect.value = activeMode;
    }
    updateStrategyBanner(activeMode);

    autoTradingEnabled = account.autoTradingEnabled ?? true;
    const botBtn = document.getElementById('toggle-bot-btn');
    if (botBtn) {
      botBtn.className = autoTradingEnabled ? 'bot-btn active' : 'bot-btn inactive';
      botBtn.innerHTML = autoTradingEnabled ? '<span class="dot"></span> BOT ACTIVE' : '<span class="dot"></span> BOT PAUSED';
    }

    // Immediate paint from state before waiting on external Binance API
    renderDashboard(state, {}, activeMode);

    // Fetch live 24h prices with strict timeout
    let tickers = {};
    try {
      const tickerRes = await fetchWithTimeout('https://data-api.binance.vision/api/v3/ticker/24hr', {}, 3500);
      if (tickerRes.ok) {
        const allTickers = await tickerRes.json();
        allTickers.forEach(t => {
          if (SYMBOLS.includes(t.symbol)) tickers[t.symbol] = t;
        });
      }
    } catch (e) {
      console.warn('Ticker fetch fallback:', e.message);
    }

    renderDashboard(state, tickers, activeMode);

    // Refresh full kline indicator calculations every 15s (avoids mobile throttling)
    if (forceKlines || Date.now() - lastKlineFetchAt > 15000 || liveIndicatorCache._mode !== activeMode) {
      const updated = await refreshLiveIndicators(state, activeMode);
      if (updated) {
        renderDashboard(state, tickers, activeMode);
      }
    }
  } catch (err) {
    console.error('Error rendering dashboard:', err);
  } finally {
    isUpdating = false;
  }
}

// Interactive UI Controls
document.getElementById('chart-mode-select')?.addEventListener('change', async (e) => {
  const chosenMode = e.target.value;
  userSelectedMode = chosenMode;
  localStorage.setItem('preferredChartMode', chosenMode);
  updateStrategyBanner(chosenMode);

  if (isLocalApi) {
    try {
      await fetch('/api/set-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chartMode: chosenMode })
      });
    } catch (err) {
      console.warn('Local mode update skipped:', err.message);
    }
  }
  updateDashboard(true);
});

document.getElementById('toggle-bot-btn')?.addEventListener('click', async () => {
  if (!isLocalApi) return;
  try {
    await fetch('/api/toggle-bot', { method: 'POST' });
    updateDashboard();
  } catch (err) {
    console.warn('Toggle bot error:', err.message);
  }
});

document.getElementById('reset-account-btn')?.addEventListener('click', async () => {
  if (!isLocalApi) {
    localStorage.removeItem('preferredChartMode');
    userSelectedMode = null;
    updateDashboard(true);
    return;
  }
  try {
    await fetch('/api/reset', { method: 'POST' });
    updateDashboard(true);
  } catch (err) {
    console.warn('Reset error:', err.message);
  }
});

// Initial run + poll every 4 seconds
updateDashboard(true);
setInterval(() => updateDashboard(false), 4000);
