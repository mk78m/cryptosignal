"use strict";
const store = require("../lib/archive-store");
const { getCandles, TIMEFRAMES, validSymbol } = require("../lib/candle-provider");
function value(req,key) { return (req.query && req.query[key]) ?? (req.body && req.body[key]); }
function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = String(req.headers.authorization || "");
  const bearer = header === `Bearer ${secret}`;
  const supplied = value(req,"secret");
  return bearer || (typeof supplied === "string" && supplied.length === secret.length && supplied === secret);
}
function validRequest(market,timeframe) { return validSymbol(market) && Boolean(TIMEFRAMES[timeframe]); }
module.exports = async function handler(req,res) {
  res.setHeader("Cache-Control","no-store");
  const cron = String(value(req,"cron") || "") === "1";
  if (!store.config()) return res.status(503).json({error:"آرشیو پیکربندی نشده است؛ ARCHIVE_STORAGE و تنظیمات Upstash/Vercel KV را بررسی کنید."});
  try {
    if (req.method === "GET" && cron) {
      if (!authorized(req)) return res.status(401).json({error:"cron نیازمند CRON_SECRET در Authorization: Bearer یا پارامتر secret است."});
      const market = String(value(req,"market") || "").trim();
      const timeframe = String(value(req,"timeframe") || "");
      if (!validRequest(market,timeframe)) return res.status(400).json({error:"market یا timeframe نامعتبر است."});
      const candles = await getCandles(market,timeframe);
      const result = await store.save(market,timeframe,candles,"merge");
      return res.status(200).json({market,timeframe,result});
    }
    if (req.method === "GET") {
      const market = String(value(req,"market") || value(req,"symbol") || "").trim();
      const timeframe = String(value(req,"timeframe") || "1h");
      if (!validRequest(market,timeframe)) return res.status(400).json({error:"market یا timeframe نامعتبر است."});
      const candles = await store.read(market,timeframe);
      return res.status(200).json({market,symbol:market,timeframe,count:candles.length,candles});
    }
    if (req.method === "POST") {
      if (!authorized(req)) return res.status(401).json({error:"ذخیره‌سازی POST نیازمند CRON_SECRET است."});
      const market = String(value(req,"market") || value(req,"symbol") || "").trim();
      const timeframe = String(value(req,"timeframe") || "");
      const candles = req.body && req.body.candles;
      const mode = (req.body && req.body.mode) || "merge";
      if (!validRequest(market,timeframe) || !Array.isArray(candles) || !["merge","replace"].includes(mode)) return res.status(400).json({error:"market، timeframe، candles یا mode نامعتبر است."});
      const result = await store.save(market,timeframe,candles,mode);
      return res.status(200).json({market,timeframe,result});
    }
    res.setHeader("Allow","GET, POST");
    return res.status(405).json({error:"فقط GET و POST پشتیبانی می‌شوند."});
  } catch (e) { return res.status(500).json({error:e.message}); }
};
