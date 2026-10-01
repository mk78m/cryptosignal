/* Ramzinex public market dashboard. All prices/candles come from the configured public API. */
'use strict';

const CONFIG = {
  RAMZINEX_MARKETS_ENDPOINT: 'https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs',
  REQUEST_TIMEOUT_MS: 12000,
  MAX_RETRIES: 1,
  RETRY_DELAY_MS: 500,
  CANDLE_RESOLUTION: '60',
  CANDLE_INTERVAL_MS: 60 * 60 * 1000,
  CANDLE_LOOKBACK_SECONDS: 240 * 60 * 60,
  MIN_CANDLES: 120,
  MAX_DATA_AGE_MS: 125 * 60 * 1000,
  CACHE_TTL_MS: 60 * 1000,
  REFRESH_INTERVAL_MS: 60 * 60 * 1000,
  CONCURRENCY: 4,
};

const state = {
  markets: [],
  selectedId: null,
  analyses: new Map(),
  candleCache: new Map(),
  busy: false,
  intervalMs: CONFIG.REFRESH_INTERVAL_MS,
  nextRefreshAt: null,
  lastMarketsFetch: null,
  refreshTimer: null,
  clockTimer: null,
};

const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

const number = (v) => {
  if (typeof v === 'string') v = v.replace(/,/g, '').trim();
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const first = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

function text(id, value) {
  const n = $(id);
  if (n) n.textContent = String(value ?? '');
}

function faNum(v, digits = 2) {
  const n = number(v);
  return n === null ? '—' : n.toLocaleString('fa-IR', { maximumFractionDigits: digits });
}

function timeLabel(ms) {
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('fa-IR') : '—';
}

function ageLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'نامعتبر';
  const m = Math.floor(ms / 60000);
  return m < 1 ? 'کمتر از ۱ دقیقه' : `${faNum(m, 0)} دقیقه`;
}

function signalLabel(s) {
  return ({ LONG: 'صعودی', SHORT: 'نزولی', NEUTRAL: 'خنثی' })[s] || 'خنثی';
}

function regimeLabel(s) {
  return ({
    INSUFFICIENT_DATA: 'داده ناکافی',
    TRENDING: 'رونددار',
    RANGING: 'نوسانی / خنثی',
    HIGH_VOLATILITY: 'نوسان بالا',
    LOW_VOLATILITY: 'نوسان پایین',
  })[s] || String(s || 'نامشخص').replace(/_/g, ' ');
}

function extractRows(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      for (const nested of keys) if (Array.isArray(value[nested])) return value[nested];
      for (const nested of ['items', 'pairs', 'markets', 'candles']) {
        if (Array.isArray(value[nested])) return value[nested];
      }
    }
  }
  return [];
}

function normalizeMarkets(payload) {
  return extractRows(payload, ['data', 'result', 'markets', 'pairs'])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const id = first(item.pair_id, item.id, item.symbol, item.pair, item.pair_name);
      if (id === undefined) return null;
      const rawName = String(first(item.name, item.pair_name, '') || '');
      const parts = rawName.split(/[\/_-]/);
      const baseValue = first(
        item.base_currency_symbol?.en,
        item.base_asset,
        item.base,
        item.base_currency,
        item.base_currency_symbol,
        parts[0]
      );
      const quoteValue = first(
        item.quote_currency_symbol?.en,
        item.quote_asset,
        item.quote,
        item.quote_currency,
        item.quote_currency_symbol,
        parts[1]
      );
      const base = String(baseValue ?? id);
      const quote = String(quoteValue ?? '');
      return {
        id: String(id),
        symbol: `${base}/${quote}`.replace(/\/$/, '').toUpperCase(),
        name: String(first(item.name_fa, item.name, `${base}/${quote}`)),
        price: number(first(item.last_price, item.price, item.buy, item.sell, item.buy_price, item.sell_price, item.financial?.last_price)),
        change24h: number(first(item.change24h, item.percent_change_24h, item.day_change_percent, item.financial?.day_change_percent)),
        volume: number(first(item.volume, item.base_volume, item.day_volume, item.financial?.day_volume)),
      };
    })
    .filter(Boolean)
    .filter((market, index, all) => all.findIndex((other) => other.id === market.id) === index);
}

