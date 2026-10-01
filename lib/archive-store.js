"use strict";
function config() {
  const mode = (process.env.ARCHIVE_STORAGE || "upstash-rest").toLowerCase();
  if (mode === "disabled") return null;
  let url, token;
  if (mode === "vercel-kv") {
    url = process.env.KV_REST_API_URL; token = process.env.KV_REST_API_TOKEN;
  } else if (mode === "upstash-rest" || mode === "auto") {
    url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  } else return null;
  if (!url || !token) return null;
  try { const parsed = new URL(url); if (parsed.protocol !== "https:") return null; }
  catch { return null; }
  return { base:url.replace(/\/+$/, ""), token };
}
function archiveKey(market, timeframe) { return `crypto-dashboard:v1:ohlcv:${timeframe}:${market}`; }
function unavailable() { return new Error("آرشیو در دسترس نیست؛ ARCHIVE_STORAGE و اعتبارنامه‌های KV/Upstash را تنظیم کنید."); }
async function command(parts) {
  const c = config(); if (!c) throw unavailable();
  const path = parts.map(x => encodeURIComponent(String(x))).join("/");
  const response = await fetch(`${c.base}/${path}`, { headers:{ Authorization:`Bearer ${c.token}`, Accept:"application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error("خطا در ارتباط با ذخیره‌ساز آرشیو.");
  return data.result;
}
async function pipeline(commands) {
  const c = config(); if (!c) throw unavailable();
  const response = await fetch(`${c.base}/pipeline`, { method:"POST", headers:{ Authorization:`Bearer ${c.token}`, "Content-Type":"application/json", Accept:"application/json" }, body:JSON.stringify(commands) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(result) || result.some(x => x && x.error)) throw new Error("ذخیرهٔ گروهی در آرشیو ناموفق بود.");
  return result;
}
function cleanCandles(candles) {
  const byTime = new Map();
  for (const x of candles) {
    const time = Number(x && (x.time ?? x.openTime));
    const c = { time, open:Number(x && x.open), high:Number(x && x.high), low:Number(x && x.low), close:Number(x && x.close), volume:Number(x && x.volume) };
    if (!Number.isFinite(time) || time <= 0 || ![c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) || c.open<=0 || c.high<=0 || c.low<=0 || c.close<=0 || c.volume<0 || c.high<Math.max(c.open,c.close,c.low) || c.low>Math.min(c.open,c.close,c.high)) continue;
    byTime.set(String(time),c);
  }
  return Array.from(byTime.values()).sort((a,b)=>a.time-b.time);
}
async function save(market, timeframe, candles, mode="merge") {
  const c = config(); if (!c) throw unavailable();
  const key = archiveKey(market,timeframe), rows = cleanCandles(candles);
  if (rows.length > 5000) throw new Error("حداکثر ۵۰۰۰ کندل در هر عملیات پذیرفته می‌شود.");
  if (mode === "replace") await command(["DEL",key]);
  else if (mode !== "merge") throw new Error("mode باید merge یا replace باشد.");
  for (let i=0; i<rows.length; i+=500) {
    const batch = rows.slice(i,i+500).map(x => ["HSET",key,String(x.time),JSON.stringify(x)]);
    await pipeline(batch);
  }
  const count = Number(await command(["HLEN",key]));
  return { saved:rows.length, count, mode };
}
async function read(market,timeframe) {
  const key = archiveKey(market,timeframe);
  const pairs = await command(["HGETALL",key]);
  const byTime = new Map();
  if (Array.isArray(pairs)) {
    for (let i=0; i+1<pairs.length; i+=2) {
      try { const c = JSON.parse(pairs[i+1]); if (c && Number.isFinite(Number(c.time))) byTime.set(String(c.time),c); } catch {}
    }
  }
  return Array.from(byTime.values()).sort((a,b)=>a.time-b.time);
}
module.exports = { config, save, read, cleanCandles };
