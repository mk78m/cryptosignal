"use strict";

const TIMEFRAMES = Object.freeze({
  "1h": { interval: "1h", seconds: 3600, resolution: "60", limit: 1000 },
  "1d": { interval: "1d", seconds: 86400, resolution: "1D", limit: 1000 },
});

function validSymbol(value) {
  return typeof value === "string" && /^[A-Za-z0-9._/-]{1,40}$/.test(value.trim());
}
function resolveBinanceSymbol(input) {
  const raw = String(input || "").trim();
  let map = {};
  if (process.env.BINANCE_SYMBOL_MAP) {
    try { map = JSON.parse(process.env.BINANCE_SYMBOL_MAP); }
    catch { throw new Error("BINANCE_SYMBOL_MAP باید JSON object معتبر باشد."); }
    if (!map || Array.isArray(map) || typeof map !== "object") throw new Error("BINANCE_SYMBOL_MAP باید JSON object باشد.");
  }
  const builtIn = { "BTC/USDT":"BTCUSDT", "ETH/USDT":"ETHUSDT", "BTC-USDT":"BTCUSDT", "ETH-USDT":"ETHUSDT" };
  const mapped = map[raw] ?? map[raw.toUpperCase()] ?? builtIn[raw.toUpperCase()];
  const pair = mapped || raw.replace(/[\/_-]/g, "");
  if (!/^[A-Z0-9]{5,24}$/.test(String(pair).toUpperCase())) {
    throw new Error("نماد برای Binance نامعتبر است؛ BINANCE_SYMBOL_MAP را تنظیم کنید.");
  }
  return String(pair).toUpperCase();
}
function normalizeRows(payload) {
  let rows = [];
  if (Array.isArray(payload)) rows = payload;
  else if (payload && Array.isArray(payload.t) && ["o", "h", "l", "c", "v"].every(k => Array.isArray(payload[k]))) {
    rows = payload.t.map((t, i) => ({ time:t, open:payload.o[i], high:payload.h[i], low:payload.l[i], close:payload.c[i], volume:payload.v[i] }));
  } else if (payload && typeof payload === "object") {
    rows = payload.data || payload.result || payload.candles || payload.items || [];
  }
  if (!Array.isArray(rows)) throw new Error("قالب پاسخ provider معتبر نیست.");
  const byTime = new Map();
  for (const row of rows) {
    let time, open, high, low, close, volume;
    if (Array.isArray(row)) [time, open, high, low, close, volume] = row;
    else if (row && typeof row === "object") ({ time = row.timestamp ?? row.t, open = row.o, high = row.h, low = row.l, close = row.c, volume = row.v } = {
      time: row.time ?? row.timestamp ?? row.t, open: row.open ?? row.o, high: row.high ?? row.h,
      low: row.low ?? row.l, close: row.close ?? row.c, volume: row.volume ?? row.v,
    });
    time = Number(time); if (time > 0 && time < 1e11) time *= 1000;
    const c = { time, open:Number(open), high:Number(high), low:Number(low), close:Number(close), volume:Number(volume) };
    if (!Number.isFinite(c.time) || c.time <= 0 || ![c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) ||
        c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0 || c.volume < 0 ||
        c.high < Math.max(c.open,c.close,c.low) || c.low > Math.min(c.open,c.close,c.high)) continue;
    byTime.set(c.time, c);
  }
  return Array.from(byTime.values()).sort((a,b) => a.time-b.time);
}
async function requestJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { headers:{ Accept:"application/json" }, signal:controller.signal });
    if (!response.ok) throw new Error(`Provider پاسخ HTTP ${response.status} داد.`);
    return await response.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("مهلت درخواست provider تمام شد.");
    throw e;
  } finally { clearTimeout(timer); }
}
async function getBinanceCandles(symbol, timeframe) {
  const frame = TIMEFRAMES[timeframe];
  let base;
  try { base = new URL(process.env.BINANCE_API_BASE || "https://api.binance.com"); }
  catch { throw new Error("BINANCE_API_BASE معتبر نیست."); }
  if (base.protocol !== "https:") throw new Error("BINANCE_API_BASE باید HTTPS باشد.");
  const url = new URL("/api/v3/klines", base);
  url.search = new URLSearchParams({ symbol:resolveBinanceSymbol(symbol), interval:frame.interval, limit:String(frame.limit) });
  const payload = await requestJson(url);
  const candles = normalizeRows(payload);
  if (!candles.length) throw new Error("Binance کندل معتبر برنگرداند.");
  return candles;
}
async function getRamzinexCandles(symbol, timeframe) {
  let url;
  try { url = new URL(process.env.RAMZINEX_CANDLES_URL); }
  catch { throw new Error("RAMZINEX_CANDLES_URL معتبر نیست."); }
  if (url.protocol !== "https:") throw new Error("RAMZINEX_CANDLES_URL باید HTTPS باشد.");
  const frame = TIMEFRAMES[timeframe], now = Math.floor(Date.now()/1000);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("resolution", frame.resolution);
  url.searchParams.set("from", String(now - frame.limit * frame.seconds));
  url.searchParams.set("to", String(now));
  const payload = await requestJson(url);
  if (payload && payload.s && payload.s !== "ok") throw new Error("Ramzinex وضعیت ناموفق برگرداند.");
  const candles = normalizeRows(payload);
  if (!candles.length) throw new Error("Ramzinex کندل معتبر برنگرداند.");
  return candles;
}
async function getCandles(symbol, timeframe) {
  if (!validSymbol(symbol)) throw new Error("market نامعتبر است.");
  if (!TIMEFRAMES[timeframe]) throw new Error("timeframe باید 1h یا 1d باشد.");
  const provider = (process.env.CANDLES_PROVIDER || "binance").toLowerCase();
  if (provider === "ramzinex") {
    if (!process.env.RAMZINEX_CANDLES_URL) throw new Error("برای provider رمزینهکس باید RAMZINEX_CANDLES_URL تنظیم شود.");
    return getRamzinexCandles(symbol, timeframe);
  }
  if (provider !== "binance") throw new Error("CANDLES_PROVIDER فقط binance یا ramzinex است.");
  return getBinanceCandles(symbol, timeframe);
}
module.exports = { getCandles, TIMEFRAMES, validSymbol, resolveBinanceSymbol };