function candlePayloadRows(payload) {
  return extractRows(payload, ['data', 'result', 'candles']);
}

function normalizeCandles(payload) {
  let rawRows = [];
  if (
    payload &&
    Array.isArray(payload.t) &&
    Array.isArray(payload.o) &&
    Array.isArray(payload.h) &&
    Array.isArray(payload.l) &&
    Array.isArray(payload.c) &&
    Array.isArray(payload.v)
  ) {
    rawRows = payload.t.map((t, i) => ({
      time: t,
      open: payload.o[i],
      high: payload.h[i],
      low: payload.l[i],
      close: payload.c[i],
      volume: payload.v[i],
    }));
  } else {
    rawRows = candlePayloadRows(payload).map((r) =>
      Array.isArray(r)
        ? { time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }
        : {
            time: first(r?.time, r?.timestamp, r?.t, r?.date),
            open: first(r?.open, r?.o),
            high: first(r?.high, r?.h),
            low: first(r?.low, r?.l),
            close: first(r?.close, r?.c),
            volume: first(r?.volume, r?.v),
          }
    );
  }

  const parsed = [];
  const maxAllowedTime = Date.now() + CONFIG.CANDLE_INTERVAL_MS;

  for (const r of rawRows) {
    let t = number(r.time);
    if (t !== null && t < 1e11) t *= 1000;

    const open = number(r.open);
    const high = number(r.high);
    const low = number(r.low);
    const close = number(r.close);
    const volume = number(r.volume);

    if (
      !Number.isFinite(t) ||
      t <= 0 ||
      t > maxAllowedTime ||
      [open, high, low, close, volume].some((v) => !Number.isFinite(v)) ||
      open <= 0 ||
      close <= 0 ||
      low <= 0 ||
      volume <= 0 ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close, high)
    ) {
      continue; // Skip invalid candle row
    }

    parsed.push({ time: t, open, high, low, close, volume });
  }

  if (!parsed.length) {
    return { candles: [], error: 'API کندلی برنگرداند یا داده نامعتبر است' };
  }

  // Sort ascending by normalized timestamp
  parsed.sort((a, b) => a.time - b.time);

  // Deduplicate timestamps (keep the last valid entry for duplicate timestamp)
  const dedupedMap = new Map();
  for (const c of parsed) {
    dedupedMap.set(c.time, c);
  }
  const candles = Array.from(dedupedMap.values());

  if (candles.some((c, i) => i > 0 && c.time - candles[i - 1].time > 3 * CONFIG.CANDLE_INTERVAL_MS)) {
    return { candles: [], error: 'فاصلهٔ زمانی کندل‌ها بیش از حد مجاز است' };
  }

  if (!candles.length) {
    return { candles: [], error: 'کندل معتبری یافت نشد' };
  }

  return { candles, error: null };
}

async function fetchJSON(url) {
  let lastError;
  for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      return await response.json();
    } catch (e) {
      lastError = e;
      if (attempt < CONFIG.MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, CONFIG.RETRY_DELAY_MS * (attempt + 1)));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('درخواست API ناموفق بود');
}

function neutralEntry(market, candles, error, fetchedAt = null) {
  const last = candles?.[candles.length - 1] || null;
  const latestCandleTime = last?.time ?? null;
  const dataAge = latestCandleTime ? Math.max(0, Date.now() - latestCandleTime) : null;

  return {
    symbol: market.symbol,
    marketId: market.id,
    candles: candles || [],
    lastCandleTime: latestCandleTime,
    latestCandleTime,
    dataAge,
    fetchedAt: fetchedAt || Date.now(),
    receivedAt: fetchedAt || Date.now(),
    score: 0,
    confidence: 0,
    regime: 'INSUFFICIENT_DATA',
    signal: 'NEUTRAL',
    risk: null,
    indicators: [],
    status: 'invalid',
    error: error || 'داده نامعتبر است',
    price: market.price,
    change24h: market.change24h,
  };
}

