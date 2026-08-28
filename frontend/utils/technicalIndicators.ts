/**
 * frontend/utils/technicalIndicators.ts
 * Pure mathematical algorithms for quantitative indicators, pivot levels, and time normalization.
 * Designed for 100% testability, zero side-effects, and strict TypeScript typing.
 */

export interface PricePoint {
  time: string | number;
  close: number;
}

export interface OHLCVPoint {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface IndicatorSeriesPoint {
  time: string | number;
  value: number;
}

export interface BollingerBandsResult {
  upper: IndicatorSeriesPoint[];
  middle: IndicatorSeriesPoint[];
  lower: IndicatorSeriesPoint[];
}

export interface MACDResult {
  macdLine: IndicatorSeriesPoint[];
  signalLine: IndicatorSeriesPoint[];
  histogram: { time: string | number; value: number; color: string }[];
}

export interface ClassicalPivots {
  pivot: number;
  r1: number;
  r2: number;
  s1: number;
  s2: number;
}

export interface FibonacciLevels {
  f100: number;
  f786: number;
  f618: number;
  f500: number;
  f382: number;
  f236: number;
  f0: number;
}

/**
 * Normalizes timestamps to guarantee strict type parity in Lightweight Charts.
 * - Intraday: integer seconds (UTCTimestamp) quantized to interval buckets (300s / 900s).
 * - Daily/Weekly: strict string 'YYYY-MM-DD'.
 */
export function normalizeBarTime(
  timestamp: string | number,
  isIntraday: boolean,
  intervalSeconds: number = 300
): string | number {
  if (isIntraday) {
    let sec: number;
    if (typeof timestamp === 'number') {
      sec = timestamp > 1e11 ? Math.floor(timestamp / 1000) : timestamp;
    } else {
      sec = Math.floor(new Date(timestamp).getTime() / 1000);
    }
    if (isNaN(sec)) sec = Math.floor(Date.now() / 1000);
    return Math.floor(sec / intervalSeconds) * intervalSeconds;
  }

  // Daily/Weekly: MUST strictly be string 'YYYY-MM-DD'
  if (typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(timestamp)) {
    return timestamp;
  }
  const d = new Date(timestamp);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split('T')[0];
  }
  return String(timestamp).split('T')[0];
}

/**
 * Formats a timestamp into human-readable representation for HUD and tooltip display.
 */
export function formatDisplayTime(time: string | number): string {
  if (typeof time === 'number') {
    const d = new Date(time * 1000);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return String(time);
}

/**
 * Computes Simple Moving Average (SMA) over a sliding period.
 */
export function calculateSMA(data: PricePoint[], period: number): IndicatorSeriesPoint[] {
  const result: IndicatorSeriesPoint[] = [];
  if (data.length < period || period <= 0) return result;

  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close;
    }
    result.push({ time: data[i].time, value: +(sum / period).toFixed(2) });
  }
  return result;
}

/**
 * Computes Exponential Moving Average (EMA) using multiplier smoothing.
 */
export function calculateEMA(data: PricePoint[], period: number): IndicatorSeriesPoint[] {
  const result: IndicatorSeriesPoint[] = [];
  if (data.length < period || period <= 0) return result;

  const k = 2 / (period + 1);
  let prevEMA = data.slice(0, period).reduce((acc, val) => acc + val.close, 0) / period;
  result.push({ time: data[period - 1].time, value: +prevEMA.toFixed(2) });

  for (let i = period; i < data.length; i++) {
    prevEMA = data[i].close * k + prevEMA * (1 - k);
    result.push({ time: data[i].time, value: +prevEMA.toFixed(2) });
  }
  return result;
}

/**
 * Computes Bollinger Bands (Upper, Middle, Lower) based on Standard Deviation.
 */
