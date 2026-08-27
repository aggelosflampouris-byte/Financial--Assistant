/**
 * frontend/components/charts/TradingViewChart.tsx
 * Real-time TradingView Lightweight Charts v4 with:
 * - Live Timestamps & Crosshair Tooltip with OHLCV stats
 * - Timeframe selector (1D, 5D, 1M, 3M, 6M, 1Y, YTD)
 * - Chart Style switcher (Candles, Area, Line, Bars)
 * - Configurable Technical Indicator Parameters (SMA 20/50, EMA 9/21, Bollinger Bands, Volume)
 * - Live Technical Metrics Banner (RSI Gauge, MACD, Moving Average Deviations)
 * - Custom Price Level Annotator (Support, Resistance, Target, Stop-Loss lines)
 * - Bi-directional Chatbot Action Bridge (Auto-applies analysis from advisor)
 * - Snapshot export and Reset zoom tools
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChart,
  IChartApi,
  CandlestickData,
  CrosshairMode,
  ColorType,
  LineStyle,
  IPriceLine,
} from 'lightweight-charts';
import {
  SlidersHorizontal,
  TrendingUp,
  Eye,
  EyeOff,
  RotateCcw,
  Camera,
  Plus,
  Trash2,
  Clock,
  Layers,
  Activity,
  Gauge,
  Zap,
} from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePortfolioStore } from '@/store/portfolioStore';
import type { MarketTick } from '@/store/portfolioStore';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export type ChartType = 'candlestick' | 'area' | 'line' | 'bar';
export type Timeframe = '1D' | '5D' | '1M' | '3M' | '6M' | '1Y' | 'YTD';

interface CustomPriceLine {
  id: string;
  price: number;
  label: string;
  color: string;
}

interface HoverData {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  changePct?: number;
}

interface IndicatorParameters {
  smaFast: number;
  smaSlow: number;
  emaFast: number;
  emaSlow: number;
  bbPeriod: number;
  bbStd: number;
  rsiPeriod: number;
}

interface TradingViewChartProps {
  ticker: string;
  height?: number;
}

// ---------------------------------------------------------------------------
// Technical Indicator Calculations
// ---------------------------------------------------------------------------

function calculateSMA(data: { time: string; close: number }[], period: number) {
  const result: { time: string; value: number }[] = [];
  if (data.length < period) return result;
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close;
    }
    result.push({ time: data[i].time, value: +(sum / period).toFixed(2) });
  }
  return result;
}

function calculateEMA(data: { time: string; close: number }[], period: number) {
  const result: { time: string; value: number }[] = [];
  if (data.length < period) return result;
  const k = 2 / (period + 1);
  let prevEMA = data.slice(0, period).reduce((acc, val) => acc + val.close, 0) / period;
  result.push({ time: data[period - 1].time, value: +prevEMA.toFixed(2) });
  for (let i = period; i < data.length; i++) {
    prevEMA = data[i].close * k + prevEMA * (1 - k);
    result.push({ time: data[i].time, value: +prevEMA.toFixed(2) });
  }
  return result;
}

function calculateBollingerBands(data: { time: string; close: number }[], period: number = 20, multiplier: number = 2.0) {
  const upper: { time: string; value: number }[] = [];
  const middle: { time: string; value: number }[] = [];
  const lower: { time: string; value: number }[] = [];

  if (data.length < period) return { upper, middle, lower };

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

function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50.0;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }

  if (avgLoss === 0) return 100.0;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(1);
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function TradingViewChart({ ticker, height = 380 }: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const indicatorSeriesRefs = useRef<{ [key: string]: any }>({});
  const priceLineRefs = useRef<{ [key: string]: IPriceLine }>({});
  const rawBarsRef = useRef<any[]>([]);
  const currentBarRef = useRef<CandlestickData | null>(null);

  // --- States ---
  const [chartType, setChartType] = useState<ChartType>('candlestick');
  const [timeframe, setTimeframe] = useState<Timeframe>('1M');
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState<number>(0);
  const [lastTickTime, setLastTickTime] = useState<string>('');
  const [hoverData, setHoverData] = useState<HoverData | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  // Indicator Parameters
  const [params, setParams] = useState<IndicatorParameters>({
    smaFast: 20,
    smaSlow: 50,
    emaFast: 9,
    emaSlow: 21,
    bbPeriod: 20,
    bbStd: 2.0,
    rsiPeriod: 14,
  });

  // Calculated Live Metrics
  const [liveMetrics, setLiveMetrics] = useState<{
    rsi: number;
    rsiStatus: 'OVERSOLD' | 'NEUTRAL' | 'OVERBOUGHT';
    smaFastVal: number | null;
    smaSlowVal: number | null;
    bbBandwidth: number | null;
  }>({
    rsi: 50,
    rsiStatus: 'NEUTRAL',
    smaFastVal: null,
    smaSlowVal: null,
    bbBandwidth: null,
  });

  // Indicators toggle state
  const [indicators, setIndicators] = useState({
    sma20: true,
    sma50: true,
    ema9: false,
    ema21: false,
    bb: true,
    volume: true,
  });

  // Custom Price Lines
  const [priceLines, setPriceLines] = useState<CustomPriceLine[]>([
    { id: '1', price: 0, label: 'Target Price', color: '#10b981' },
  ]);
  const [newLinePrice, setNewLinePrice] = useState('');
  const [newLineLabel, setNewLineLabel] = useState('Resistance');
  const [newLineColor, setNewLineColor] = useState('#ef4444');

  const updateTick = usePortfolioStore((s) => s.updateTick);
  const setWsConnected = usePortfolioStore((s) => s.setWsConnected);
  const chartDirective = usePortfolioStore((s) => s.chartDirective);

  // -------------------------------------------------------------------------
  // Automatic Chatbot-to-Chart Directive Bridge
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!chartDirective) return;

    if (chartDirective.timeframe) {
      setTimeframe(chartDirective.timeframe);
    }
    if (chartDirective.chart_type) {
      setChartType(chartDirective.chart_type);
    }
    if (chartDirective.enable_indicators && Array.isArray(chartDirective.enable_indicators)) {
      setIndicators((prev) => {
        const next = { ...prev };
        chartDirective.enable_indicators!.forEach((ind) => {
          if (ind in next) {
            (next as any)[ind] = true;
          }
        });
        return next;
      });
    }
    if (chartDirective.add_price_lines && Array.isArray(chartDirective.add_price_lines)) {
      setPriceLines((prev) => {
        const existingLabels = new Set(prev.map((l) => l.label));
        const toAdd = chartDirective.add_price_lines!.filter((l) => !existingLabels.has(l.label));
        return [...prev, ...toAdd];
      });
    }

    setShowEditor(true);
  }, [chartDirective]);

  // -------------------------------------------------------------------------
  // WebSocket Handler
  // -------------------------------------------------------------------------
  const onMessage = useCallback((data: string) => {
    try {
      const tick: MarketTick = JSON.parse(data);
      if (tick.ticker !== ticker || tick.action === 'pong') return;

      updateTick(tick);
      setCurrentPrice(tick.price);
      setPriceChange(tick.changePct * 100);

      const now = new Date(tick.timestamp || Date.now());
      setLastTickTime(now.toLocaleTimeString('en-US', { hour12: false }));

      const dateStr = now.toISOString().split('T')[0];
      if (mainSeriesRef.current) {
        if (!currentBarRef.current || (currentBarRef.current.time as string) !== dateStr) {
          currentBarRef.current = {
            time: dateStr as any,
            open: tick.price,
            high: tick.price,
            low: tick.price,
            close: tick.price,
          };
        } else {
          currentBarRef.current = {
            ...currentBarRef.current,
            high: Math.max(currentBarRef.current.high, tick.price),
            low: Math.min(currentBarRef.current.low, tick.price),
            close: tick.price,
          };
        }

        if (chartType === 'candlestick' || chartType === 'bar') {
          mainSeriesRef.current.update(currentBarRef.current);
        } else {
          mainSeriesRef.current.update({ time: dateStr, value: tick.price });
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }, [ticker, chartType, updateTick]);

  const onStatusChange = useCallback((connected: boolean) => {
    setWsConnected(ticker, connected);
  }, [ticker, setWsConnected]);

  const { isConnected } = useWebSocket(`/ws/market/${ticker}`, {
    onMessage,
    onStatusChange,
  });

  // -------------------------------------------------------------------------
  // Render Indicators on Chart
  // -------------------------------------------------------------------------
  const applyIndicators = useCallback((bars: any[], chart: IChartApi) => {
    if (!bars || bars.length === 0) return;

    const closeData = bars.map((b) => ({ time: b.time, close: b.close }));
    const rawCloses = bars.map((b) => b.close);

    // Compute live technical summary
    const rsiVal = calculateRSI(rawCloses, params.rsiPeriod);
    const rsiStatus = rsiVal >= 70 ? 'OVERBOUGHT' : rsiVal <= 30 ? 'OVERSOLD' : 'NEUTRAL';
    const smaFast = calculateSMA(closeData, params.smaFast);
    const smaSlow = calculateSMA(closeData, params.smaSlow);
    const bb = calculateBollingerBands(closeData, params.bbPeriod, params.bbStd);

    const lastFast = smaFast.length > 0 ? smaFast[smaFast.length - 1].value : null;
    const lastSlow = smaSlow.length > 0 ? smaSlow[smaSlow.length - 1].value : null;
    const lastBBWidth = (bb.upper.length > 0 && bb.middle.length > 0)
      ? +(((bb.upper[bb.upper.length - 1].value - bb.lower[bb.lower.length - 1].value) / bb.middle[bb.middle.length - 1].value) * 100).toFixed(1)
      : null;

    setLiveMetrics({
      rsi: rsiVal,
      rsiStatus,
      smaFastVal: lastFast,
      smaSlowVal: lastSlow,
      bbBandwidth: lastBBWidth,
    });

    // Clean up previous indicator series
    Object.values(indicatorSeriesRefs.current).forEach((series) => {
      try { chart.removeSeries(series); } catch {}
    });
    indicatorSeriesRefs.current = {};

    // SMA Fast
    if (indicators.sma20) {
      const s = chart.addLineSeries({ color: '#3b82f6', lineWidth: 2, title: `SMA ${params.smaFast}` });
      s.setData(smaFast as any);
      indicatorSeriesRefs.current.sma20 = s;
    }

    // SMA Slow
    if (indicators.sma50) {
      const s = chart.addLineSeries({ color: '#f59e0b', lineWidth: 2, title: `SMA ${params.smaSlow}` });
      s.setData(smaSlow as any);
      indicatorSeriesRefs.current.sma50 = s;
    }

    // EMA Fast
    if (indicators.ema9) {
      const emaFast = calculateEMA(closeData, params.emaFast);
      const s = chart.addLineSeries({ color: '#a855f7', lineWidth: 2, title: `EMA ${params.emaFast}` });
      s.setData(emaFast as any);
      indicatorSeriesRefs.current.ema9 = s;
    }

    // EMA Slow
    if (indicators.ema21) {
      const emaSlow = calculateEMA(closeData, params.emaSlow);
      const s = chart.addLineSeries({ color: '#10b981', lineWidth: 2, title: `EMA ${params.emaSlow}` });
      s.setData(emaSlow as any);
      indicatorSeriesRefs.current.ema21 = s;
    }

    // Bollinger Bands
    if (indicators.bb) {
      const u = chart.addLineSeries({ color: '#06b6d4', lineWidth: 1, lineStyle: LineStyle.Dashed, title: `BB Upper (${params.bbPeriod},${params.bbStd})` });
      const m = chart.addLineSeries({ color: '#0891b2', lineWidth: 1, title: 'BB Mid' });
      const l = chart.addLineSeries({ color: '#06b6d4', lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'BB Lower' });
      u.setData(bb.upper as any);
      m.setData(bb.middle as any);
      l.setData(bb.lower as any);
      indicatorSeriesRefs.current.bbUpper = u;
      indicatorSeriesRefs.current.bbMiddle = m;
      indicatorSeriesRefs.current.bbLower = l;
    }

    // Volume
    if (indicators.volume && volumeSeriesRef.current) {
      const volData = bars.map((b) => ({
        time: b.time,
        value: b.volume || 1000000,
        color: b.close >= b.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)',
      }));
      volumeSeriesRef.current.setData(volData);
    }
  }, [indicators, params]);

  // -------------------------------------------------------------------------
  // Initialize Chart Instance (Once on Mount)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    containerRef.current.innerHTML = '';

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b99b8',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(99, 131, 195, 0.08)' },
        horzLines: { color: 'rgba(99, 131, 195, 0.08)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(59, 130, 246, 0.6)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1e293b',
        },
        horzLine: {
          color: 'rgba(59, 130, 246, 0.6)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1e293b',
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(99, 131, 195, 0.15)',
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: 'rgba(99, 131, 195, 0.15)',
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
    });

    chartRef.current = chart;

    // Add Volume Series on bottom overlay
    const volumeSeries = chart.addHistogramSeries({
      color: '#3b82f6',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume_scale',
    });
    chart.priceScale('volume_scale').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    volumeSeriesRef.current = volumeSeries;

    // Crosshair hover listener
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData || !mainSeriesRef.current) {
        setHoverData(null);
        return;
      }

      const data = param.seriesData.get(mainSeriesRef.current) as any;
      if (data) {
        const timeStr = typeof param.time === 'string'
          ? param.time
          : new Date((param.time as number) * 1000).toISOString().split('T')[0];

        const open = data.open ?? data.value ?? 0;
        const close = data.close ?? data.value ?? 0;
        const high = data.high ?? Math.max(open, close);
        const low = data.low ?? Math.min(open, close);
        const vol = (param.seriesData.get(volumeSeries) as any)?.value;

        setHoverData({
          time: timeStr,
          open,
          high,
          low,
          close,
          volume: vol,
          changePct: open ? ((close - open) / open) * 100 : 0,
        });
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        try {
          chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
        } catch {}
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      try {
        chart.remove();
      } catch {}
      chartRef.current = null;
    };
  }, [height]);

  // -------------------------------------------------------------------------
  // Load / Update Series Data When Ticker, Timeframe, or Chart Type Changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (mainSeriesRef.current) {
      try { chart.removeSeries(mainSeriesRef.current); } catch {}
      mainSeriesRef.current = null;
    }

    let mainSeries: any;
    if (chartType === 'candlestick') {
      mainSeries = chart.addCandlestickSeries({
        upColor: '#10b981',
        downColor: '#ef4444',
        borderUpColor: '#10b981',
        borderDownColor: '#ef4444',
        wickUpColor: '#10b981',
        wickDownColor: '#ef4444',
      });
    } else if (chartType === 'area') {
      mainSeries = chart.addAreaSeries({
        topColor: 'rgba(59, 130, 246, 0.4)',
        bottomColor: 'rgba(59, 130, 246, 0.0)',
        lineColor: '#3b82f6',
        lineWidth: 2,
      });
    } else if (chartType === 'line') {
      mainSeries = chart.addLineSeries({
        color: '#3b82f6',
        lineWidth: 2,
      });
    } else {
      mainSeries = chart.addBarSeries({
        upColor: '#10b981',
        downColor: '#ef4444',
      });
    }
    mainSeriesRef.current = mainSeries;

    const tfMap: { [k in Timeframe]: { period: string; interval: string } } = {
      '1D': { period: '1d', interval: '5m' },
      '5D': { period: '5d', interval: '15m' },
      '1M': { period: '1mo', interval: '1d' },
      '3M': { period: '3mo', interval: '1d' },
      '6M': { period: '6mo', interval: '1d' },
      '1Y': { period: '1y', interval: '1wk' },
      'YTD': { period: 'ytd', interval: '1d' },
    };

    const { period, interval } = tfMap[timeframe] || { period: '1mo', interval: '1d' };
    const API_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:8080';

    fetch(`${API_BASE}/market/ohlcv/${ticker}?period=${period}&interval=${interval}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((bars) => {
        if (!bars || !Array.isArray(bars) || bars.length === 0) return;

        const chartData = bars.map((b: any) => {
          const timeStr = b.timestamp.includes('T') ? b.timestamp.split('T')[0] : b.timestamp;
          return {
            time: timeStr,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          };
        });

        rawBarsRef.current = chartData;

        if (chartType === 'candlestick' || chartType === 'bar') {
          mainSeries.setData(chartData);
        } else {
          mainSeries.setData(chartData.map((d) => ({ time: d.time, value: d.close })));
        }

        const lastBar = chartData[chartData.length - 1];
        if (lastBar) {
          setCurrentPrice(lastBar.close);
          const firstBar = chartData[0];
          setPriceChange(((lastBar.close - firstBar.open) / firstBar.open) * 100);
          setLastTickTime(lastBar.time);
        }

        applyIndicators(chartData, chart);

        // Apply Custom Price Lines
        priceLines.forEach((line) => {
          if (line.price > 0) {
            try {
              const pl = mainSeries.createPriceLine({
                price: line.price,
                color: line.color,
                lineWidth: 2,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: line.label,
              });
              priceLineRefs.current[line.id] = pl;
            } catch {}
          }
        });

        try { chart.timeScale().fitContent(); } catch {}
      })
      .catch((err) => console.debug('Historical OHLCV fetch skipped:', err));
  }, [ticker, timeframe, chartType, applyIndicators]);

  // -------------------------------------------------------------------------
  // Re-apply Indicators When Toggled or Parameters Change
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (chartRef.current && rawBarsRef.current.length > 0) {
      applyIndicators(rawBarsRef.current, chartRef.current);
    }
  }, [indicators, params, applyIndicators]);

  // -------------------------------------------------------------------------
  // Custom Price Line Controls
  // -------------------------------------------------------------------------
  const addPriceLine = () => {
    const p = parseFloat(newLinePrice);
    if (isNaN(p) || p <= 0) return;

    const line: CustomPriceLine = {
      id: crypto.randomUUID(),
      price: p,
      label: newLineLabel.trim() || 'Custom Level',
      color: newLineColor,
    };

    setPriceLines((prev) => [...prev, line]);
    setNewLinePrice('');

    if (mainSeriesRef.current) {
      try {
        const pl = mainSeriesRef.current.createPriceLine({
          price: line.price,
          color: line.color,
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: line.label,
        });
        priceLineRefs.current[line.id] = pl;
      } catch {}
    }
  };

  const removePriceLine = (id: string) => {
    setPriceLines((prev) => prev.filter((l) => l.id !== id));
    if (mainSeriesRef.current && priceLineRefs.current[id]) {
      try {
        mainSeriesRef.current.removePriceLine(priceLineRefs.current[id]);
        delete priceLineRefs.current[id];
      } catch {}
    }
  };

  const resetZoom = () => {
    try {
      chartRef.current?.timeScale().fitContent();
    } catch {}
  };

  const takeSnapshot = () => {
    if (!containerRef.current) return;
    const canvas = containerRef.current.querySelector('canvas');
    if (canvas) {
      const img = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = img;
      a.download = `${ticker}_technical_chart_${new Date().toISOString().split('T')[0]}.png`;
      a.click();
    }
  };

  const isPositive = priceChange >= 0;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {/* ===================================================================== */}
      {/* 1. TOP HEADER: Ticker, Price, Timestamp & Live Status */}
      {/* ===================================================================== */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px 8px',
        borderBottom: '1px solid var(--color-border)',
        gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div>
            <span style={{ fontWeight: 700, fontSize: '1.15rem', color: 'var(--color-text-primary)' }}>
              {ticker}
            </span>
            {currentPrice !== null && (
              <span style={{
                marginLeft: 10,
                fontSize: '1.35rem',
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--color-text-primary)',
              }}>
                ${currentPrice.toFixed(2)}
              </span>
            )}
            {currentPrice !== null && (
              <span style={{
                marginLeft: 8,
                color: isPositive ? 'var(--color-success)' : 'var(--color-danger)',
                fontSize: '0.85rem',
                fontWeight: 600,
              }}>
                {isPositive ? '+' : ''}{priceChange.toFixed(2)}%
              </span>
            )}
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            background: 'rgba(255, 255, 255, 0.04)',
            padding: '3px 8px',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.72rem',
            color: 'var(--color-text-secondary)',
          }}>
            <Clock size={12} color="var(--color-accent-bright)" />
            <span>{lastTickTime ? `Updated: ${lastTickTime}` : 'Connecting...'}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setShowEditor(!showEditor)}
            className={`btn btn-secondary ${showEditor ? 'btn-active' : ''}`}
            style={{
              padding: '5px 10px',
              fontSize: '0.78rem',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: showEditor ? 'var(--color-accent-primary)' : 'rgba(255,255,255,0.05)',
              color: showEditor ? '#fff' : 'var(--color-text-secondary)',
            }}
            title="Toggle Technical Parameters & Indicator Overlays"
          >
            <SlidersHorizontal size={14} />
            <span>Technical Parameters</span>
          </button>

          <button
            onClick={resetZoom}
            className="btn btn-secondary"
            style={{ padding: '5px 8px', fontSize: '0.78rem' }}
            title="Reset Zoom / Fit View"
          >
            <RotateCcw size={13} />
          </button>

          <button
            onClick={takeSnapshot}
            className="btn btn-secondary"
            style={{ padding: '5px 8px', fontSize: '0.78rem' }}
            title="Export High-Res PNG Chart"
          >
            <Camera size={13} />
          </button>

          <span
            className={`live-indicator ${isConnected ? 'pulsing' : ''}`}
            style={{
              color: isConnected ? 'var(--color-success)' : 'var(--color-text-muted)',
              fontSize: '0.75rem',
              fontWeight: 600,
              marginLeft: 4,
            }}
          >
            {isConnected ? 'LIVE' : 'CONNECTING'}
          </span>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* 2. TIMEFRAME & CHART TYPE TOOLBAR */}
      {/* ===================================================================== */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 16px',
        background: 'rgba(0, 0, 0, 0.2)',
        borderBottom: '1px solid var(--color-border)',
        fontSize: '0.75rem',
      }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['1D', '5D', '1M', '3M', '6M', '1Y', 'YTD'] as Timeframe[]).map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              style={{
                background: timeframe === tf ? 'var(--color-accent-primary)' : 'transparent',
                color: timeframe === tf ? '#ffffff' : 'var(--color-text-secondary)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                padding: '3px 8px',
                fontSize: '0.75rem',
                fontWeight: timeframe === tf ? 600 : 500,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {tf}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ color: 'var(--color-text-muted)', marginRight: 4 }}>Type:</span>
          {(['candlestick', 'area', 'line', 'bar'] as ChartType[]).map((type) => (
            <button
              key={type}
              onClick={() => setChartType(type)}
              style={{
                background: chartType === type ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                color: chartType === type ? 'var(--color-accent-bright)' : 'var(--color-text-muted)',
                border: `1px solid ${chartType === type ? 'var(--color-accent-primary)' : 'transparent'}`,
                borderRadius: 'var(--radius-sm)',
                padding: '2px 7px',
                fontSize: '0.72rem',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {/* ===================================================================== */}
      {/* 3. LIVE TECHNICAL METRICS SUMMARY RIBBON */}
      {/* ===================================================================== */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '4px 16px',
        background: 'rgba(15, 23, 42, 0.8)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
        fontSize: '0.72rem',
        gap: 12,
      }}>
        {/* Left: RSI Gauge & Moving Averages */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Gauge size={13} color="var(--color-accent-bright)" />
            <span style={{ color: 'var(--color-text-secondary)' }}>RSI ({params.rsiPeriod}):</span>
            <span style={{
              fontWeight: 700,
              padding: '1px 6px',
              borderRadius: 3,
              background: liveMetrics.rsiStatus === 'OVERSOLD'
                ? 'rgba(16, 185, 129, 0.2)'
                : liveMetrics.rsiStatus === 'OVERBOUGHT'
                ? 'rgba(239, 68, 68, 0.2)'
                : 'rgba(245, 158, 11, 0.2)',
              color: liveMetrics.rsiStatus === 'OVERSOLD'
                ? 'var(--color-success)'
                : liveMetrics.rsiStatus === 'OVERBOUGHT'
                ? 'var(--color-danger)'
                : 'var(--color-warning)',
            }}>
              {liveMetrics.rsi} ({liveMetrics.rsiStatus})
            </span>
          </div>

          {liveMetrics.smaFastVal !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#3b82f6', fontWeight: 600 }}>SMA {params.smaFast}:</span>
              <strong style={{ color: '#fff' }}>${liveMetrics.smaFastVal}</strong>
            </div>
          )}

          {liveMetrics.smaSlowVal !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#f59e0b', fontWeight: 600 }}>SMA {params.smaSlow}:</span>
              <strong style={{ color: '#fff' }}>${liveMetrics.smaSlowVal}</strong>
            </div>
          )}

          {liveMetrics.bbBandwidth !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#06b6d4', fontWeight: 600 }}>BB Width:</span>
              <strong style={{ color: '#fff' }}>{liveMetrics.bbBandwidth}%</strong>
            </div>
          )}
        </div>

        {/* Right: Crosshair Hover Stats */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-text-secondary)',
        }}>
          {hoverData ? (
            <>
              <span style={{ color: 'var(--color-accent-bright)', fontWeight: 600 }}>📅 {hoverData.time}</span>
              <span>O: <strong style={{ color: '#fff' }}>${hoverData.open.toFixed(2)}</strong></span>
              <span>H: <strong style={{ color: '#fff' }}>${hoverData.high.toFixed(2)}</strong></span>
              <span>L: <strong style={{ color: '#fff' }}>${hoverData.low.toFixed(2)}</strong></span>
              <span>C: <strong style={{ color: '#fff' }}>${hoverData.close.toFixed(2)}</strong></span>
              {hoverData.volume !== undefined && (
                <span>Vol: <strong style={{ color: '#fff' }}>{(hoverData.volume / 1000000).toFixed(2)}M</strong></span>
              )}
            </>
          ) : (
            <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
              Hover over bars to inspect OHLCV figures
            </span>
          )}
        </div>
      </div>

      {/* ===================================================================== */}
      {/* 4. EXPANDABLE TECHNICAL PARAMETERS & INDICATOR CONTROLS */}
      {/* ===================================================================== */}
      {showEditor && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(15, 23, 42, 0.98)',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          {/* Section A: Indicator Toggles */}
          <div>
            <p style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <Layers size={14} color="var(--color-accent-bright)" />
              Active Technical Indicators & Overlays:
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {[
                { key: 'sma20', label: `SMA ${params.smaFast} (Fast)`, color: '#3b82f6' },
                { key: 'sma50', label: `SMA ${params.smaSlow} (Slow)`, color: '#f59e0b' },
                { key: 'ema9', label: `EMA ${params.emaFast}`, color: '#a855f7' },
                { key: 'ema21', label: `EMA ${params.emaSlow}`, color: '#10b981' },
                { key: 'bb', label: `Bollinger Bands (${params.bbPeriod}, ${params.bbStd}σ)`, color: '#06b6d4' },
                { key: 'volume', label: 'Volume Sub-Chart', color: '#6366f1' },
              ].map((ind) => {
                const active = (indicators as any)[ind.key];
                return (
                  <button
                    key={ind.key}
                    onClick={() => setIndicators((prev) => ({ ...prev, [ind.key]: !active }))}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${active ? ind.color : 'rgba(255,255,255,0.1)'}`,
                      background: active ? `${ind.color}22` : 'transparent',
                      color: active ? '#ffffff' : 'var(--color-text-muted)',
                      fontSize: '0.72rem',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: ind.color, opacity: active ? 1 : 0.4,
                    }} />
                    <span>{ind.label}</span>
                    {active ? <Eye size={12} /> : <EyeOff size={12} />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Section B: Custom Indicator Mathematical Parameters */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
            <p style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <Activity size={14} color="var(--color-accent-bright)" />
              Custom Indicator Calculation Parameters:
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>
                <span>SMA Fast:</span>
                <input
                  type="number"
                  min="5"
                  max="100"
                  value={params.smaFast}
                  onChange={(e) => setParams((p) => ({ ...p, smaFast: parseInt(e.target.value) || 20 }))}
                  style={{
                    width: 55,
                    padding: '3px 6px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--color-border)',
                    color: '#fff',
                    fontSize: '0.72rem',
                  }}
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>
                <span>SMA Slow:</span>
                <input
                  type="number"
                  min="10"
                  max="200"
                  value={params.smaSlow}
                  onChange={(e) => setParams((p) => ({ ...p, smaSlow: parseInt(e.target.value) || 50 }))}
                  style={{
                    width: 55,
                    padding: '3px 6px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--color-border)',
                    color: '#fff',
                    fontSize: '0.72rem',
                  }}
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>
                <span>BB Period:</span>
                <input
                  type="number"
                  min="5"
                  max="50"
                  value={params.bbPeriod}
                  onChange={(e) => setParams((p) => ({ ...p, bbPeriod: parseInt(e.target.value) || 20 }))}
                  style={{
                    width: 55,
                    padding: '3px 6px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--color-border)',
                    color: '#fff',
                    fontSize: '0.72rem',
                  }}
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>
                <span>BB StdDev:</span>
                <input
                  type="number"
                  step="0.5"
                  min="1.0"
                  max="4.0"
                  value={params.bbStd}
                  onChange={(e) => setParams((p) => ({ ...p, bbStd: parseFloat(e.target.value) || 2.0 }))}
                  style={{
                    width: 55,
                    padding: '3px 6px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--color-border)',
                    color: '#fff',
                    fontSize: '0.72rem',
                  }}
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>
                <span>RSI Period:</span>
                <input
                  type="number"
                  min="5"
                  max="30"
                  value={params.rsiPeriod}
                  onChange={(e) => setParams((p) => ({ ...p, rsiPeriod: parseInt(e.target.value) || 14 }))}
                  style={{
                    width: 55,
                    padding: '3px 6px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--color-border)',
                    color: '#fff',
                    fontSize: '0.72rem',
                  }}
                />
              </label>
            </div>
          </div>

          {/* Section C: Custom Price Line / Support & Resistance Annotations */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
            <p style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <TrendingUp size={14} color="var(--color-accent-bright)" />
              Custom Statistical Support & Resistance Lines:
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <input
                type="number"
                step="0.01"
                placeholder="Price ($)"
                value={newLinePrice}
                onChange={(e) => setNewLinePrice(e.target.value)}
                style={{
                  width: 100,
                  padding: '4px 8px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--color-border)',
                  color: '#fff',
                  fontSize: '0.75rem',
                }}
              />
              <input
                type="text"
                placeholder="Label (e.g. Stop Loss)"
                value={newLineLabel}
                onChange={(e) => setNewLineLabel(e.target.value)}
                style={{
                  width: 140,
                  padding: '4px 8px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--color-border)',
                  color: '#fff',
                  fontSize: '0.75rem',
                }}
              />
              <select
                value={newLineColor}
                onChange={(e) => setNewLineColor(e.target.value)}
                style={{
                  padding: '4px 8px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--color-border)',
                  color: '#fff',
                  fontSize: '0.75rem',
                }}
              >
                <option value="#ef4444" style={{ background: '#0f172a' }}>🔴 Resistance / Stop</option>
                <option value="#10b981" style={{ background: '#0f172a' }}>🟢 Support / Target</option>
                <option value="#3b82f6" style={{ background: '#0f172a' }}>🔵 Entry Level</option>
                <option value="#f59e0b" style={{ background: '#0f172a' }}>🟠 Pivot Level</option>
              </select>
              <button
                onClick={addPriceLine}
                className="btn btn-primary"
                style={{ padding: '4px 10px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                <Plus size={13} />
                <span>Add Level</span>
              </button>
            </div>

            {/* Active Lines List */}
            {priceLines.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {priceLines.map((l) => (
                  <span
                    key={l.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(255,255,255,0.04)',
                      border: `1px solid ${l.color}66`,
                      fontSize: '0.7rem',
                      color: l.color,
                    }}
                  >
                    <span>{l.label}: ${l.price ? l.price.toFixed(2) : 'Dynamic'}</span>
                    <Trash2
                      size={11}
                      onClick={() => removePriceLine(l.id)}
                      style={{ cursor: 'pointer', opacity: 0.8 }}
                    />
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* 5. TRADINGVIEW CANVAS */}
      {/* ===================================================================== */}
      <div ref={containerRef} style={{ height }} />
    </div>
  );
}