function buildEntry(market, candles, fetchedAt, dataError = null) {
  if (dataError || !candles || !candles.length) {
    return neutralEntry(market, candles, dataError, fetchedAt);
  }
  const last = candles[candles.length - 1];
  const latestCandleTime = last.time;
  const age = Math.max(0, Date.now() - latestCandleTime);

  if (candles.length < CONFIG.MIN_CANDLES) {
    return {
      ...neutralEntry(market, candles, `حداقل ${CONFIG.MIN_CANDLES} کندل معتبر لازم است؛ دریافت‌شده: ${candles.length}`, fetchedAt),
      dataAge: age,
      latestCandleTime,
      lastCandleTime: latestCandleTime,
    };
  }

  if (age > CONFIG.MAX_DATA_AGE_MS) {
    return {
      ...neutralEntry(market, candles, 'آخرین کندل قدیمی است؛ تحلیل غیرفعال شد', fetchedAt),
      status: 'stale',
      dataAge: age,
      latestCandleTime,
      lastCandleTime: latestCandleTime,
    };
  }

  const engine = typeof window !== 'undefined'
    ? window.AnalysisEngine
    : (typeof require === 'function' ? require('./analysis-engine.js') : null);
  if (!engine || typeof engine.analyze !== 'function') {
    return neutralEntry(market, candles, 'موتور تحلیل در دسترس نیست', fetchedAt);
  }

  let result;
  try {
    result = engine.analyze(candles, last.close);
  } catch (error) {
    return neutralEntry(market, candles, `خطای تحلیل: ${error.message}`, fetchedAt);
  }
  if (!result || !['LONG', 'SHORT', 'NEUTRAL'].includes(result.signal) || !Array.isArray(result.indicators)) {
    return neutralEntry(market, candles, 'خروجی موتور تحلیل نامعتبر است', fetchedAt);
  }
  const validRisk = result.risk &&
    Number.isFinite(result.risk.entry) && result.risk.entry > 0 &&
    Number.isFinite(result.risk.atr) && result.risk.atr > 0 &&
    ['stopLoss', 'target1', 'target2'].every((key) => Number.isFinite(result.risk[key]) && result.risk[key] > 0);
  return {
    symbol: market.symbol,
    marketId: market.id,
    candles,
    lastCandleTime: latestCandleTime,
    latestCandleTime,
    dataAge: age,
    fetchedAt: fetchedAt || Date.now(),
    receivedAt: fetchedAt || Date.now(),
    score: result.score,
    confidence: result.confidence,
    regime: result.marketRegime,
    signal: result.signal,
    risk: validRisk ? result.risk : null,
    indicators: result.indicators,
    warnings: result.warnings,
    status: 'valid',
    error: '',
    price: market.price ?? last.close,
    change24h: market.change24h,
  };
}

function makeCandleURL(market, timeframe = '1h') {
  const params = new URLSearchParams({ market: market.symbol, timeframe });
  return `/api/candles?${params}`;
}

