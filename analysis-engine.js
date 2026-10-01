/**
 * Analysis Engine Module (Pure JavaScript - Browser & Node.js compatible)
 * Computes 30 technical indicators, assesses dynamic market regime, applies
 * look-ahead-free walk-forward historical hit-rate evaluation with regime weighting,
 * and generates structured risk parameters based on ATR.
 */
(function (global) {
  'use strict';

  // --- Math & Array Utilities ---
  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function sum(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s;
  }

  function smaSeries(values, period) {
    var res = new Array(values.length).fill(NaN);
    if (values.length < period) return res;
    var currentSum = 0;
    for (var i = 0; i < period; i++) currentSum += values[i];
    res[period - 1] = currentSum / period;
    for (var j = period; j < values.length; j++) {
      currentSum += values[j] - values[j - period];
      res[j] = currentSum / period;
    }
    return res;
  }

  function emaSeries(values, period) {
    var res = new Array(values.length).fill(NaN);
    if (values.length < period) return res;
    var k = 2 / (period + 1);
    var firstSma = 0;
    for (var i = 0; i < period; i++) firstSma += values[i];
    firstSma /= period;
    res[period - 1] = firstSma;
    for (var j = period; j < values.length; j++) {
      res[j] = (values[j] - res[j - 1]) * k + res[j - 1];
    }
    return res;
  }

  function wmaSeries(values, period) {
    var res = new Array(values.length).fill(NaN);
    if (values.length < period) return res;
    var denominator = (period * (period + 1)) / 2;
    for (var i = period - 1; i < values.length; i++) {
      var num = 0;
      for (var k = 0; k < period; k++) {
        num += values[i - (period - 1 - k)] * (k + 1);
      }
      res[i] = num / denominator;
    }
    return res;
  }

  function hmaSeries(values, period) {
    var res = new Array(values.length).fill(NaN);
    var halfPeriod = Math.max(1, Math.floor(period / 2));
    var sqrtPeriod = Math.max(1, Math.floor(Math.sqrt(period)));
    var wmaHalf = wmaSeries(values, halfPeriod);
    var wmaFull = wmaSeries(values, period);
    var diff = new Array(values.length).fill(NaN);
    for (var i = 0; i < values.length; i++) {
      if (!isNaN(wmaHalf[i]) && !isNaN(wmaFull[i])) {
        diff[i] = 2 * wmaHalf[i] - wmaFull[i];
      }
    }
    var validIdx = -1;
    for (var v = 0; v < diff.length; v++) {
      if (!isNaN(diff[v])) { validIdx = v; break; }
    }
    if (validIdx !== -1 && diff.length - validIdx >= sqrtPeriod) {
      var slice = diff.slice(validIdx);
      var wmaDiff = wmaSeries(slice, sqrtPeriod);
      for (var s = 0; s < slice.length; s++) {
        res[validIdx + s] = wmaDiff[s];
      }
    }
    return res;
  }

  function trueRangeSeries(candles) {
    var tr = new Array(candles.length).fill(NaN);
    if (candles.length === 0) return tr;
    tr[0] = candles[0].high - candles[0].low;
    for (var i = 1; i < candles.length; i++) {
      var hl = candles[i].high - candles[i].low;
      var hpc = Math.abs(candles[i].high - candles[i - 1].close);
      var lpc = Math.abs(candles[i].low - candles[i - 1].close);
      tr[i] = Math.max(hl, hpc, lpc);
    }
    return tr;
  }

  function atrSeries(candles, period) {
    var tr = trueRangeSeries(candles);
    var res = new Array(candles.length).fill(NaN);
    if (candles.length < period) return res;
    var initSum = 0;
    for (var i = 0; i < period; i++) initSum += tr[i];
    res[period - 1] = initSum / period;
    for (var j = period; j < candles.length; j++) {
      res[j] = (res[j - 1] * (period - 1) + tr[j]) / period;
    }
    return res;
  }

  function rsiSeries(closes, period) {
    var res = new Array(closes.length).fill(NaN);
    if (closes.length <= period) return res;
    var gains = [];
    var losses = [];
    for (var i = 1; i < closes.length; i++) {
      var d = closes[i] - closes[i - 1];
      gains.push(Math.max(0, d));
      losses.push(Math.max(0, -d));
    }
    var avgGain = 0;
    var avgLoss = 0;
    for (var k = 0; k < period; k++) {
      avgGain += gains[k];
      avgLoss += losses[k];
    }
    avgGain /= period;
    avgLoss /= period;
    var rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    res[period] = 100 - (100 / (1 + rs));
    for (var j = period + 1; j < closes.length; j++) {
      avgGain = (avgGain * (period - 1) + gains[j - 1]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[j - 1]) / period;
      rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      res[j] = 100 - (100 / (1 + rs));
    }
    return res;
  }

  // --- Precomputations on candles array ---
  function computeAllIndicators(candles) {
    var n = candles.length;
    var closes = candles.map(function (c) { return c.close; });
    var opens = candles.map(function (c) { return c.open; });
    var highs = candles.map(function (c) { return c.high; });
    var lows = candles.map(function (c) { return c.low; });
    var volumes = candles.map(function (c) { return c.volume; });

    // Moving Averages
    var sma20 = smaSeries(closes, 20);
    var sma50 = smaSeries(closes, 50);
    var sma200 = smaSeries(closes, 200);
    var ema12 = emaSeries(closes, 12);
    var ema26 = emaSeries(closes, 26);
    var ema50 = emaSeries(closes, 50);
    var wma20 = wmaSeries(closes, 20);
    var hma20 = hmaSeries(closes, 20);

    // MACD & PPO
    var macdLine = new Array(n).fill(NaN);
    var ppoLine = new Array(n).fill(NaN);
    for (var i = 0; i < n; i++) {
      if (!isNaN(ema12[i]) && !isNaN(ema26[i])) {
        macdLine[i] = ema12[i] - ema26[i];
        ppoLine[i] = ema26[i] !== 0 ? ((ema12[i] - ema26[i]) / ema26[i]) * 100 : 0;
      }
    }
    var macdSignal = emaSeries(macdLine.slice(25), 9);
    var fullMacdSignal = new Array(n).fill(NaN);
    for (var ms = 0; ms < macdSignal.length; ms++) {
      fullMacdSignal[25 + ms] = macdSignal[ms];
    }
    var ppoSignal = emaSeries(ppoLine.slice(25), 9);
    var fullPpoSignal = new Array(n).fill(NaN);
    for (var ps = 0; ps < ppoSignal.length; ps++) {
      fullPpoSignal[25 + ps] = ppoSignal[ps];
    }

    // RSI
    var rsi14 = rsiSeries(closes, 14);

    // ATR
    var atr14 = atrSeries(candles, 14);

    // Bollinger Bands (20, 2) & %B
    var bbUpper = new Array(n).fill(NaN);
    var bbLower = new Array(n).fill(NaN);
    var bbPctB = new Array(n).fill(NaN);
    for (var bi = 19; bi < n; bi++) {
      var mean = sma20[bi];
      var sumSq = 0;
      for (var bk = 0; bk < 20; bk++) {
        var diffB = closes[bi - bk] - mean;
        sumSq += diffB * diffB;
      }
      var std = Math.sqrt(sumSq / 20);
      bbUpper[bi] = mean + 2 * std;
      bbLower[bi] = mean - 2 * std;
      var width = bbUpper[bi] - bbLower[bi];
      bbPctB[bi] = width !== 0 ? (closes[bi] - bbLower[bi]) / width : 0.5;
    }

    // Stochastic Oscillator (14, 3)
    var stochK = new Array(n).fill(NaN);
    var stochD = new Array(n).fill(NaN);
    for (var si = 13; si < n; si++) {
      var minLow = Infinity;
      var maxHigh = -Infinity;
      for (var sk = 0; sk < 14; sk++) {
        if (lows[si - sk] < minLow) minLow = lows[si - sk];
        if (highs[si - sk] > maxHigh) maxHigh = highs[si - sk];
      }
      var denomS = maxHigh - minLow;
      stochK[si] = denomS !== 0 ? ((closes[si] - minLow) / denomS) * 100 : 50;
    }
    var stochDSlice = smaSeries(stochK.slice(13), 3);
    for (var sdi = 0; sdi < stochDSlice.length; sdi++) {
      stochD[13 + sdi] = stochDSlice[sdi];
    }

    // Williams %R (14)
    var willR = new Array(n).fill(NaN);
    for (var wi = 13; wi < n; wi++) {
      var maxH = -Infinity;
      var minL = Infinity;
      for (var wk = 0; wk < 14; wk++) {
        if (highs[wi - wk] > maxH) maxH = highs[wi - wk];
        if (lows[wi - wk] < minL) minL = lows[wi - wk];
      }
      var denW = maxH - minL;
      willR[wi] = denW !== 0 ? ((maxH - closes[wi]) / denW) * -100 : -50;
    }

    // CCI (20)
    var cci20 = new Array(n).fill(NaN);
    var tp = new Array(n);
    for (var ti = 0; ti < n; ti++) {
      tp[ti] = (highs[ti] + lows[ti] + closes[ti]) / 3;
    }
    var tpSma20 = smaSeries(tp, 20);
    for (var ci = 19; ci < n; ci++) {
      var meanTp = tpSma20[ci];
      var md = 0;
      for (var ck = 0; ck < 20; ck++) {
        md += Math.abs(tp[ci - ck] - meanTp);
      }
      md /= 20;
      cci20[ci] = md !== 0 ? (tp[ci] - meanTp) / (0.015 * md) : 0;
    }

    // ROC (12) & Momentum (10)
    var roc12 = new Array(n).fill(NaN);
    for (var ri = 12; ri < n; ri++) {
      roc12[ri] = closes[ri - 12] !== 0 ? ((closes[ri] - closes[ri - 12]) / closes[ri - 12]) * 100 : 0;
    }
    var mom10 = new Array(n).fill(NaN);
    for (var mi = 10; mi < n; mi++) {
      mom10[mi] = closes[mi] - closes[mi - 10];
    }

    // DMI / ADX / PlusDI / MinusDI (14)
    var plusDM = new Array(n).fill(0);
    var minusDM = new Array(n).fill(0);
    for (var di = 1; di < n; di++) {
      var upMove = highs[di] - highs[di - 1];
      var downMove = lows[di - 1] - lows[di];
      if (upMove > downMove && upMove > 0) plusDM[di] = upMove;
      if (downMove > upMove && downMove > 0) minusDM[di] = downMove;
    }
    var tr14 = atrSeries(candles, 14);
    // Smooth DM using Wilder's smoothing
    var smoothPlusDM = new Array(n).fill(NaN);
    var smoothMinusDM = new Array(n).fill(NaN);
    var pDMSum = 0;
    var mDMSum = 0;
    if (n >= 15) {
      for (var sdi1 = 1; sdi1 <= 14; sdi1++) {
        pDMSum += plusDM[sdi1];
        mDMSum += minusDM[sdi1];
      }
      smoothPlusDM[14] = pDMSum;
      smoothMinusDM[14] = mDMSum;
      for (var sdi2 = 15; sdi2 < n; sdi2++) {
        smoothPlusDM[sdi2] = smoothPlusDM[sdi2 - 1] - (smoothPlusDM[sdi2 - 1] / 14) + plusDM[sdi2];
        smoothMinusDM[sdi2] = smoothMinusDM[sdi2 - 1] - (smoothMinusDM[sdi2 - 1] / 14) + minusDM[sdi2];
      }
    }
    var plusDI = new Array(n).fill(NaN);
    var minusDI = new Array(n).fill(NaN);
    var dx = new Array(n).fill(NaN);
    for (var xi = 14; xi < n; xi++) {
      var trVal = tr14[xi] * 14;
      if (trVal > 0) {
        plusDI[xi] = (smoothPlusDM[xi] / trVal) * 100;
        minusDI[xi] = (smoothMinusDM[xi] / trVal) * 100;
        var diDiff = Math.abs(plusDI[xi] - minusDI[xi]);
        var diSum = plusDI[xi] + minusDI[xi];
        dx[xi] = diSum !== 0 ? (diDiff / diSum) * 100 : 0;
      }
    }
    var adx14 = new Array(n).fill(NaN);
    if (n >= 28) {
      var dxSum = 0;
      for (var dxi = 14; dxi < 28; dxi++) {
        dxSum += dx[dxi];
      }
      adx14[27] = dxSum / 14;
      for (var dxi2 = 28; dxi2 < n; dxi2++) {
        adx14[dxi2] = (adx14[dxi2 - 1] * 13 + dx[dxi2]) / 14;
      }
    }

    // OBV & OBV EMA
    var obv = new Array(n).fill(0);
    obv[0] = volumes[0] || 0;
    for (var oi = 1; oi < n; oi++) {
      if (closes[oi] > closes[oi - 1]) obv[oi] = obv[oi - 1] + volumes[oi];
      else if (closes[oi] < closes[oi - 1]) obv[oi] = obv[oi - 1] - volumes[oi];
      else obv[oi] = obv[oi - 1];
    }
    var obvEma20 = emaSeries(obv, 20);

    // MFI (14)
    var mfi14 = new Array(n).fill(NaN);
    var rawMoneyFlow = new Array(n);
    for (var mfiI = 0; mfiI < n; mfiI++) {
      rawMoneyFlow[mfiI] = tp[mfiI] * volumes[mfiI];
    }
    for (var mfiIdx = 14; mfiIdx < n; mfiIdx++) {
      var posFlow = 0;
      var negFlow = 0;
      for (var mfiK = 0; mfiK < 14; mfiK++) {
        var curr = mfiIdx - mfiK;
        var prev = curr - 1;
        if (tp[curr] > tp[prev]) posFlow += rawMoneyFlow[curr];
        else if (tp[curr] < tp[prev]) negFlow += rawMoneyFlow[curr];
      }
      if (negFlow === 0) mfi14[mfiIdx] = 100;
      else {
        var mr = posFlow / negFlow;
        mfi14[mfiIdx] = 100 - (100 / (1 + mr));
      }
    }

    // VWAP (Cumulative rolling window 30 or full window)
    var vwap30 = new Array(n).fill(NaN);
    for (var vi = 0; vi < n; vi++) {
      var startV = Math.max(0, vi - 29);
      var cumPv = 0;
      var cumV = 0;
      for (var vk = startV; vk <= vi; vk++) {
        cumPv += tp[vk] * volumes[vk];
        cumV += volumes[vk];
      }
      vwap30[vi] = cumV !== 0 ? cumPv / cumV : tp[vi];
    }

    // Aroon (25)
    var aroonUp = new Array(n).fill(NaN);
    var aroonDown = new Array(n).fill(NaN);
    for (var ai = 25; ai < n; ai++) {
      var maxHighIdx = 0;
      var minLowIdx = 0;
      var maxHVal = -Infinity;
      var minLVal = Infinity;
      for (var ak = 0; ak <= 25; ak++) {
        var idxA = ai - (25 - ak);
        if (highs[idxA] >= maxHVal) { maxHVal = highs[idxA]; maxHighIdx = ak; }
        if (lows[idxA] <= minLVal) { minLVal = lows[idxA]; minLowIdx = ak; }
      }
      aroonUp[ai] = (maxHighIdx / 25) * 100;
      aroonDown[ai] = (minLowIdx / 25) * 100;
    }

    // Donchian Channels (20)
    var donchianUpper = new Array(n).fill(NaN);
    var donchianLower = new Array(n).fill(NaN);
    var donchianMiddle = new Array(n).fill(NaN);
    for (var donI = 19; donI < n; donI++) {
      var maxD = -Infinity;
      var minD = Infinity;
      for (var donK = 0; donK < 20; donK++) {
        if (highs[donI - donK] > maxD) maxD = highs[donI - donK];
        if (lows[donI - donK] < minD) minD = lows[donI - donK];
      }
      donchianUpper[donI] = maxD;
      donchianLower[donI] = minD;
      donchianMiddle[donI] = (maxD + minD) / 2;
    }

    // Ichimoku Cloud (9, 26, 52)
    function periodHighLow(endIdx, length) {
      if (endIdx < length - 1) return { high: NaN, low: NaN };
      var maxV = -Infinity;
      var minV = Infinity;
      for (var ik = 0; ik < length; ik++) {
        if (highs[endIdx - ik] > maxV) maxV = highs[endIdx - ik];
        if (lows[endIdx - ik] < minV) minV = lows[endIdx - ik];
      }
      return { high: maxV, low: minV };
    }
    var tenkan = new Array(n).fill(NaN);
    var kijun = new Array(n).fill(NaN);
    var senkouA = new Array(n).fill(NaN);
    var senkouB = new Array(n).fill(NaN);
    for (var ichI = 0; ichI < n; ichI++) {
      var tHL = periodHighLow(ichI, 9);
      if (!isNaN(tHL.high)) tenkan[ichI] = (tHL.high + tHL.low) / 2;
      var kHL = periodHighLow(ichI, 26);
      if (!isNaN(kHL.high)) kijun[ichI] = (kHL.high + kHL.low) / 2;
      if (!isNaN(tenkan[ichI]) && !isNaN(kijun[ichI])) {
        senkouA[ichI] = (tenkan[ichI] + kijun[ichI]) / 2;
      }
      var bHL = periodHighLow(ichI, 52);
      if (!isNaN(bHL.high)) senkouB[ichI] = (bHL.high + bHL.low) / 2;
    }

    // Supertrend (10, 3)
    var supertrend = new Array(n).fill(NaN);
    var supertrendDir = new Array(n).fill(0); // 1 = long, -1 = short
    var atr10 = atrSeries(candles, 10);
    var upperBandST = new Array(n).fill(0);
    var lowerBandST = new Array(n).fill(0);
    for (var stI = 9; stI < n; stI++) {
      var mid = (highs[stI] + lows[stI]) / 2;
      var basicUpper = mid + (3 * atr10[stI]);
      var basicLower = mid - (3 * atr10[stI]);

      if (stI === 9) {
        upperBandST[stI] = basicUpper;
        lowerBandST[stI] = basicLower;
        supertrendDir[stI] = closes[stI] > basicUpper ? 1 : -1;
        supertrend[stI] = supertrendDir[stI] === 1 ? lowerBandST[stI] : upperBandST[stI];
      } else {
        lowerBandST[stI] = (basicLower > lowerBandST[stI - 1] || closes[stI - 1] < lowerBandST[stI - 1]) ? basicLower : lowerBandST[stI - 1];
        upperBandST[stI] = (basicUpper < upperBandST[stI - 1] || closes[stI - 1] > upperBandST[stI - 1]) ? basicUpper : upperBandST[stI - 1];

        var prevDir = supertrendDir[stI - 1];
        if (prevDir === 1 && closes[stI] < lowerBandST[stI]) {
          supertrendDir[stI] = -1;
        } else if (prevDir === -1 && closes[stI] > upperBandST[stI]) {
          supertrendDir[stI] = 1;
        } else {
          supertrendDir[stI] = prevDir;
        }
        supertrend[stI] = supertrendDir[stI] === 1 ? lowerBandST[stI] : upperBandST[stI];
      }
    }

    // Parabolic SAR (0.02, 0.2)
    var psar = new Array(n).fill(NaN);
    var psarDir = new Array(n).fill(0);
    if (n >= 2) {
      var isBull = closes[1] >= closes[0];
      var af = 0.02;
      var ep = isBull ? highs[1] : lows[1];
      var currentSar = isBull ? lows[0] : highs[0];
      psar[1] = currentSar;
      psarDir[1] = isBull ? 1 : -1;

      for (var sarI = 2; sarI < n; sarI++) {
        var nextSar = currentSar + af * (ep - currentSar);
        if (isBull) {
          if (lows[sarI] < nextSar) {
            isBull = false;
            currentSar = Math.max(ep, highs[sarI]);
            ep = lows[sarI];
            af = 0.02;
          } else {
            currentSar = Math.min(nextSar, lows[sarI - 1], lows[sarI - 2]);
            if (highs[sarI] > ep) {
              ep = highs[sarI];
              af = Math.min(0.2, af + 0.02);
            }
          }
        } else {
          if (highs[sarI] > nextSar) {
            isBull = true;
            currentSar = Math.min(ep, lows[sarI]);
            ep = highs[sarI];
            af = 0.02;
          } else {
            currentSar = Math.max(nextSar, highs[sarI - 1], highs[sarI - 2]);
            if (lows[sarI] < ep) {
              ep = lows[sarI];
              af = Math.min(0.2, af + 0.02);
            }
          }
        }
        psar[sarI] = currentSar;
        psarDir[sarI] = isBull ? 1 : -1;
      }
    }

    // Keltner Channels (EMA20 +/- 2*ATR10)
    var kcMid = emaSeries(closes, 20);
    var kcUpper = new Array(n).fill(NaN);
    var kcLower = new Array(n).fill(NaN);
    for (var kci = 19; kci < n; kci++) {
      if (!isNaN(kcMid[kci]) && !isNaN(atr10[kci])) {
        kcUpper[kci] = kcMid[kci] + 2 * atr10[kci];
        kcLower[kci] = kcMid[kci] - 2 * atr10[kci];
      }
    }

    // Chaikin Money Flow (CMF 20)
    var cmf20 = new Array(n).fill(NaN);
    var mfv = new Array(n).fill(0);
    for (var cmfi = 0; cmfi < n; cmfi++) {
      var hlcDiff = highs[cmfi] - lows[cmfi];
      var mfm = hlcDiff !== 0 ? ((closes[cmfi] - lows[cmfi]) - (highs[cmfi] - closes[cmfi])) / hlcDiff : 0;
      mfv[cmfi] = mfm * volumes[cmfi];
    }
    for (var cmfj = 19; cmfj < n; cmfj++) {
      var sumMfv = 0;
      var sumVol = 0;
      for (var cmfk = 0; cmfk < 20; cmfk++) {
        sumMfv += mfv[cmfj - cmfk];
        sumVol += volumes[cmfj - cmfk];
      }
      cmf20[cmfj] = sumVol !== 0 ? sumMfv / sumVol : 0;
    }

    // Classic Pivot Points (based on previous candle)
    var pivotP = new Array(n).fill(NaN);
    var pivotR1 = new Array(n).fill(NaN);
    var pivotS1 = new Array(n).fill(NaN);
    for (var pi = 1; pi < n; pi++) {
      var prevH = highs[pi - 1];
      var prevL = lows[pi - 1];
      var prevC = closes[pi - 1];
      var pVal = (prevH + prevL + prevC) / 3;
      pivotP[pi] = pVal;
      pivotR1[pi] = 2 * pVal - prevL;
      pivotS1[pi] = 2 * pVal - prevH;
    }

    return {
      closes: closes,
      opens: opens,
      highs: highs,
      lows: lows,
      volumes: volumes,
      sma20: sma20,
      sma50: sma50,
      sma200: sma200,
      ema12: ema12,
      ema26: ema26,
      ema50: ema50,
      wma20: wma20,
      hma20: hma20,
      macdLine: macdLine,
      macdSignal: fullMacdSignal,
      ppoLine: ppoLine,
      ppoSignal: fullPpoSignal,
      rsi14: rsi14,
      atr14: atr14,
      bbUpper: bbUpper,
      bbLower: bbLower,
      bbPctB: bbPctB,
      stochK: stochK,
      stochD: stochD,
      willR: willR,
      cci20: cci20,
      roc12: roc12,
      mom10: mom10,
      adx14: adx14,
      plusDI: plusDI,
      minusDI: minusDI,
      obv: obv,
      obvEma20: obvEma20,
      mfi14: mfi14,
      vwap30: vwap30,
      aroonUp: aroonUp,
      aroonDown: aroonDown,
      donchianUpper: donchianUpper,
      donchianLower: donchianLower,
      donchianMiddle: donchianMiddle,
      tenkan: tenkan,
      kijun: kijun,
      senkouA: senkouA,
      senkouB: senkouB,
      supertrend: supertrend,
      supertrendDir: supertrendDir,
      psar: psar,
      psarDir: psarDir,
      kcUpper: kcUpper,
      kcLower: kcLower,
      kcMid: kcMid,
      cmf20: cmf20,
      pivotP: pivotP,
      pivotR1: pivotR1,
      pivotS1: pivotS1
    };
  }

  // --- Market Regime Evaluation ---
  function getMarketRegime(data, idx) {
    var c = data.closes[idx];
    var sma50Val = data.sma50[idx];
    var sma200Val = data.sma200[idx];
    var adxVal = data.adx14[idx];

    var isTrending = !isNaN(adxVal) && adxVal >= 25;
    var isBull = !isNaN(sma50Val) && c >= sma50Val && (isNaN(sma200Val) || sma50Val >= sma200Val);
    var isBear = !isNaN(sma50Val) && c < sma50Val && (isNaN(sma200Val) || sma50Val < sma200Val);

    if (isTrending) {
      if (isBull) return 'BULLISH_TREND';
      if (isBear) return 'BEARISH_TREND';
      return 'TRENDING_NEUTRAL';
    } else {
      if (isBull) return 'RANGING_BULLISH';
      if (isBear) return 'RANGING_BEARISH';
      return 'RANGING';
    }
  }

  // --- Generate Exactly 30 Indicators at a given index ---
  function evaluateIndicatorsAtIndex(data, idx, effectivePrice) {
    var c = effectivePrice !== undefined ? effectivePrice : data.closes[idx];
    var ind = [];

    // Helper for signal formatting
    function s(num) {
      return num > 0 ? 'LONG' : (num < 0 ? 'SHORT' : 'NEUTRAL');
    }

    // 1. SMA (20)
    var sma20Val = data.sma20[idx];
    var sigSMA = isNaN(sma20Val) ? 0 : (c > sma20Val ? 1 : (c < sma20Val ? -1 : 0));
    ind.push({
      name: 'SMA (20)',
      value: !isNaN(sma20Val) ? Number(sma20Val.toFixed(4)) : null,
      signal: s(sigSMA),
      baseWeight: 1.0,
      explanation: 'Simple Moving Average (20): Price ' + (c >= sma20Val ? 'above' : 'below') + ' baseline'
    });

    // 2. Pivot Points (classic, prior candle)
    var pivotVal = data.pivotP[idx];
    var sigPivot = isNaN(pivotVal) ? 0 : (c > pivotVal ? 1 : (c < pivotVal ? -1 : 0));
    ind.push({
      name: 'Pivot Points',
      value: !isNaN(pivotVal) ? Number(pivotVal.toFixed(4)) : null,
      signal: s(sigPivot),
      baseWeight: 1.2,
      explanation: 'Classic Pivot Point calculated from the previous candle high, low, and close'
    });

    // 3. SMA (200)
    var sma200Val = data.sma200[idx];
    var sigSMA200 = isNaN(sma200Val) ? 0 : (c > sma200Val ? 1 : (c < sma200Val ? -1 : 0));
    ind.push({
      name: 'SMA (200)',
      value: !isNaN(sma200Val) ? Number(sma200Val.toFixed(4)) : null,
      signal: s(sigSMA200),
      baseWeight: 1.5,
      explanation: 'Macro Trend SMA (200): Bull/Bear institutional baseline'
    });

    // 4. EMA (12)
    var ema12Val = data.ema12[idx];
    var sigEMA12 = isNaN(ema12Val) ? 0 : (c > ema12Val ? 1 : (c < ema12Val ? -1 : 0));
    ind.push({
      name: 'EMA (12)',
      value: !isNaN(ema12Val) ? Number(ema12Val.toFixed(4)) : null,
      signal: s(sigEMA12),
      baseWeight: 1.0,
      explanation: 'Fast Exponential Moving Average (12): Short-term momentum tracking'
    });

    // 5. EMA (26)
    var ema26Val = data.ema26[idx];
    var sigEMA26 = isNaN(ema26Val) ? 0 : (c > ema26Val ? 1 : (c < ema26Val ? -1 : 0));
    ind.push({
      name: 'EMA (26)',
      value: !isNaN(ema26Val) ? Number(ema26Val.toFixed(4)) : null,
      signal: s(sigEMA26),
      baseWeight: 1.1,
      explanation: 'Medium Exponential Moving Average (26): Intermediate momentum base'
    });

    // 6. EMA (50)
    var ema50Val = data.ema50[idx];
    var sigEMA50 = isNaN(ema50Val) ? 0 : (c > ema50Val ? 1 : (c < ema50Val ? -1 : 0));
    ind.push({
      name: 'EMA (50)',
      value: !isNaN(ema50Val) ? Number(ema50Val.toFixed(4)) : null,
      signal: s(sigEMA50),
      baseWeight: 1.3,
      explanation: 'Dynamic Trend EMA (50): Dynamic support/resistance barrier'
    });

    // 7. WMA (20)
    var wma20Val = data.wma20[idx];
    var sigWMA = isNaN(wma20Val) ? 0 : (c > wma20Val ? 1 : (c < wma20Val ? -1 : 0));
    ind.push({
      name: 'WMA (20)',
      value: !isNaN(wma20Val) ? Number(wma20Val.toFixed(4)) : null,
      signal: s(sigWMA),
      baseWeight: 1.0,
      explanation: 'Weighted Moving Average (20): Linearly weighted price reactivity'
    });

    // 8. HMA (20)
    var hma20Val = data.hma20[idx];
    var sigHMA = 0;
    if (!isNaN(hma20Val) && idx > 0 && !isNaN(data.hma20[idx - 1])) {
      sigHMA = hma20Val > data.hma20[idx - 1] ? 1 : (hma20Val < data.hma20[idx - 1] ? -1 : 0);
    }
    ind.push({
      name: 'HMA (20)',
      value: !isNaN(hma20Val) ? Number(hma20Val.toFixed(4)) : null,
      signal: s(sigHMA),
      baseWeight: 1.2,
      explanation: 'Hull Moving Average (20): Zero-lag responsive curve slope'
    });

    // 9. RSI (14)
    var rsiVal = data.rsi14[idx];
    var sigRSI = 0;
    if (!isNaN(rsiVal)) {
      if (rsiVal < 30) sigRSI = 1;
      else if (rsiVal > 70) sigRSI = -1;
      else if (rsiVal > 50) sigRSI = 0.5;
      else sigRSI = -0.5;
    }
    ind.push({
      name: 'RSI (14)',
      value: !isNaN(rsiVal) ? Number(rsiVal.toFixed(2)) : null,
      signal: sigRSI >= 0.5 ? 'LONG' : (sigRSI <= -0.5 ? 'SHORT' : 'NEUTRAL'),
      baseWeight: 1.4,
      explanation: 'Relative Strength Index (14): Overbought (>70) / Oversold (<30) & centerline bias'
    });

    // 10. ATR (14)
    var atrVal = data.atr14[idx];
    var sigATR = 0;
    if (!isNaN(atrVal) && idx > 0 && !isNaN(data.atr14[idx - 1])) {
      sigATR = atrVal > data.atr14[idx - 1] ? (c > data.closes[idx - 1] ? 1 : -1) : 0;
    }
    ind.push({
      name: 'ATR (14)',
      value: !isNaN(atrVal) ? Number(atrVal.toFixed(4)) : null,
      signal: s(sigATR),
      baseWeight: 1.1,
      explanation: 'Average True Range (14): Volatility expansion directional momentum'
    });

    // 11. MACD
    var macdVal = data.macdLine[idx];
    var macdSigVal = data.macdSignal[idx];
    var sigMACD = 0;
    if (!isNaN(macdVal) && !isNaN(macdSigVal)) {
      sigMACD = macdVal > macdSigVal ? 1 : (macdVal < macdSigVal ? -1 : 0);
    }
    ind.push({
      name: 'MACD (12, 26, 9)',
      value: !isNaN(macdVal) ? Number(macdVal.toFixed(4)) : null,
      signal: s(sigMACD),
      baseWeight: 1.4,
      explanation: 'Moving Average Convergence Divergence: Signal line crossover'
    });

    // 12. PPO
    var ppoVal = data.ppoLine[idx];
    var ppoSigVal = data.ppoSignal[idx];
    var sigPPO = 0;
    if (!isNaN(ppoVal) && !isNaN(ppoSigVal)) {
      sigPPO = ppoVal > ppoSigVal ? 1 : (ppoVal < ppoSigVal ? -1 : 0);
    }
    ind.push({
      name: 'PPO (12, 26, 9)',
      value: !isNaN(ppoVal) ? Number(ppoVal.toFixed(2)) : null,
      signal: s(sigPPO),
      baseWeight: 1.1,
      explanation: 'Percentage Price Oscillator: Percentage-scaled MACD crossover'
    });

    // 13. Bollinger Bands (20, 2)
    var bbU = data.bbUpper[idx];
    var bbL = data.bbLower[idx];
    var pctB = data.bbPctB[idx];
    var sigBB = 0;
    if (!isNaN(bbU) && !isNaN(bbL)) {
      if (c <= bbL) sigBB = 1;
      else if (c >= bbU) sigBB = -1;
      else sigBB = c > (bbU + bbL) / 2 ? 0.5 : -0.5;
    }
    ind.push({
      name: 'Bollinger Bands (20, 2)',
      value: !isNaN(pctB) ? Number(pctB.toFixed(3)) : null,
      signal: sigBB >= 0.5 ? 'LONG' : (sigBB <= -0.5 ? 'SHORT' : 'NEUTRAL'),
      baseWeight: 1.3,
      explanation: 'Bollinger %B & Bands: Mean-reversion envelope & volatility envelope'
    });

    // 14. Stochastic %K (14, 3)
    var stochKVal = data.stochK[idx];
    var stochDVal = data.stochD[idx];
    var sigStoch = 0;
    if (!isNaN(stochKVal) && !isNaN(stochDVal)) {
      if (stochKVal < 20 && stochKVal > stochDVal) sigStoch = 1;
      else if (stochKVal > 80 && stochKVal < stochDVal) sigStoch = -1;
      else sigStoch = stochKVal > stochDVal ? 0.5 : -0.5;
    }
    ind.push({
      name: 'Stochastic Oscillator (14, 3)',
      value: !isNaN(stochKVal) ? Number(stochKVal.toFixed(2)) : null,
      signal: sigStoch >= 0.5 ? 'LONG' : (sigStoch <= -0.5 ? 'SHORT' : 'NEUTRAL'),
      baseWeight: 1.2,
      explanation: 'Stochastic %K/%D crossover in extreme zones'
    });

    // 15. Williams %R (14)
    var willRVal = data.willR[idx];
    var sigWillR = 0;
    if (!isNaN(willRVal)) {
      if (willRVal < -80) sigWillR = 1;
      else if (willRVal > -20) sigWillR = -1;
      else sigWillR = willRVal > -50 ? 0.5 : -0.5;
    }
    ind.push({
      name: 'Williams %R (14)',
      value: !isNaN(willRVal) ? Number(willRVal.toFixed(2)) : null,
      signal: sigWillR >= 0.5 ? 'LONG' : (sigWillR <= -0.5 ? 'SHORT' : 'NEUTRAL'),
      baseWeight: 1.0,
      explanation: 'Williams %R: Momentum range exhaustion gauge'
    });

    // 16. CCI (20)
    var cciVal = data.cci20[idx];
    var sigCCI = 0;
    if (!isNaN(cciVal)) {
      if (cciVal < -100) sigCCI = 1;
      else if (cciVal > 100) sigCCI = -1;
      else sigCCI = cciVal > 0 ? 0.5 : -0.5;
    }
    ind.push({
      name: 'CCI (20)',
      value: !isNaN(cciVal) ? Number(cciVal.toFixed(2)) : null,
      signal: sigCCI >= 0.5 ? 'LONG' : (sigCCI <= -0.5 ? 'SHORT' : 'NEUTRAL'),
      baseWeight: 1.1,
      explanation: 'Commodity Channel Index: Cyclical deviation from statistical mean'
    });

    // 17. ROC (12)
    var rocVal = data.roc12[idx];
    var sigROC = isNaN(rocVal) ? 0 : (rocVal > 0 ? 1 : (rocVal < 0 ? -1 : 0));
    ind.push({
      name: 'ROC (12)',
      value: !isNaN(rocVal) ? Number(rocVal.toFixed(2)) : null,
      signal: s(sigROC),
      baseWeight: 1.0,
      explanation: 'Rate of Change (12): Relative velocity of price displacement'
    });

    // 18. Momentum (10)
    var momVal = data.mom10[idx];
    var sigMOM = isNaN(momVal) ? 0 : (momVal > 0 ? 1 : (momVal < 0 ? -1 : 0));
    ind.push({
      name: 'Momentum (10)',
      value: !isNaN(momVal) ? Number(momVal.toFixed(4)) : null,
      signal: s(sigMOM),
      baseWeight: 1.0,
      explanation: 'Absolute Momentum (10): Discrete price distance from 10 bars ago'
    });

    // 19. ADX (14)
    var adxVal = data.adx14[idx];
    var pDI = data.plusDI[idx];
    var mDI = data.minusDI[idx];
    var sigADX = 0;
    if (!isNaN(adxVal) && !isNaN(pDI) && !isNaN(mDI)) {
      if (adxVal >= 20) {
        sigADX = pDI > mDI ? 1 : -1;
      }
    }
    ind.push({
      name: 'ADX (14)',
      value: !isNaN(adxVal) ? Number(adxVal.toFixed(2)) : null,
      signal: s(sigADX),
      baseWeight: 1.4,
      explanation: 'Average Directional Index: Trend strength filter with directional bias'
    });

    // 20. Plus/Minus DI (14)
    var sigDI = 0;
    if (!isNaN(pDI) && !isNaN(mDI)) {
      sigDI = pDI > mDI ? 1 : (pDI < mDI ? -1 : 0);
    }
    ind.push({
      name: 'DI (+DI / -DI)',
      value: !isNaN(pDI) && !isNaN(mDI) ? Number((pDI - mDI).toFixed(2)) : null,
      signal: s(sigDI),
      baseWeight: 1.1,
      explanation: 'Directional Indicators spread (+DI minus -DI)'
    });

    // 21. OBV
    var obvVal = data.obv[idx];
    var obvEmaVal = data.obvEma20[idx];
    var sigOBV = 0;
    if (!isNaN(obvVal) && !isNaN(obvEmaVal)) {
      sigOBV = obvVal > obvEmaVal ? 1 : (obvVal < obvEmaVal ? -1 : 0);
    }
    ind.push({
      name: 'OBV',
      value: !isNaN(obvVal) ? Number(obvVal.toFixed(0)) : null,
      signal: s(sigOBV),
      baseWeight: 1.2,
      explanation: 'On-Balance Volume: Cumulative volume trend vs 20 EMA'
    });

    // 22. MFI (14)
    var mfiVal = data.mfi14[idx];
    var sigMFI = 0;
    if (!isNaN(mfiVal)) {
      if (mfiVal < 20) sigMFI = 1;
      else if (mfiVal > 80) sigMFI = -1;
      else sigMFI = mfiVal > 50 ? 0.5 : -0.5;
    }
    ind.push({
      name: 'MFI (14)',
      value: !isNaN(mfiVal) ? Number(mfiVal.toFixed(2)) : null,
      signal: sigMFI >= 0.5 ? 'LONG' : (sigMFI <= -0.5 ? 'SHORT' : 'NEUTRAL'),
      baseWeight: 1.2,
      explanation: 'Money Flow Index: Volume-weighted RSI counterpart'
    });

    // 23. VWAP (30)
    var vwapVal = data.vwap30[idx];
    var sigVWAP = isNaN(vwapVal) ? 0 : (c > vwapVal ? 1 : (c < vwapVal ? -1 : 0));
    ind.push({
      name: 'VWAP',
      value: !isNaN(vwapVal) ? Number(vwapVal.toFixed(4)) : null,
      signal: s(sigVWAP),
      baseWeight: 1.3,
      explanation: 'Volume-Weighted Average Price benchmark comparison'
    });

    // 24. Aroon (25)
    var arUp = data.aroonUp[idx];
    var arDown = data.aroonDown[idx];
    var sigAroon = 0;
    if (!isNaN(arUp) && !isNaN(arDown)) {
      if (arUp > 70 && arDown < 30) sigAroon = 1;
      else if (arDown > 70 && arUp < 30) sigAroon = -1;
      else sigAroon = arUp > arDown ? 0.5 : -0.5;
    }
    ind.push({
      name: 'Aroon (25)',
      value: !isNaN(arUp) && !isNaN(arDown) ? Number((arUp - arDown).toFixed(2)) : null,
      signal: sigAroon >= 0.5 ? 'LONG' : (sigAroon <= -0.5 ? 'SHORT' : 'NEUTRAL'),
      baseWeight: 1.1,
      explanation: 'Aroon Oscillator: Time elapsed since 25-period extreme highs/lows'
    });

    // 25. Donchian Channels (20)
    var donMid = data.donchianMiddle[idx];
    var sigDonchian = isNaN(donMid) ? 0 : (c > donMid ? 1 : (c < donMid ? -1 : 0));
    ind.push({
      name: 'Donchian Channels (20)',
      value: !isNaN(donMid) ? Number(donMid.toFixed(4)) : null,
      signal: s(sigDonchian),
      baseWeight: 1.1,
      explanation: 'Donchian Median: 20-bar price range center breakout bias'
    });

    // 26. Ichimoku Cloud
    var tk = data.tenkan[idx];
    var kj = data.kijun[idx];
    var skA = data.senkouA[idx];
    var skB = data.senkouB[idx];
    var sigIchi = 0;
    if (!isNaN(tk) && !isNaN(kj)) {
      var cloudTop = (!isNaN(skA) && !isNaN(skB)) ? Math.max(skA, skB) : kj;
      var cloudBottom = (!isNaN(skA) && !isNaN(skB)) ? Math.min(skA, skB) : kj;
      if (c > cloudTop && tk >= kj) sigIchi = 1;
      else if (c < cloudBottom && tk <= kj) sigIchi = -1;
      else sigIchi = tk > kj ? 0.5 : -0.5;
    }
    ind.push({
      name: 'Ichimoku Cloud',
      value: !isNaN(kj) ? Number(kj.toFixed(4)) : null,
      signal: sigIchi >= 0.5 ? 'LONG' : (sigIchi <= -0.5 ? 'SHORT' : 'NEUTRAL'),
      baseWeight: 1.4,
      explanation: 'Tenkan/Kijun relationship and Senkou Cloud position'
    });

    // 27. Supertrend (10, 3)
    var stVal = data.supertrend[idx];
    var stDir = data.supertrendDir[idx];
    var sigST = stDir === 1 ? 1 : (stDir === -1 ? -1 : 0);
    ind.push({
      name: 'Supertrend (10, 3)',
      value: !isNaN(stVal) ? Number(stVal.toFixed(4)) : null,
      signal: s(sigST),
      baseWeight: 1.5,
      explanation: 'Supertrend: Volatility-adjusted trailing stop-and-reverse band'
    });

    // 28. Parabolic SAR
    var psarVal = data.psar[idx];
    var psarDirVal = data.psarDir[idx];
    var sigSAR = psarDirVal === 1 ? 1 : (psarDirVal === -1 ? -1 : 0);
    ind.push({
      name: 'Parabolic SAR',
      value: !isNaN(psarVal) ? Number(psarVal.toFixed(4)) : null,
      signal: s(sigSAR),
      baseWeight: 1.2,
      explanation: 'Parabolic Stop and Reverse: Directional trend trailing envelope'
    });

    // 29. Keltner Channels (20, 2)
    var kcU = data.kcUpper[idx];
    var kcL = data.kcLower[idx];
    var sigKC = 0;
    if (!isNaN(kcU) && !isNaN(kcL)) {
      if (c > kcU) sigKC = 1;
      else if (c < kcL) sigKC = -1;
      else sigKC = c > data.kcMid[idx] ? 0.5 : -0.5;
    }
    ind.push({
      name: 'Keltner Channels (20, 2)',
      value: !isNaN(data.kcMid[idx]) ? Number(data.kcMid[idx].toFixed(4)) : null,
      signal: sigKC >= 0.5 ? 'LONG' : (sigKC <= -0.5 ? 'SHORT' : 'NEUTRAL'),
      baseWeight: 1.2,
      explanation: 'Keltner Channel breakout & median positioning'
    });

    // 30. Chaikin Money Flow (20) / Pivot Reference
    var cmfVal = data.cmf20[idx];
    var sigCMF = isNaN(cmfVal) ? 0 : (cmfVal > 0.05 ? 1 : (cmfVal < -0.05 ? -1 : 0));
    ind.push({
      name: 'Chaikin Money Flow (CMF 20)',
      value: !isNaN(cmfVal) ? Number(cmfVal.toFixed(4)) : null,
      signal: s(sigCMF),
      baseWeight: 1.2,
      explanation: 'CMF (20): Institutional accumulation (>0.05) vs distribution (<-0.05)'
    });

    return ind;
  }

  // --- Main Analysis Entry Point ---
  function analyze(candles, currentPrice) {
    var warningPersian = 'سلب مسئولیت: عملکرد گذشته و نتایج اندیکاتورها هیچ‌گونه تضمینی برای سودآوری در آینده نیستند. بازارهای مالی دارای ریسک ذاتی می‌باشند.';
    var warningEnglish = 'Disclaimer: Historical performance and technical indicators do not guarantee future returns. Trading cryptocurrencies carries substantial financial risk.';
    var structurallyValid = Array.isArray(candles) && candles.every(function (c, i) {
      if (!c || !Number.isFinite(c.time) || !Number.isFinite(c.open) || !Number.isFinite(c.high) ||
          !Number.isFinite(c.low) || !Number.isFinite(c.close) || !Number.isFinite(c.volume) ||
          c.time <= 0 || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0 || c.volume < 0 ||
          c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close, c.high)) return false;
      return i === 0 || (c.time > candles[i - 1].time && c.time - candles[i - 1].time <= 3 * 60 * 60 * 1000);
    });

    var tooOld = structurallyValid && candles.length > 0 && (Date.now() - candles[candles.length - 1].time > 125 * 60 * 1000 || candles[candles.length - 1].time > Date.now() + 60 * 60 * 1000);
    if (!structurallyValid || candles.length < 120 || tooOld) {
      var shortNames = ['SMA (20)', 'Pivot Points', 'SMA (200)', 'EMA (12)', 'EMA (26)', 'EMA (50)', 'WMA (20)', 'HMA (20)', 'RSI (14)', 'ATR (14)', 'MACD (12, 26, 9)', 'PPO (12, 26, 9)', 'Bollinger Bands (20, 2)', 'Stochastic Oscillator (14, 3)', 'Williams %R (14)', 'CCI (20)', 'ROC (12)', 'Momentum (10)', 'ADX (14)', 'DI (+DI / -DI)', 'OBV', 'MFI (14)', 'VWAP', 'Aroon (25)', 'Donchian Channels (20)', 'Ichimoku Cloud', 'Supertrend (10, 3)', 'Parabolic SAR', 'Keltner Channels (20, 2)', 'Chaikin Money Flow (CMF 20)'];
      var shortIndicators = shortNames.map(function (name) {
        return { name: name, value: null, signal: 'NEUTRAL', direction: 0, confidence: 0, baseWeight: 1, adaptiveWeight: 0, hitRate: null, sampleCount: 0, explanation: 'Insufficient candle history for a reliable indicator evaluation.' };
      });
      return {
        indicators: shortIndicators,
        marketRegime: 'INSUFFICIENT_DATA',
        score: 0,
        signal: 'NEUTRAL',
        confidence: 0,
        risk: null,
        warnings: {
          fa: warningPersian + (structurallyValid ? ' (داده‌های کندل کمتر از ۱۲۰ عدد است).' : ' (ساختار OHLCV نامعتبر، تکراری یا نامرتب است).'),
          en: warningEnglish + (structurallyValid ? ' (At least 120 fresh OHLCV candles with positive volume are required).' : ' (OHLCV records are invalid, duplicate, or not chronological).')
        }
      };
    }

    var lastIdx = candles.length - 1;
    var effectivePrice = candles[lastIdx].close; // Use the last real OHLC close; ticker data never drives signals.
    var precomputed = computeAllIndicators(candles);
    var currentRegime = getMarketRegime(precomputed, lastIdx);

    // Evaluate live indicators on current candle
    var currentIndicators = evaluateIndicatorsAtIndex(precomputed, lastIdx, effectivePrice);

    // --- Expanding-window walk-forward: prediction at t uses indicators through t only;
    // future close is used solely to score that already-made prediction.
    var forwardHorizon = 5;
    var evaluationStart = 200; // warmup for long-period indicators (SMA 200)
    var evaluationEnd = candles.length - 1 - forwardHorizon;
    var MIN_EVALUATION_SAMPLES = 20;
    var ROUND_TRIP_COST = 0.002; // conservative 0.10% fee + 0.10% slippage, per completed trade
    var stats = currentIndicators.map(function () { return { net: 0, total: 0, wins: 0 }; });

    for (var t = evaluationStart; t <= evaluationEnd; t++) {
      var histPrice = candles[t].close;
      var fwdPrice = candles[t + forwardHorizon].close;
      var histIndicators = evaluateIndicatorsAtIndex(precomputed, t, histPrice);
      for (var indIdx = 0; indIdx < histIndicators.length; indIdx++) {
        var hist = histIndicators[indIdx];
        if (hist.signal !== 'LONG' && hist.signal !== 'SHORT') continue;
        var direction = hist.signal === 'LONG' ? 1 : -1;
        var grossReturn = direction * (fwdPrice / histPrice - 1);
        var netReturn = grossReturn - ROUND_TRIP_COST;
        stats[indIdx].total += 1;
        stats[indIdx].net += netReturn;
        if (netReturn > 0) stats[indIdx].wins += 1;
      }
    }

    var weighted = 0;
    var totalWeight = 0;
    for (var i = 0; i < currentIndicators.length; i++) {
      var item = currentIndicators[i];
      var st = stats[i];
      item.direction = item.signal === 'LONG' ? 1 : (item.signal === 'SHORT' ? -1 : 0);
      item.confidence = item.direction === 0 ? 0 : 0.65;
      if (st.total >= MIN_EVALUATION_SAMPLES) {
        var meanNet = st.net / st.total;
        item.hitRate = Number((st.wins / st.total).toFixed(4));
        item.meanNetReturn = Number(meanNet.toFixed(6));
        item.sampleCount = st.total;
        // Shrunk, bounded net-return multiplier. No profitable OOS history => base weight.
        var multiplier = clamp(1 + meanNet * 20, 0.5, 1.5);
        item.adaptiveWeight = item.baseWeight * multiplier;
      } else {
        item.hitRate = null;
        item.meanNetReturn = null;
        item.sampleCount = st.total;
        item.adaptiveWeight = item.baseWeight;
      }
      weighted += item.direction * item.adaptiveWeight * item.confidence;
      totalWeight += item.adaptiveWeight;
    }
    // Normalize adaptive weights for an auditable probability-like contribution.
    currentIndicators.forEach(function (item) { item.adaptiveWeight = totalWeight > 0 ? item.adaptiveWeight / totalWeight : 0; });
    var rawScore = totalWeight > 0 ? (weighted / totalWeight) * 100 : 0;
    var finalScore = Number(clamp(rawScore, -100, 100).toFixed(2));

    var dirs = currentIndicators.filter(function (x) { return x.direction !== 0; }).map(function (x) { return x.direction; });
    var disagreement = dirs.length ? 1 - Math.abs(dirs.reduce(function (a, b) { return a + b; }, 0) / dirs.length) : 1;
    var currentAtrForRegime = precomputed.atr14[lastIdx];
    var atrPct = Number.isFinite(currentAtrForRegime) ? currentAtrForRegime / effectivePrice : NaN;
    var atrRatios = [];
    for (var ri = Math.max(20, lastIdx - 99); ri < lastIdx; ri++) {
      if (Number.isFinite(precomputed.atr14[ri]) && candles[ri].close > 0) atrRatios.push(precomputed.atr14[ri] / candles[ri].close);
    }
    var baselineAtrPct = atrRatios.length ? atrRatios.reduce(function (a, b) { return a + b; }, 0) / atrRatios.length : NaN;
    var highVol = Number.isFinite(atrPct) && Number.isFinite(baselineAtrPct) && baselineAtrPct > 0 && atrPct / baselineAtrPct > 1.5;
    var volumeWindow = candles.slice(-20).map(function (c) { return c.volume; });
    var avgVolume = volumeWindow.reduce(function (a, b) { return a + b; }, 0) / volumeWindow.length;
    var volumeAdequate = Number.isFinite(avgVolume) && avgVolume > 0 && candles[lastIdx].volume >= avgVolume * 0.1;
    var regimeKnown = currentRegime !== 'TRENDING_NEUTRAL' && currentRegime !== 'RANGING';
    var confidence = clamp(Math.abs(finalScore) * (1 - 0.65 * disagreement) * (highVol ? 0.65 : 1) * (volumeAdequate ? 1 : 0.55) * (regimeKnown ? 1 : 0.7), 0, 100);
    var finalSignal = confidence >= 25 && finalScore >= 25 ? 'LONG' : (confidence >= 25 && finalScore <= -25 ? 'SHORT' : 'NEUTRAL');
    confidence = Number(confidence.toFixed(2));

    // --- Risk & Target Calculations based strictly on ATR (14) ---
    var currentAtr = precomputed.atr14[lastIdx];
    if (isNaN(currentAtr) || currentAtr <= 0) {
      currentAtr = 0; // Never substitute a fixed percentage for missing market volatility
    }

    var stopLoss = 0;
    var target1 = 0;
    var target2 = 0;
    var rewardRisk = 0;
    var roundPrice = function (value) { return Number(value.toPrecision(10)); };
    var entry = roundPrice(effectivePrice);

    if (finalSignal === 'LONG') {
      stopLoss = roundPrice(entry - (1.5 * currentAtr));
      target1 = roundPrice(entry + (2.0 * currentAtr));
      target2 = roundPrice(entry + (3.5 * currentAtr));
      var slDistL = entry - stopLoss;
      rewardRisk = slDistL > 0 ? Number(((target1 - entry) / slDistL).toFixed(2)) : 1.33;
    } else if (finalSignal === 'SHORT') {
      stopLoss = roundPrice(entry + (1.5 * currentAtr));
      target1 = roundPrice(entry - (2.0 * currentAtr));
      target2 = roundPrice(entry - (3.5 * currentAtr));
      var slDistS = stopLoss - entry;
      rewardRisk = slDistS > 0 ? Number(((entry - target1) / slDistS).toFixed(2)) : 1.33;
    } else {
      stopLoss = null; target1 = null; target2 = null; rewardRisk = null;
    }

    return {
      indicators: currentIndicators,
      marketRegime: currentRegime,
      score: finalScore,
      signal: finalSignal,
      confidence: confidence,
      evaluation: { horizon: forwardHorizon, minSamples: MIN_EVALUATION_SAMPLES, feeAndSlippageRoundTrip: ROUND_TRIP_COST },
      risk: finalSignal === 'NEUTRAL' || !Number.isFinite(effectivePrice) || effectivePrice <= 0 ||
        !Number.isFinite(currentAtr) || currentAtr <= 0 ||
        ![entry, stopLoss, target1, target2].every(function (value) { return Number.isFinite(value) && value > 0; }) ? null : {
        entry: entry,
        atr: currentAtr,
        stopLoss: stopLoss,
        target1: target1,
        target2: target2,
        rewardRisk: rewardRisk,
        horizon: '5 candles; ATR(14), 1.5× stop, 2×/3.5× targets'
      },
      warnings: {
        fa: warningPersian,
        en: warningEnglish
      }
    };
  }

  // Export for Node.js and Browser environments
  var AnalysisEngine = {
    analyze: analyze
  };

  if (typeof module !== 'undefined') module.exports = { analyze: analyze };
  if (typeof window !== 'undefined') window.AnalysisEngine = { analyze: analyze };
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
