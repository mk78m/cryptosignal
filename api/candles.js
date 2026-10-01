"use strict";
const { getCandles, TIMEFRAMES, validSymbol } = require("../lib/candle-provider");
const archive = require("../lib/archive-store");
module.exports = async function handler(req,res) {
  res.setHeader("Cache-Control","s-maxage=60, stale-while-revalidate=120");
  if (req.method !== "GET") { res.setHeader("Allow","GET"); return res.status(405).json({error:"فقط GET مجاز است."}); }
  const market = String(req.query.market || req.query.symbol || "").trim();
  const timeframe = String(req.query.timeframe || "1h");
  if (!validSymbol(market) || !TIMEFRAMES[timeframe]) return res.status(400).json({error:"market یا timeframe نامعتبر است؛ تایم‌فریم 1h یا 1d باشد."});
  try {
    const candles = await getCandles(market,timeframe);
    let archiveAvailable = false, archiveError = null;
    if (String(process.env.ARCHIVE_ON_FETCH || "").toLowerCase() === "true") {
      if (archive.config()) {
        try { await archive.save(market,timeframe,candles,"merge"); archiveAvailable = true; }
        catch (e) { archiveError = e.message; }
      } else archiveError = "ذخیره‌ساز آرشیو پیکربندی نشده است.";
    } else archiveAvailable = Boolean(archive.config());
    return res.status(200).json({market,symbol:market,timeframe,provider:(process.env.CANDLES_PROVIDER||"binance").toLowerCase(),fetchedAt:Date.now(),archiveAvailable,...(archiveError?{archiveError}:{}),candles});
  } catch (e) { return res.status(502).json({error:e.message}); }
};