async function withConcurrency(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function refreshOne(market, force = false) {
  const cached = state.candleCache.get(market.id);
  if (!force && cached && (Date.now() - cached.fetchedAt < CONFIG.CACHE_TTL_MS)) {
    state.analyses.set(market.id, buildEntry(market, cached.candles, cached.fetchedAt, cached.error));
    return;
  }

  try {
    const payload = await fetchJSON(makeCandleURL(market, '1h'));
    const normalized = normalizeCandles(payload.candles ? { candles: payload.candles } : payload);
    const fetchedAt = Date.now();

    if (normalized.error || !normalized.candles.length) {
      // Invalidate live status & mark symbol invalid/neutral without concatenation
      state.candleCache.set(market.id, { candles: [], error: normalized.error, fetchedAt });
      state.analyses.set(market.id, neutralEntry(market, [], normalized.error, fetchedAt));
    } else {
      // Full snapshot replacement of candles for this symbol (no concatenation)
      state.candleCache.set(market.id, { candles: normalized.candles, error: null, fetchedAt });
      state.analyses.set(market.id, buildEntry(market, normalized.candles, fetchedAt, null));
    }
  } catch (error) {
    const fetchedAt = Date.now();
    const previous = state.candleCache.get(market.id);
    const retainedCandles = previous?.candles || [];
    const stale = neutralEntry(market, retainedCandles, `خطای دریافت داده؛ آخرین snapshot زنده نیست: ${error.message}`, fetchedAt);
    stale.status = 'stale';
    state.analyses.set(market.id, stale);
    // Preserve the last successful full snapshot for context, but its analysis is neutral/stale.
  }

  if (state.selectedId === market.id) loadArchiveStatus(market);
  renderMarkets();
  if (state.selectedId === market.id) renderSelected();
}

async function loadArchiveStatus(market) {
  const node = $('archive-status');
  if (!node) return;
  node.textContent = 'در حال دریافت کندل روزانه و بررسی آرشیو…';
  try {
    const [daily, hourlyArchive, dailyArchive] = await Promise.all([
      fetchJSON(makeCandleURL(market, '1d')),
      fetchJSON(`/api/archive?market=${encodeURIComponent(market.symbol)}&timeframe=1h`),
      fetchJSON(`/api/archive?market=${encodeURIComponent(market.symbol)}&timeframe=1d`),
    ]);
    const dayCount = normalizeCandles({ candles: daily.candles || [] }).candles.length;
    node.textContent = `کندل روزانهٔ واقعی: ${faNum(dayCount, 0)} · آرشیو ۱ساعته: ${faNum(hourlyArchive.count, 0)} · آرشیو روزانه: ${faNum(dailyArchive.count, 0)}`;
  } catch (error) {
    node.textContent = `وضعیت آرشیو/کندل روزانه: ${error.message}`;
  }
}

function renderMarkets() {
  const grid = $('market-grid');
  if (!grid) return;
  grid.replaceChildren();
  grid.setAttribute('aria-busy', state.busy ? 'true' : 'false');

  if (!state.markets.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.busy ? 'در حال دریافت بازارها از API…' : 'بازاری از API دریافت نشد.';
    grid.append(empty);
    return;
  }

  for (const market of state.markets) {
    const entry = state.analyses.get(market.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `coin-card${state.selectedId === market.id ? ' selected' : ''}`;
    card.dataset.marketId = market.id;

    const head = document.createElement('div');
    head.className = 'coin-top';
    const symbol = document.createElement('strong');
    symbol.textContent = market.symbol;
    const name = document.createElement('span');
    name.textContent = market.name;
    const badge = document.createElement('span');
    badge.className = `signal-badge ${entry?.signal?.toLowerCase() || 'neutral'}`;
    badge.textContent = entry?.signal === 'NEUTRAL' || !entry ? 'خنثی · داده نامعتبر' : signalLabel(entry.signal);
    head.append(symbol, name, badge);

    const price = document.createElement('div');
    price.className = 'price';
    price.textContent = faNum(market.price, 8);

    const change = document.createElement('div');
    const changeN = number(market.change24h);
    change.className = `change ${changeN === null ? '' : changeN >= 0 ? 'positive' : 'negative'}`;
    change.textContent = changeN === null ? 'تغییر ۲۴ساعته: —' : `تغییر ۲۴ساعته: ${changeN > 0 ? '+' : ''}${faNum(changeN, 2)}٪`;

    const meta = document.createElement('div');
    meta.className = 'market-meta';
    const candle = document.createElement('span');
    candle.textContent = `آخرین کندل: ${entry?.latestCandleTime || entry?.lastCandleTime ? timeLabel(entry?.latestCandleTime || entry?.lastCandleTime) : '—'}`;
    const age = document.createElement('span');
    age.textContent = `سن داده: ${entry?.dataAge == null ? '—' : ageLabel(entry.dataAge)}`;
    const dataStatus = document.createElement('span');
    dataStatus.textContent = `وضعیت داده: ${entry?.status === 'valid' ? 'معتبر و به‌روز' : entry?.status === 'stale' ? 'قدیمی' : entry?.status === 'invalid' ? (entry.candles?.length ? 'ناکافی / نامعتبر' : 'خطا / بدون داده') : 'در حال دریافت'}`;
    meta.append(candle, age, dataStatus);

    card.append(head, price, change, meta);
    grid.append(card);
  }
  grid.setAttribute('aria-busy', state.busy ? 'true' : 'false');
}

function drawCandles(canvas, candles) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || !candles.length) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(280, canvas.clientWidth || 700);
  const height = 320;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const rows = candles.slice(-100);
  const pad = { left: 76, right: 15, top: 16, bottom: 30 };
  let min = Math.min(...rows.map((c) => c.low));
  let max = Math.max(...rows.map((c) => c.high));
  if (max === min) {
    max += Math.abs(max) * 0.01;
    min -= Math.abs(min) * 0.01;
  }
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const y = (v) => pad.top + ((max - v) / (max - min)) * plotH;

  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const yy = pad.top + (plotH * i) / 4;
    ctx.strokeStyle = '#2c3b56';
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();
    ctx.fillStyle = '#aab6ca';
    ctx.fillText((max - ((max - min) * i) / 4).toLocaleString('fa-IR', { maximumFractionDigits: 6 }), pad.left - 7, yy + 4);
  }

  const step = plotW / rows.length;
  const body = Math.max(2, Math.min(12, step * 0.65));
  rows.forEach((c, i) => {
    const x = pad.left + step * (i + 0.5);
    const color = c.close >= c.open ? '#50d6a0' : '#ff7185';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y(c.high));
    ctx.lineTo(x, y(c.low));
    ctx.stroke();
    const top = Math.min(y(c.open), y(c.close));
    ctx.fillRect(x - body / 2, top, body, Math.max(1, Math.abs(y(c.open) - y(c.close))));
  });

  ctx.fillStyle = '#aab6ca';
  ctx.textAlign = 'left';
  ctx.fillText(new Date(rows[0].time).toLocaleString('fa-IR'), pad.left, height - 7);
  ctx.textAlign = 'right';
  ctx.fillText(new Date(rows.at(-1).time).toLocaleString('fa-IR'), width - pad.right, height - 7);
}