export function calculateBollingerBands(
  data: PricePoint[],
  period: number = 20,
  multiplier: number = 2.0
): BollingerBandsResult {
  const upper: IndicatorSeriesPoint[] = [];
  const middle: IndicatorSeriesPoint[] = [];
  const lower: IndicatorSeriesPoint[] = [];

  if (data.length < period || period <= 0) return { upper, middle, lower };

  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close;
    }
    const mean = sum / period;
    let varSum = 0;
    for (let j = 0; j < period; j++) {
      varSum += Math.pow(data[i - j].close - mean, 2);
    }
    const stdDev = Math.sqrt(varSum / period);
    middle.push({ time: data[i].time, value: +mean.toFixed(2) });
    upper.push({ time: data[i].time, value: +(mean + multiplier * stdDev).toFixed(2) });
    lower.push({ time: data[i].time, value: +(mean - multiplier * stdDev).toFixed(2) });
  }
  return { upper, middle, lower };
}

/**
 * Computes Wilder's Relative Strength Index (RSI) Series.
 */
export function calculateRSISeries(data: PricePoint[], period: number = 14): IndicatorSeriesPoint[] {
  const result: IndicatorSeriesPoint[] = [];
  if (data.length < period + 1 || period <= 0) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push({ time: data[period].time, value: +(100 - 100 / (1 + rs)).toFixed(1) });

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push({ time: data[i].time, value: +(100 - 100 / (1 + rs)).toFixed(1) });
  }
  return result;
}

/**
 * Computes Moving Average Convergence Divergence (MACD) and Signal Series.
 */
export function calculateMACDSeries(
  data: PricePoint[],
  fast: number = 12,
  slow: number = 26,
  signal: number = 9
): MACDResult {
  const macdLine: IndicatorSeriesPoint[] = [];
  const signalLine: IndicatorSeriesPoint[] = [];
  const histogram: { time: string | number; value: number; color: string }[] = [];

  const emaFast = calculateEMA(data, fast);
  const emaSlow = calculateEMA(data, slow);

  const fastMap = new Map(emaFast.map((d) => [String(d.time), d.value]));
  const slowMap = new Map(emaSlow.map((d) => [String(d.time), d.value]));

  const rawMacd: PricePoint[] = [];
  data.forEach((d) => {
    const f = fastMap.get(String(d.time));
    const s = slowMap.get(String(d.time));
    if (f !== undefined && s !== undefined) {
      const val = +(f - s).toFixed(2);
      macdLine.push({ time: d.time, value: val });
      rawMacd.push({ time: d.time, close: val });
    }
  });

  const sigSeries = calculateEMA(rawMacd, signal);
  const sigMap = new Map(sigSeries.map((d) => [String(d.time), d.value]));

  macdLine.forEach((m) => {
    const s = sigMap.get(String(m.time));
    if (s !== undefined) {
      signalLine.push({ time: m.time, value: s });
      const hist = +(m.value - s).toFixed(2);
      histogram.push({
        time: m.time,
        value: hist,
        color: hist >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)',
      });
    }
  });

  return { macdLine, signalLine, histogram };
}

/**
 * Computes Classical Floor Trader Pivot Points (R2, R1, Pivot, S1, S2).
 */
export function calculateClassicalPivots(high: number, low: number, close: number): ClassicalPivots {
  const pivot = (high + low + close) / 3;
  const r1 = 2 * pivot - low;
  const s1 = 2 * pivot - high;
  const r2 = pivot + (high - low);
  const s2 = pivot - (high - low);
  return {
    pivot: +pivot.toFixed(2),
    r1: +r1.toFixed(2),
    r2: +r2.toFixed(2),
    s1: +s1.toFixed(2),
    s2: +s2.toFixed(2),
  };
}

/**
 * Computes Fibonacci Retracement Levels based on period High/Low swing.
 */
export function calculateFibonacciLevels(high: number, low: number): FibonacciLevels {
  const diff = high - low;
  return {
    f100: +high.toFixed(2),
    f786: +(high - 0.214 * diff).toFixed(2),
    f618: +(high - 0.382 * diff).toFixed(2),
    f500: +(high - 0.500 * diff).toFixed(2),
    f382: +(high - 0.618 * diff).toFixed(2),
    f236: +(high - 0.764 * diff).toFixed(2),
    f0: +low.toFixed(2),
  };
}