function addField(parent, label, value) {
  const box = document.createElement('div');
  box.className = 'status-item';
  const k = document.createElement('span');
  k.textContent = label;
  const v = document.createElement('strong');
  v.textContent = String(value);
  box.append(k, v);
  parent.append(box);
}

function renderSelected() {
  const market = state.markets.find((m) => m.id === state.selectedId);
  const entry = market && state.analyses.get(market.id);
  text('selected-market-name', market ? `${market.name} (${market.symbol})` : 'بازاری برای تحلیل انتخاب نشده است');
  const canvas = $('chart-canvas');
  const empty = $('chart-empty');
  const hasCandles = Boolean(entry?.candles?.length);
  if (canvas) canvas.style.display = hasCandles ? 'block' : 'none';
  if (empty) {
    empty.style.display = hasCandles ? 'none' : 'grid';
    empty.textContent = entry?.error || 'در انتظار دریافت کندل واقعی از API…';
  }
  if (hasCandles) drawCandles(canvas, entry.candles);

  const status = $('technical-status');
  if (status) {
    status.replaceChildren();
    const box = document.createElement('div');
    box.className = `status-box signal-${(entry?.signal || 'NEUTRAL').toLowerCase()}`;
    addField(box, 'سیگنال', signalLabel(entry?.signal));
    addField(box, 'امتیاز', `${faNum(entry?.score, 2)} از ۱۰۰`);
    addField(box, 'اطمینان', `${faNum(entry?.confidence, 2)}٪`);
    addField(box, 'رژیم بازار', regimeLabel(entry?.regime));
    addField(box, 'آخرین کندل', (entry?.latestCandleTime || entry?.lastCandleTime) ? timeLabel(entry?.latestCandleTime || entry?.lastCandleTime) : '—');
    addField(box, 'سن داده', entry?.dataAge == null ? '—' : ageLabel(entry.dataAge));
    const note = document.createElement('p');
    note.className = 'analysis-note';
    note.textContent =
      entry?.status === 'valid'
        ? 'تحلیل مستقل این بازار بر اساس OHLCV واقعی است. نرخ‌های تاریخی صرفاً سنجش گذشته‌اند و تضمین یا مدل تطبیقیِ آموزش‌دیده نیستند.'
        : `داده نامعتبر؛ خروجی عمداً خنثی است. ${entry?.error || 'در انتظار داده.'}`;
    box.append(note);
    status.append(box);
  }

  const indicators = $('indicator-grid');
  if (indicators) {
    indicators.replaceChildren();
    const list = entry?.indicators || [];
    for (let i = 0; i < 30; i++) {
      const item = list[i];
      const card = document.createElement('article');
      card.className = `indicator-card${item ? '' : ' unavailable'}`;
      const title = document.createElement('strong');
      title.textContent = item?.name || `اندیکاتور ${i + 1}`;
      const value = document.createElement('span');
      value.textContent = item?.value == null ? '—' : faNum(item.value, 4);
      const sig = document.createElement('span');
      sig.textContent = signalLabel(item?.signal || 'NEUTRAL');
      const stats = document.createElement('small');
      stats.textContent = item
        ? `وزن ${faNum(item.adaptiveWeight, 2)} · نرخ موفقیت ${faNum((item.hitRate || 0) * 100, 1)}٪ · ${faNum(item.sampleCount, 0)} نمونه`
        : entry?.error || 'داده معتبر در دسترس نیست';
      card.append(title, value, sig, stats);
      indicators.append(card);
    }
  }

  const risk = $('risk-details');
  if (risk) {
    risk.replaceChildren();
    const r = entry?.risk || {};
    const riskAvailable = Boolean(entry?.status === 'valid' && Number.isFinite(r.entry) && r.entry > 0 && Number.isFinite(r.atr) && r.atr > 0);
    for (const [label, key] of [
      ['ورود', 'entry'],
      ['حد ضرر', 'stopLoss'],
      ['هدف اول', 'target1'],
      ['هدف دوم', 'target2'],
      ['نسبت سود به ریسک', 'rewardRisk'],
      ['افق زمانی', 'horizon'],
    ]) {
      addField(risk, label, !riskAvailable || r[key] == null ? '—' : typeof r[key] === 'number' ? faNum(r[key], 8) : r[key]);
    }
    const warning = document.createElement('p');
    warning.className = 'risk-warning';
    warning.textContent = !riskAvailable ? (entry?.error || 'قیمت و ATR معتبر برای برآورد ریسک در دسترس نیست.') : (entry?.warnings?.fa || 'برآورد بر پایه ATR(14)؛ تضمینی برای آینده نیست.');
    risk.append(warning);
  }
}

function setConnection(label, mode = 'idle') {
  const node = $('connection');
  if (node) node.dataset.state = mode;
  text('connection-status', label);
}

function renderSchedule() {
  text('next-refresh', state.nextRefreshAt ? timeLabel(state.nextRefreshAt) : '—');
}

async function refresh(force = true) {
  if (state.busy) return;
  state.busy = true;
  const button = $('refresh-button');
  if (button) button.disabled = true;
  setConnection('دریافت دادهٔ بازار…', 'loading');
  try {
    const marketsPayload = await fetchJSON(CONFIG.RAMZINEX_MARKETS_ENDPOINT);
    const freshMarkets = normalizeMarkets(marketsPayload);
    if (!freshMarkets.length) throw new Error('پاسخ API شامل بازار معتبر نیست');
    state.markets = freshMarkets;
    if (!state.selectedId || !state.markets.some((m) => m.id === state.selectedId)) {
      state.selectedId = state.markets[0].id;
    }
    state.lastMarketsFetch = Date.now();
    await withConcurrency(state.markets, CONFIG.CONCURRENCY, (market) => refreshOne(market, force));
    setConnection(`متصل · ${state.markets.length} بازار`, 'live');
    text('source-summary', `Ramzinex · ${faNum(state.markets.length, 0)} بازار · OHLCV از API سرور`);
    text('last-updated', timeLabel(state.lastMarketsFetch));
  } catch (error) {
    console.error('Market refresh failed:', error);
    setConnection('خطا در دریافت بازارها', 'error');
    text('source-summary', `خطای API: ${error.message}`);
    for (const market of state.markets) {
      const old = state.analyses.get(market.id);
      if (!old) continue;
      const stale = neutralEntry(market, old.candles || [], `خطای API؛ snapshot قبلی زنده نیست: ${error.message}`, old.fetchedAt);
      stale.status = 'stale';
      state.analyses.set(market.id, stale);
    }
  } finally {
    state.busy = false;
    if (button) button.disabled = false;
    renderMarkets();
    renderSelected();
    state.nextRefreshAt = Date.now() + state.intervalMs;
    renderSchedule();
  }
}

function setRefreshInterval(minutes) {
  const m = Number(minutes);
  if (![5, 15, 30, 60].includes(m)) return;
  state.intervalMs = m * 60000;
  CONFIG.REFRESH_INTERVAL_MS = state.intervalMs;
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.nextRefreshAt = Date.now() + state.intervalMs;
  state.refreshTimer = window.setInterval(() => {
    state.nextRefreshAt = Date.now() + state.intervalMs;
    refresh(false);
  }, state.intervalMs);
  renderSchedule();
}

function init() {
  $('market-grid')?.addEventListener('click', (event) => {
    const card = event.target.closest('[data-market-id]');
    if (!card) return;
    state.selectedId = card.dataset.marketId;
    renderMarkets();
    renderSelected();
  });
  $('refresh-button')?.addEventListener('click', () => refresh(true));
  $('refresh-interval')?.addEventListener('change', (event) => setRefreshInterval(event.target.value));
  window.addEventListener('resize', () => {
    const entry = state.analyses.get(state.selectedId);
    if (entry?.candles?.length) drawCandles($('chart-canvas'), entry.candles);
  });
  setRefreshInterval(60);
  refresh(true);
  state.clockTimer = window.setInterval(() => {
    renderSchedule();
    const now = Date.now();
    for (const [id, entry] of state.analyses) {
      const candleTime = entry.latestCandleTime || entry.lastCandleTime;
      if (candleTime) entry.dataAge = Math.max(0, now - candleTime);
      if (entry.status === 'valid' && entry.dataAge > CONFIG.MAX_DATA_AGE_MS) {
        const market = state.markets.find((m) => m.id === id);
        if (market) {
          state.analyses.set(id, {
            ...neutralEntry(market, entry.candles, 'آخرین کندل قدیمی است؛ تحلیل غیرفعال شد', entry.fetchedAt || entry.receivedAt),
            status: 'stale',
            latestCandleTime: candleTime,
            lastCandleTime: candleTime,
            dataAge: entry.dataAge,
          });
        }
      }
    }
    renderMarkets();
    if (state.selectedId) renderSelected();
  }, 30000);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CONFIG, normalizeMarkets, normalizeCandles, buildEntry, neutralEntry };
}
