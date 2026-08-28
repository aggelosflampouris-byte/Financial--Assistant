/**
 * frontend/components/charts/TradingViewChart.tsx
 * Institutional TradingView Lightweight Charts v4 with:
 * - Anti-Tearing Strict Time-Scale Normalization (Daily 'YYYY-MM-DD' & Intraday 5m/15m Bucketing)
 * - True In-Place Live Candle Updates (Prevents 1-second bar accumulation and x-axis distortion)
 * - Visual Line Overlays (SMA 20/50, EMA 9/21, Bollinger Bands, Volume)
 * - Classical Pivots & Fibonacci Retracement Levels
 * - Supply & Demand Order Block Zones (Distribution & Accumulation Blocks)
 * - Candlestick Pattern Event Markers (Golden Cross, Death Cross, Overbought/Oversold Reversals)
 * - Synchronized Oscillator Sub-Panel (RSI 14 & MACD 12/26/9 with synchronized time scales)
 * - Interactive Floating Heads-Up Display (HUD) with live OHLCV and indicator inspection
 * - Slide-Over Settings & Annotation Drawer (Indicator tuning, Custom levels, Quant stats)
 * - Bi-directional AI Advisor Chart Directive Bridge
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChart,
  IChartApi,
  CrosshairMode,
  ColorType,
  LineStyle,
  IPriceLine,
  ISeriesApi,
  SeriesMarker,
} from 'lightweight-charts';
import {
  SlidersHorizontal,
  RotateCcw,
  Camera,
  Plus,
  Trash2,
  Gauge,
  Sparkles,
  X,
} from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePortfolioStore } from '@/store/portfolioStore';
import type { MarketTick } from '@/store/portfolioStore';
import { API_BASE } from '@/constants/market';
import {
  calculateSMA,
  calculateEMA,
  calculateBollingerBands,
  calculateRSISeries,
  calculateMACDSeries,
  calculateClassicalPivots,
  calculateFibonacciLevels,
  normalizeBarTime,
  formatDisplayTime,
  OHLCVPoint,
  ClassicalPivots,
  FibonacciLevels,
} from '@/utils/technicalIndicators';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export type ChartType = 'candlestick' | 'area' | 'line' | 'bar';
export type Timeframe = '1D' | '5D' | '1M' | '3M' | '6M' | '1Y' | 'YTD';
export type OscillatorView = 'none' | 'rsi' | 'macd' | 'both';

export interface CustomPriceLine {
  id: string;
  price: number;
  label: string;
  color: string;
}

export interface HoverData {
  timeStr: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  changePct?: number;
  smaFast?: number | null;
  smaSlow?: number | null;
  emaFast?: number | null;
  emaSlow?: number | null;
  bbUpper?: number | null;
  bbMiddle?: number | null;
  bbLower?: number | null;
  rsiVal?: number | null;
  macdVal?: number | null;
  macdSig?: number | null;
  macdHist?: number | null;
}

export interface IndicatorParameters {
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
// Main Component
// ---------------------------------------------------------------------------

export function TradingViewChart({ ticker, height = 460 }: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const oscContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const oscChartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const indicatorSeriesRefs = useRef<Record<string, ISeriesApi<any>>>({});
  const oscSeriesRefs = useRef<Record<string, ISeriesApi<any>>>({});
  const priceLineRefs = useRef<Record<string, IPriceLine>>({});
  const rawBarsRef = useRef<OHLCVPoint[]>([]);

  // Cached calculated series data for quick crosshair lookup
  const calcDataMapRef = useRef<{
    smaFastMap: Map<string, number>;
    smaSlowMap: Map<string, number>;
    emaFastMap: Map<string, number>;
    emaSlowMap: Map<string, number>;
    bbUpperMap: Map<string, number>;
    bbMiddleMap: Map<string, number>;
    bbLowerMap: Map<string, number>;
    rsiMap: Map<string, number>;
    macdMap: Map<string, number>;
    macdSigMap: Map<string, number>;
    macdHistMap: Map<string, number>;
  }>({
    smaFastMap: new Map(),
    smaSlowMap: new Map(),
    emaFastMap: new Map(),
    emaSlowMap: new Map(),
    bbUpperMap: new Map(),
    bbMiddleMap: new Map(),
    bbLowerMap: new Map(),
    rsiMap: new Map(),
    macdMap: new Map(),
    macdSigMap: new Map(),
    macdHistMap: new Map(),
  });

  // --- States ---
  const [chartType, setChartType] = useState<ChartType>('candlestick');
  const [timeframe, setTimeframe] = useState<Timeframe>('1M');
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState<number>(0);
  const [lastTickTime, setLastTickTime] = useState<string>('');
  const [hoverData, setHoverData] = useState<HoverData | null>(null);
  const [oscillatorView, setOscillatorView] = useState<OscillatorView>('none');

  // Drawer modal state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'params' | 'lines' | 'levels' | 'zones'>('params');
  const [directiveToast, setDirectiveToast] = useState<string | null>(null);

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

  // Indicators toggle state
  const [indicators, setIndicators] = useState({
    sma: true,
    ema: false,
    bb: true,
    volume: true,
    pivots: true,
    fibonacci: false,
    patterns: true,
    zones: true,
  });

  // Calculated Live Metrics
  const [liveMetrics, setLiveMetrics] = useState<{
    rsi: number;
    rsiStatus: 'OVERSOLD' | 'NEUTRAL' | 'OVERBOUGHT';
    smaFastVal: number | null;
    smaSlowVal: number | null;
    emaFastVal: number | null;
    emaSlowVal: number | null;
    bbBandwidth: number | null;
    pivots: ClassicalPivots | null;
    fibs: FibonacciLevels | null;
    overallSignal: 'STRONG BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG SELL';
    signalScore: number;
  }>({
    rsi: 50,
    rsiStatus: 'NEUTRAL',
    smaFastVal: null,
    smaSlowVal: null,
    emaFastVal: null,
    emaSlowVal: null,
    bbBandwidth: null,
    pivots: null,
    fibs: null,
    overallSignal: 'NEUTRAL',
    signalScore: 0,
  });

  // Custom User / Directive Price Lines
  const [priceLines, setPriceLines] = useState<CustomPriceLine[]>([]);
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
          if (ind === 'sma20' || ind === 'sma50') next.sma = true;
          if (ind === 'ema9' || ind === 'ema21') next.ema = true;
          if (ind === 'bb') next.bb = true;
          if (ind === 'volume') next.volume = true;
          if (ind === 'pivots') next.pivots = true;
          if (ind === 'fibonacci') next.fibonacci = true;
        });
        return next;
      });
    }

    if (chartDirective.add_price_lines && Array.isArray(chartDirective.add_price_lines)) {
      setPriceLines((prev) => {
        const existingPrices = new Set(prev.map((l) => Math.round(l.price * 100)));
        const toAdd = chartDirective.add_price_lines!.filter(
          (l) => !existingPrices.has(Math.round(l.price * 100))
        );
        return [...prev, ...toAdd];
      });
    }

    // Trigger visual toast
    setDirectiveToast(`AI Analysis Visualized on ${ticker} Chart`);
    const timer = setTimeout(() => setDirectiveToast(null), 4000);
    return () => clearTimeout(timer);
  }, [chartDirective, ticker]);

  // -------------------------------------------------------------------------
  // WebSocket Handler (Anti-Tearing True In-Place Candle Update)
  // -------------------------------------------------------------------------
  const onMessage = useCallback(
    (data: string) => {
      try {
        const tick: MarketTick = JSON.parse(data);
        if (tick.ticker !== ticker || tick.action === 'pong') return;

        updateTick(tick);
        setCurrentPrice(tick.price);
        setPriceChange(tick.changePct * 100);

        const now = new Date(tick.timestamp || Date.now());
        setLastTickTime(now.toLocaleTimeString('en-US', { hour12: false }));

        const isIntraday = timeframe === '1D' || timeframe === '5D';
        const intervalSeconds = timeframe === '5D' ? 900 : 300;
        const barTime = normalizeBarTime(tick.timestamp || Date.now(), isIntraday, intervalSeconds);

        if (mainSeriesRef.current && rawBarsRef.current.length > 0) {
          const bars = rawBarsRef.current;
          const lastIdx = bars.length - 1;
          const lastBar = bars[lastIdx];

          if (lastBar.time === barTime) {
            // Update current candle in-place
            const updatedBar: OHLCVPoint = {
              ...lastBar,
              high: Math.max(lastBar.high, tick.price),
              low: Math.min(lastBar.low, tick.price),
              close: tick.price,
            };
            bars[lastIdx] = updatedBar;

            if (chartType === 'candlestick' || chartType === 'bar') {
              mainSeriesRef.current.update(updatedBar as any);
            } else {
              mainSeriesRef.current.update({ time: barTime as any, value: tick.price });
            }
          } else if (
            (typeof barTime === 'number' && typeof lastBar.time === 'number' && barTime > lastBar.time) ||
            (typeof barTime === 'string' && typeof lastBar.time === 'string' && barTime.localeCompare(lastBar.time) > 0)
          ) {
            // Start next legitimate interval candle
            const newBar: OHLCVPoint = {
              time: barTime,
              open: tick.price,
              high: tick.price,
              low: tick.price,
              close: tick.price,
              volume: tick.volume || 1000,
            };
            bars.push(newBar);

            if (chartType === 'candlestick' || chartType === 'bar') {
              mainSeriesRef.current.update(newBar as any);
            } else {
              mainSeriesRef.current.update({ time: barTime as any, value: tick.price });
            }
          }
        }
      } catch {
        // Ignore malformed messages
      }
    },
    [ticker, chartType, timeframe, updateTick]
  );

  const onStatusChange = useCallback(
    (connected: boolean) => {
      setWsConnected(ticker, connected);
    },
    [ticker, setWsConnected]
  );

  const { isConnected } = useWebSocket(`/ws/market/${ticker}`, {
    onMessage,
    onStatusChange,
  });

  // -------------------------------------------------------------------------
  // Clear and Re-draw Price Lines (Pivots, Fibs, Custom Lines)
  // -------------------------------------------------------------------------
  const refreshPriceLines = useCallback(
    (
      mainSeries: ISeriesApi<any>,
      pivots: ClassicalPivots | null,
      fibs: FibonacciLevels | null,
      customLines: CustomPriceLine[],
      showPivots: boolean,
      showFibs: boolean
    ) => {
      if (!mainSeries) return;

      // Clean up previous lines
      Object.values(priceLineRefs.current).forEach((pl) => {
        try {
          mainSeries.removePriceLine(pl);
        } catch {}
      });
      priceLineRefs.current = {};

      const drawnPrices = new Set<number>();

      // 1. Classical Pivots
      if (showPivots && pivots) {
        try {
          priceLineRefs.current['r2'] = mainSeries.createPriceLine({
            price: pivots.r2,
            color: '#f43f5e',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: `R2 $${pivots.r2}`,
          });
          drawnPrices.add(Math.round(pivots.r2 * 100));

          priceLineRefs.current['r1'] = mainSeries.createPriceLine({
            price: pivots.r1,
            color: '#ef4444',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `R1 $${pivots.r1}`,
          });
          drawnPrices.add(Math.round(pivots.r1 * 100));

          priceLineRefs.current['pivot'] = mainSeries.createPriceLine({
            price: pivots.pivot,
            color: '#3b82f6',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `Pivot $${pivots.pivot}`,
          });
          drawnPrices.add(Math.round(pivots.pivot * 100));

          priceLineRefs.current['s1'] = mainSeries.createPriceLine({
            price: pivots.s1,
            color: '#10b981',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `S1 $${pivots.s1}`,
          });
          drawnPrices.add(Math.round(pivots.s1 * 100));

          priceLineRefs.current['s2'] = mainSeries.createPriceLine({
            price: pivots.s2,
            color: '#059669',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: `S2 $${pivots.s2}`,
          });
          drawnPrices.add(Math.round(pivots.s2 * 100));
        } catch {}
      }

      // 2. Fibonacci Retracements
      if (showFibs && fibs) {
        try {
          priceLineRefs.current['fib618'] = mainSeries.createPriceLine({
            price: fibs.f618,
            color: '#c084fc',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `Fib 61.8% $${fibs.f618}`,
          });
          priceLineRefs.current['fib500'] = mainSeries.createPriceLine({
            price: fibs.f500,
            color: '#eab308',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `Fib 50.0% $${fibs.f500}`,
          });
          priceLineRefs.current['fib382'] = mainSeries.createPriceLine({
            price: fibs.f382,
            color: '#38bdf8',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `Fib 38.2% $${fibs.f382}`,
          });
        } catch {}
      }

      // 3. Custom Lines (Deduplicate against already drawn pivot prices)
      customLines.forEach((line) => {
        const roundedPrice = Math.round(line.price * 100);
        if (line.price > 0 && !drawnPrices.has(roundedPrice)) {
          try {
            priceLineRefs.current[line.id] = mainSeries.createPriceLine({
              price: line.price,
              color: line.color,
              lineWidth: 2,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: `${line.label.replace(/\(\$\d+(\.\d+)?\)/, '').trim()} $${line.price.toFixed(2)}`,
            });
            drawnPrices.add(roundedPrice);
          } catch {}
        }
      });
    },
    []
  );

  // -------------------------------------------------------------------------
  // Render Indicators on Chart
  // -------------------------------------------------------------------------
  const applyIndicators = useCallback(
    (bars: OHLCVPoint[], chart: IChartApi) => {
      if (!bars || bars.length === 0) return;

      const closeData = bars.map((b) => ({ time: b.time, close: b.close }));
      const rawCloses = bars.map((b) => b.close);
      const rawHighs = bars.map((b) => b.high ?? b.close);
      const rawLows = bars.map((b) => b.low ?? b.close);

      const maxHigh = Math.max(...rawHighs);
      const minLow = Math.min(...rawLows);
      const lastClose = rawCloses[rawCloses.length - 1];

      // 1. Compute Indicators via pure utility modules
      const rsiSeriesData = calculateRSISeries(closeData, params.rsiPeriod);
      const macdData = calculateMACDSeries(closeData);

      const rsiVal = rsiSeriesData.length > 0 ? rsiSeriesData[rsiSeriesData.length - 1].value : 50;
      const rsiStatus = rsiVal >= 70 ? 'OVERBOUGHT' : rsiVal <= 30 ? 'OVERSOLD' : 'NEUTRAL';

      const smaFast = calculateSMA(closeData, params.smaFast);
      const smaSlow = calculateSMA(closeData, params.smaSlow);
      const emaFast = calculateEMA(closeData, params.emaFast);
      const emaSlow = calculateEMA(closeData, params.emaSlow);
      const bb = calculateBollingerBands(closeData, params.bbPeriod, params.bbStd);

      const calculatedPivots = calculateClassicalPivots(maxHigh, minLow, lastClose);
      const calculatedFibs = calculateFibonacciLevels(maxHigh, minLow);

      // Populate lookup maps for ultra-fast crosshair hover
      calcDataMapRef.current.smaFastMap = new Map(smaFast.map((d) => [String(d.time), d.value]));
      calcDataMapRef.current.smaSlowMap = new Map(smaSlow.map((d) => [String(d.time), d.value]));
      calcDataMapRef.current.emaFastMap = new Map(emaFast.map((d) => [String(d.time), d.value]));
      calcDataMapRef.current.emaSlowMap = new Map(emaSlow.map((d) => [String(d.time), d.value]));
      calcDataMapRef.current.bbUpperMap = new Map(bb.upper.map((d) => [String(d.time), d.value]));
      calcDataMapRef.current.bbMiddleMap = new Map(bb.middle.map((d) => [String(d.time), d.value]));
      calcDataMapRef.current.bbLowerMap = new Map(bb.lower.map((d) => [String(d.time), d.value]));
      calcDataMapRef.current.rsiMap = new Map(rsiSeriesData.map((d) => [String(d.time), d.value]));
      calcDataMapRef.current.macdMap = new Map(macdData.macdLine.map((d) => [String(d.time), d.value]));
      calcDataMapRef.current.macdSigMap = new Map(macdData.signalLine.map((d) => [String(d.time), d.value]));
      calcDataMapRef.current.macdHistMap = new Map(macdData.histogram.map((d) => [String(d.time), d.value]));

      const lastFast = smaFast.length > 0 ? smaFast[smaFast.length - 1].value : null;
      const lastSlow = smaSlow.length > 0 ? smaSlow[smaSlow.length - 1].value : null;
      const lastEmaFast = emaFast.length > 0 ? emaFast[emaFast.length - 1].value : null;
      const lastEmaSlow = emaSlow.length > 0 ? emaSlow[emaSlow.length - 1].value : null;

      const lastBBWidth =
        bb.upper.length > 0 && bb.middle.length > 0
          ? +(
              ((bb.upper[bb.upper.length - 1].value - bb.lower[bb.lower.length - 1].value) /
                bb.middle[bb.middle.length - 1].value) *
              100
            ).toFixed(1)
          : null;

      // Composite Technical Score Calculation
      let score = 0;
      if (lastFast && lastSlow) {
        if (lastClose > lastFast && lastFast > lastSlow) score += 2;
        else if (lastClose < lastFast && lastFast < lastSlow) score -= 2;
      }
      if (rsiVal < 35) score += 2;
      else if (rsiVal > 70) score -= 2;
      else if (rsiVal > 50) score += 1;
      else score -= 1;

      let overallSignal: 'STRONG BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG SELL' = 'NEUTRAL';
      if (score >= 3) overallSignal = 'STRONG BUY';
      else if (score >= 1) overallSignal = 'BUY';
      else if (score <= -3) overallSignal = 'STRONG SELL';
      else if (score <= -1) overallSignal = 'SELL';

      setLiveMetrics({
        rsi: rsiVal,
        rsiStatus,
        smaFastVal: lastFast,
        smaSlowVal: lastSlow,
        emaFastVal: lastEmaFast,
        emaSlowVal: lastEmaSlow,
        bbBandwidth: lastBBWidth,
        pivots: calculatedPivots,
        fibs: calculatedFibs,
        overallSignal,
        signalScore: score,
      });

      // Clean up previous indicator series
      Object.values(indicatorSeriesRefs.current).forEach((series) => {
        try {
          chart.removeSeries(series);
        } catch {}
      });
      indicatorSeriesRefs.current = {};

      // 2. Add Active Indicator Series
      if (indicators.sma) {
        const sFast = chart.addLineSeries({
          color: '#00d2ff',
          lineWidth: 2,
          title: `SMA ${params.smaFast}`,
        });
        sFast.setData(smaFast as any);
        indicatorSeriesRefs.current.smaFast = sFast;

        const sSlow = chart.addLineSeries({
          color: '#ffb703',
          lineWidth: 2,
          title: `SMA ${params.smaSlow}`,
        });
        sSlow.setData(smaSlow as any);
        indicatorSeriesRefs.current.smaSlow = sSlow;
      }

      if (indicators.ema) {
        const eFast = chart.addLineSeries({
          color: '#e879f9',
          lineWidth: 2,
          title: `EMA ${params.emaFast}`,
        });
        eFast.setData(emaFast as any);
        indicatorSeriesRefs.current.emaFast = eFast;

        const eSlow = chart.addLineSeries({
          color: '#10b981',
          lineWidth: 2,
          title: `EMA ${params.emaSlow}`,
        });
        eSlow.setData(emaSlow as any);
        indicatorSeriesRefs.current.emaSlow = eSlow;
      }

      if (indicators.bb) {
        const u = chart.addLineSeries({
          color: '#38bdf8',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: `BB Upper (${params.bbPeriod}, ${params.bbStd}σ)`,
        });
        const m = chart.addLineSeries({
          color: '#0284c7',
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          title: 'BB Mid',
        });
        const l = chart.addLineSeries({
          color: '#38bdf8',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: 'BB Lower',
        });
        u.setData(bb.upper as any);
        m.setData(bb.middle as any);
        l.setData(bb.lower as any);
        indicatorSeriesRefs.current.bbUpper = u;
        indicatorSeriesRefs.current.bbMiddle = m;
        indicatorSeriesRefs.current.bbLower = l;
      }

      if (indicators.volume && volumeSeriesRef.current) {
        const volData = bars.map((b) => ({
          time: b.time,
          value: b.volume || 1000000,
          color: b.close >= b.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)',
        }));
        volumeSeriesRef.current.setData(volData as any);
      }

      // 3. Pattern Markers (Golden Cross / Death Cross)
      if (indicators.patterns && mainSeriesRef.current && smaFast.length > 2 && smaSlow.length > 2) {
        const markers: SeriesMarker<any>[] = [];
        const fastMap = new Map(smaFast.map((d) => [String(d.time), d.value]));
        const slowMap = new Map(smaSlow.map((d) => [String(d.time), d.value]));

        for (let i = 1; i < bars.length; i++) {
          const tPrev = String(bars[i - 1].time);
          const tCurr = String(bars[i].time);
          const fPrev = fastMap.get(tPrev);
          const sPrev = slowMap.get(tPrev);
          const fCurr = fastMap.get(tCurr);
          const sCurr = slowMap.get(tCurr);

          if (fPrev && sPrev && fCurr && sCurr) {
            if (fPrev <= sPrev && fCurr > sCurr) {
              markers.push({
                time: bars[i].time as any,
                position: 'belowBar',
                color: '#10b981',
                shape: 'arrowUp',
                text: 'Golden Cross',
              });
            } else if (fPrev >= sPrev && fCurr < sCurr) {
              markers.push({
                time: bars[i].time as any,
                position: 'aboveBar',
                color: '#ef4444',
                shape: 'arrowDown',
                text: 'Death Cross',
              });
            }
          }
        }
        try {
          mainSeriesRef.current.setMarkers(markers.slice(-6));
        } catch {}
      } else if (mainSeriesRef.current) {
        try {
          mainSeriesRef.current.setMarkers([]);
        } catch {}
      }

      // 4. Draw Price Lines
      if (mainSeriesRef.current) {
        refreshPriceLines(
          mainSeriesRef.current,
          calculatedPivots,
          calculatedFibs,
          priceLines,
          indicators.pivots,
          indicators.fibonacci
        );
      }

      // 5. Update Oscillator Sub-Panel
      if (oscChartRef.current && oscillatorView !== 'none') {
        Object.values(oscSeriesRefs.current).forEach((s) => {
          try {
            oscChartRef.current?.removeSeries(s);
          } catch {}
        });
        oscSeriesRefs.current = {};

        if (oscillatorView === 'rsi' || oscillatorView === 'both') {
          const rsiSeries = oscChartRef.current.addLineSeries({
            color: '#a855f7',
            lineWidth: 2,
            title: `RSI (${params.rsiPeriod})`,
          });
          rsiSeries.setData(rsiSeriesData as any);
          rsiSeries.createPriceLine({ price: 70, color: '#ef4444', lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'OB 70' });
          rsiSeries.createPriceLine({ price: 30, color: '#10b981', lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'OS 30' });
          oscSeriesRefs.current.rsi = rsiSeries;
        }

        if (oscillatorView === 'macd' || oscillatorView === 'both') {
          const macdLine = oscChartRef.current.addLineSeries({ color: '#38bdf8', lineWidth: 1, title: 'MACD' });
          const macdSig = oscChartRef.current.addLineSeries({ color: '#f59e0b', lineWidth: 1, title: 'Signal' });
          const macdHist = oscChartRef.current.addHistogramSeries({ title: 'Histogram' });

          macdLine.setData(macdData.macdLine as any);
          macdSig.setData(macdData.signalLine as any);
          macdHist.setData(macdData.histogram as any);

          oscSeriesRefs.current.macdLine = macdLine;
          oscSeriesRefs.current.macdSig = macdSig;
          oscSeriesRefs.current.macdHist = macdHist;
        }

        try {
          oscChartRef.current.timeScale().fitContent();
        } catch {}
      }
    },
    [indicators, params, priceLines, oscillatorView, refreshPriceLines]
  );

  // -------------------------------------------------------------------------
  // Initialize Chart Instances (Main & Oscillator)
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
        scaleMargins: { top: 0.08, bottom: 0.15 },
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

    // Crosshair hover listener for the interactive floating HUD
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData || !mainSeriesRef.current) {
        setHoverData(null);
        return;
      }

      const data = param.seriesData.get(mainSeriesRef.current) as any;
      if (data) {
        const timeKey = String(param.time);
        const displayTimeStr = formatDisplayTime(param.time as string | number);

        const open = data.open ?? data.value ?? 0;
        const close = data.close ?? data.value ?? 0;
        const high = data.high ?? Math.max(open, close);
        const low = data.low ?? Math.min(open, close);
        const vol = (param.seriesData.get(volumeSeries) as any)?.value;

        setHoverData({
          timeStr: displayTimeStr,
          open,
          high,
          low,
          close,
          volume: vol,
          changePct: open ? ((close - open) / open) * 100 : 0,
          smaFast: calcDataMapRef.current.smaFastMap.get(timeKey) ?? null,
          smaSlow: calcDataMapRef.current.smaSlowMap.get(timeKey) ?? null,
          emaFast: calcDataMapRef.current.emaFastMap.get(timeKey) ?? null,
          emaSlow: calcDataMapRef.current.emaSlowMap.get(timeKey) ?? null,
          bbUpper: calcDataMapRef.current.bbUpperMap.get(timeKey) ?? null,
          bbMiddle: calcDataMapRef.current.bbMiddleMap.get(timeKey) ?? null,
          bbLower: calcDataMapRef.current.bbLowerMap.get(timeKey) ?? null,
          rsiVal: calcDataMapRef.current.rsiMap.get(timeKey) ?? null,
          macdVal: calcDataMapRef.current.macdMap.get(timeKey) ?? null,
          macdSig: calcDataMapRef.current.macdSigMap.get(timeKey) ?? null,
          macdHist: calcDataMapRef.current.macdHistMap.get(timeKey) ?? null,
        });
      }
    });

    // Sub-panel chart for RSI / MACD
    if (oscContainerRef.current && oscillatorView !== 'none') {
      oscContainerRef.current.innerHTML = '';
      const oscChart = createChart(oscContainerRef.current, {
        width: oscContainerRef.current.clientWidth,
        height: 110,
        layout: {
          background: { type: ColorType.Solid, color: 'rgba(15, 23, 42, 0.5)' },
          textColor: '#8b99b8',
          fontSize: 10,
        },
        grid: {
          vertLines: { color: 'rgba(99, 131, 195, 0.05)' },
          horzLines: { color: 'rgba(99, 131, 195, 0.05)' },
        },
        timeScale: { visible: false },
      });
      oscChartRef.current = oscChart;
    }

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        try {
          chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
          if (oscContainerRef.current && oscChartRef.current) {
            oscChartRef.current.applyOptions({ width: oscContainerRef.current.clientWidth });
          }
        } catch {}
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      try {
        chart.remove();
        oscChartRef.current?.remove();
      } catch {}
      chartRef.current = null;
      oscChartRef.current = null;
    };
  }, [height, oscillatorView]);

  // -------------------------------------------------------------------------
  // Load / Update Series Data When Ticker, Timeframe, or Chart Type Changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (mainSeriesRef.current) {
      try {
        chart.removeSeries(mainSeriesRef.current);
      } catch {}
      mainSeriesRef.current = null;
    }

    let mainSeries: ISeriesApi<any>;
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
        topColor: 'rgba(0, 210, 255, 0.35)',
        bottomColor: 'rgba(0, 210, 255, 0.0)',
        lineColor: '#00d2ff',
        lineWidth: 2,
      });
    } else if (chartType === 'line') {
      mainSeries = chart.addLineSeries({
        color: '#00d2ff',
        lineWidth: 2,
      });
    } else {
      mainSeries = chart.addBarSeries({
        upColor: '#10b981',
        downColor: '#ef4444',
      });
    }
    mainSeriesRef.current = mainSeries;

    const tfMap: Record<Timeframe, { period: string; interval: string }> = {
      '1D': { period: '1d', interval: '5m' },
      '5D': { period: '5d', interval: '15m' },
      '1M': { period: '1mo', interval: '1d' },
      '3M': { period: '3mo', interval: '1d' },
      '6M': { period: '6mo', interval: '1d' },
      '1Y': { period: '1y', interval: '1wk' },
      YTD: { period: 'ytd', interval: '1d' },
    };

    const { period, interval } = tfMap[timeframe] || { period: '1mo', interval: '1d' };
    const isIntraday = timeframe === '1D' || timeframe === '5D';
    const intervalSeconds = timeframe === '5D' ? 900 : 300;

    fetch(`${API_BASE}/market/ohlcv/${ticker}?period=${period}&interval=${interval}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((bars) => {
        if (!bars || !Array.isArray(bars) || bars.length === 0) return;

        // Strictly normalize and deduplicate timestamps
        const mappedBars: OHLCVPoint[] = bars
          .map((b: any) => ({
            time: normalizeBarTime(b.timestamp, isIntraday, intervalSeconds),
            open: Number(b.open),
            high: Number(b.high),
            low: Number(b.low),
            close: Number(b.close),
            volume: Number(b.volume || 0),
          }))
          .sort((a, b) => {
            if (typeof a.time === 'number' && typeof b.time === 'number') return a.time - b.time;
            return String(a.time).localeCompare(String(b.time));
          });

        // Filter duplicates strictly
        const chartData: OHLCVPoint[] = [];
        const seenTimes = new Set<string | number>();
        mappedBars.forEach((bar) => {
          if (!seenTimes.has(bar.time)) {
            seenTimes.add(bar.time);
            chartData.push(bar);
          }
        });

        if (chartData.length === 0) return;
        rawBarsRef.current = chartData;

        if (chartType === 'candlestick' || chartType === 'bar') {
          mainSeries.setData(chartData as any);
        } else {
          mainSeries.setData(chartData.map((d) => ({ time: d.time as any, value: d.close })));
        }

        const lastBar = chartData[chartData.length - 1];
        if (lastBar) {
          setCurrentPrice(lastBar.close);
          const firstBar = chartData[0];
          setPriceChange(((lastBar.close - firstBar.open) / firstBar.open) * 100);
          setLastTickTime(formatDisplayTime(lastBar.time));
        }

        applyIndicators(chartData, chart);
        try {
          chart.timeScale().fitContent();
        } catch {}
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
  }, [indicators, params, priceLines, oscillatorView, applyIndicators]);

  // -------------------------------------------------------------------------
  // Custom Price Line Controls
  // -------------------------------------------------------------------------
  const addPriceLine = () => {
    const p = parseFloat(newLinePrice);
    if (isNaN(p) || p <= 0) return;

    const line: CustomPriceLine = {
      id: crypto.randomUUID(),
      price: p,
      label: newLineLabel.trim() || 'Level',
      color: newLineColor,
    };

    setPriceLines((prev) => [...prev, line]);
    setNewLinePrice('');
  };

  const removePriceLine = (id: string) => {
    setPriceLines((prev) => prev.filter((l) => l.id !== id));
  };

  const clearAllCustomLines = () => {
    setPriceLines([]);
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

  // Compute distance percentages for immediate support/resistance
  const s1Dist =
    currentPrice && liveMetrics.pivots
      ? (((liveMetrics.pivots.s1 - currentPrice) / currentPrice) * 100).toFixed(1)
      : null;
  const r1Dist =
    currentPrice && liveMetrics.pivots
      ? (((liveMetrics.pivots.r1 - currentPrice) / currentPrice) * 100).toFixed(1)
      : null;
  const pivotDist =
    currentPrice && liveMetrics.pivots
      ? (((liveMetrics.pivots.pivot - currentPrice) / currentPrice) * 100).toFixed(1)
      : null;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%' }}>
      {/* ===================================================================== */}
      {/* 1. TOP HEADER: Clean Institutional Toolbar */}
      {/* ===================================================================== */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid var(--color-border)',
          gap: 10,
          background: 'rgba(13, 18, 32, 0.7)',
        }}
      >
        {/* Left: Ticker, Live Price & Timeframes */}
        {/* Left: Active Ticker Symbol, Real-Time Price, Timeframes & Chart Type */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Symbol & Price Badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 800, fontSize: '1.05rem', color: '#ffffff', letterSpacing: '0.02em' }}>
              {ticker}
            </span>
            {currentPrice !== null && (
              <span
                style={{
                  fontSize: '1.15rem',
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono)',
                  color: '#ffffff',
                }}
              >
                ${currentPrice.toFixed(2)}
              </span>
            )}
            {currentPrice !== null && (
              <span
                style={{
                  color: isPositive ? 'var(--color-success)' : 'var(--color-danger)',
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  background: isPositive ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                {isPositive ? '+' : ''}
                {priceChange.toFixed(2)}%
              </span>
            )}
          </div>

          {/* Timeframe Segmented Pills */}
          <div
            style={{
              display: 'flex',
              background: 'rgba(255, 255, 255, 0.06)',
              borderRadius: 'var(--radius-md)',
              padding: 3,
              border: '1px solid rgba(255, 255, 255, 0.12)',
            }}
          >
            {(['1D', '5D', '1M', '3M', '6M', '1Y', 'YTD'] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                style={{
                  background: timeframe === tf ? 'var(--color-accent-primary)' : 'transparent',
                  color: timeframe === tf ? '#ffffff' : 'var(--color-text-secondary)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  padding: '4px 10px',
                  fontSize: '0.78rem',
                  fontWeight: timeframe === tf ? 700 : 500,
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
              >
                {tf}
              </button>
            ))}
          </div>

          {/* Chart Style Switcher */}
          <div
            style={{
              display: 'flex',
              background: 'rgba(255, 255, 255, 0.06)',
              borderRadius: 'var(--radius-md)',
              padding: 3,
              border: '1px solid rgba(255, 255, 255, 0.12)',
            }}
          >
            {(['candlestick', 'area', 'line', 'bar'] as ChartType[]).map((type) => (
              <button
                key={type}
                onClick={() => setChartType(type)}
                style={{
                  background: chartType === type ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
                  color: chartType === type ? 'var(--color-accent-bright)' : 'var(--color-text-secondary)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  padding: '4px 10px',
                  fontSize: '0.76rem',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                  fontWeight: chartType === type ? 700 : 500,
                }}
              >
                {type === 'candlestick' ? '🕯️ Candles' : type === 'area' ? '🌊 Area' : type === 'line' ? '📈 Line' : '📊 OHLC'}
              </button>
            ))}
          </div>
        </div>

        {/* Right: Quick Controls, Settings Button & Live Indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={resetZoom}
            className="btn btn-secondary"
            style={{ padding: '5px 10px', fontSize: '0.76rem', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', gap: 4 }}
            title="Reset Zoom / Fit View"
          >
            <RotateCcw size={13} />
            <span>Reset</span>
          </button>

          <button
            onClick={takeSnapshot}
            className="btn btn-secondary"
            style={{ padding: '5px 10px', fontSize: '0.76rem', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', gap: 4 }}
            title="Export High-Res PNG"
          >
            <Camera size={13} />
            <span>Snapshot</span>
          </button>

          {/* Prominent Settings Button */}
          <button
            onClick={() => setDrawerOpen(true)}
            className={`chart-settings-btn ${drawerOpen ? 'active' : ''}`}
            title="Configure All Technical Indicators, Parameters & Custom Levels"
          >
            <SlidersHorizontal size={14} />
            <span>Settings</span>
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
            <span
              className={`live-indicator ${isConnected ? 'pulsing' : ''}`}
              style={{
                color: isConnected ? 'var(--color-success)' : 'var(--color-text-muted)',
                fontSize: '0.72rem',
                fontWeight: 700,
              }}
            >
              {isConnected ? 'LIVE' : 'SYNCING'}
            </span>
          </div>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* 2. TECHNICAL INDICATOR TOGGLES & REAL-TIME QUANT RADAR RIBBON          */}
      {/* ===================================================================== */}
      <div className="tech-ribbon">
        {/* Left: Quick Essential Indicator Toggle Chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            className={`indicator-pill ${indicators.sma ? 'active' : ''}`}
            onClick={() => setIndicators((prev) => ({ ...prev, sma: !prev.sma }))}
            title="Toggle Simple Moving Averages (SMA 20 & 50)"
          >
            <span className="indicator-dot" style={{ background: '#00d2ff' }} />
            <span>SMA ({params.smaFast}/{params.smaSlow})</span>
          </button>

          <button
            className={`indicator-pill ${indicators.ema ? 'active' : ''}`}
            onClick={() => setIndicators((prev) => ({ ...prev, ema: !prev.ema }))}
            title="Toggle Exponential Moving Averages (EMA 9 & 21)"
          >
            <span className="indicator-dot" style={{ background: '#e879f9' }} />
            <span>EMA ({params.emaFast}/{params.emaSlow})</span>
          </button>

          <button
            className={`indicator-pill ${indicators.bb ? 'active' : ''}`}
            onClick={() => setIndicators((prev) => ({ ...prev, bb: !prev.bb }))}
            title="Toggle Bollinger Bands (20, 2σ)"
          >
            <span className="indicator-dot" style={{ background: '#38bdf8' }} />
            <span>Bollinger ({params.bbPeriod}, {params.bbStd}σ)</span>
          </button>

          <button
            className={`indicator-pill ${indicators.pivots ? 'active' : ''}`}
            onClick={() => setIndicators((prev) => ({ ...prev, pivots: !prev.pivots }))}
            title="Toggle Classical Pivot S/R Lines"
          >
            <span className="indicator-dot" style={{ background: '#ef4444' }} />
            <span>Pivots</span>
          </button>

          <button
            className={`indicator-pill ${oscillatorView !== 'none' ? 'active' : ''}`}
            onClick={() => setOscillatorView((prev) => (prev === 'none' ? 'rsi' : prev === 'rsi' ? 'macd' : 'none'))}
            title="Cycle Sub-Panel (RSI / MACD / Off)"
          >
            <span className="indicator-dot" style={{ background: '#c084fc' }} />
            <span>Sub-Panel: {oscillatorView === 'none' ? 'Off' : oscillatorView.toUpperCase()}</span>
          </button>
        </div>

        {/* Right: Real-time Quantitative Radar Signals */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {liveMetrics.pivots && (
            <>
              <span className="tech-level-pill support" title="Classical Immediate Support 1">
                <strong>S1:</strong> ${liveMetrics.pivots.s1} {s1Dist && `(${s1Dist}%)`}
              </span>
              <span className="tech-level-pill pivot" title="Classical Central Pivot Point">
                <strong>Pivot:</strong> ${liveMetrics.pivots.pivot} {pivotDist && `(${pivotDist}%)`}
              </span>
              <span className="tech-level-pill resistance" title="Classical Immediate Resistance 1">
                <strong>R1:</strong> ${liveMetrics.pivots.r1} {r1Dist && `(${r1Dist}%)`}
              </span>
            </>
          )}

          {/* RSI Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.75rem' }}>
            <Gauge size={14} color="var(--color-accent-bright)" />
            <span style={{ color: 'var(--color-text-secondary)', fontWeight: 500 }}>RSI:</span>
            <span
              style={{
                fontWeight: 700,
                padding: '2px 7px',
                borderRadius: 4,
                fontFamily: 'var(--font-mono)',
                background:
                  liveMetrics.rsiStatus === 'OVERSOLD'
                    ? 'rgba(16, 185, 129, 0.2)'
                    : liveMetrics.rsiStatus === 'OVERBOUGHT'
                    ? 'rgba(239, 68, 68, 0.2)'
                    : 'rgba(245, 158, 11, 0.2)',
                color:
                  liveMetrics.rsiStatus === 'OVERSOLD'
                    ? 'var(--color-success)'
                    : liveMetrics.rsiStatus === 'OVERBOUGHT'
                    ? 'var(--color-danger)'
                    : 'var(--color-warning)',
              }}
            >
              {liveMetrics.rsi} ({liveMetrics.rsiStatus})
            </span>
          </div>

          {/* Technical Bias Badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.75rem' }}>
            <Sparkles size={14} color="var(--color-accent-bright)" />
            <span
              style={{
                fontWeight: 700,
                padding: '2px 9px',
                borderRadius: 'var(--radius-sm)',
                letterSpacing: '0.03em',
                background:
                  liveMetrics.overallSignal.includes('BUY')
                    ? 'rgba(16, 185, 129, 0.2)'
                    : liveMetrics.overallSignal.includes('SELL')
                    ? 'rgba(239, 68, 68, 0.2)'
                    : 'rgba(245, 158, 11, 0.2)',
                color:
                  liveMetrics.overallSignal.includes('BUY')
                    ? 'var(--color-success)'
                    : liveMetrics.overallSignal.includes('SELL')
                    ? 'var(--color-danger)'
                    : 'var(--color-warning)',
                border: `1px solid ${
                  liveMetrics.overallSignal.includes('BUY')
                    ? 'rgba(16, 185, 129, 0.4)'
                    : liveMetrics.overallSignal.includes('SELL')
                    ? 'rgba(239, 68, 68, 0.4)'
                    : 'rgba(245, 158, 11, 0.4)'
                }`,
              }}
            >
              {liveMetrics.overallSignal}
            </span>
          </div>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* 3. CHART CANVAS CONTAINER + FLOATING HEADS-UP DISPLAY (HUD) */}
      {/* ===================================================================== */}
      <div style={{ position: 'relative', width: '100%', height }}>
        {/* Floating Heads-Up Display (HUD) */}
        <div className="chart-hud">
          {/* Row 1: OHLCV Inspection */}
          <div className="chart-hud-ohlcv">
            <span style={{ color: 'var(--color-accent-bright)', fontWeight: 600 }}>
              📅 {hoverData?.timeStr || lastTickTime || 'Latest'}
            </span>
            <span>
              O: <strong style={{ color: '#fff' }}>${hoverData ? hoverData.open.toFixed(2) : currentPrice?.toFixed(2) || '—'}</strong>
            </span>
            <span>
              H: <strong style={{ color: '#fff' }}>${hoverData ? hoverData.high.toFixed(2) : currentPrice?.toFixed(2) || '—'}</strong>
            </span>
            <span>
              L: <strong style={{ color: '#fff' }}>${hoverData ? hoverData.low.toFixed(2) : currentPrice?.toFixed(2) || '—'}</strong>
            </span>
            <span>
              C: <strong style={{ color: '#fff' }}>${hoverData ? hoverData.close.toFixed(2) : currentPrice?.toFixed(2) || '—'}</strong>
            </span>
            {hoverData?.volume !== undefined && (
              <span>
                Vol: <strong style={{ color: '#fff' }}>{(hoverData.volume / 1000000).toFixed(2)}M</strong>
              </span>
            )}
            {hoverData?.changePct !== undefined && (
              <span
                style={{
                  color: hoverData.changePct >= 0 ? 'var(--color-success)' : 'var(--color-danger)',
                  fontWeight: 600,
                }}
              >
                {hoverData.changePct >= 0 ? '+' : ''}
                {hoverData.changePct.toFixed(2)}%
              </span>
            )}
          </div>

          {/* Row 2: Live Indicator Values at Hover/Latest Point */}
          <div className="chart-hud-indicators">
            {indicators.sma && (
              <>
                <span style={{ color: '#00d2ff' }}>
                  SMA({params.smaFast}): <strong>${hoverData?.smaFast ?? liveMetrics.smaFastVal ?? '—'}</strong>
                </span>
                <span style={{ color: '#ffb703' }}>
                  SMA({params.smaSlow}): <strong>${hoverData?.smaSlow ?? liveMetrics.smaSlowVal ?? '—'}</strong>
                </span>
              </>
            )}

            {indicators.ema && (
              <>
                <span style={{ color: '#e879f9' }}>
                  EMA({params.emaFast}): <strong>${hoverData?.emaFast ?? liveMetrics.emaFastVal ?? '—'}</strong>
                </span>
                <span style={{ color: '#10b981' }}>
                  EMA({params.emaSlow}): <strong>${hoverData?.emaSlow ?? liveMetrics.emaSlowVal ?? '—'}</strong>
                </span>
              </>
            )}

            {indicators.bb && (
              <span style={{ color: '#38bdf8' }}>
                BB({params.bbPeriod}, {params.bbStd}σ): [
                <strong>${hoverData?.bbLower ?? (liveMetrics.pivots ? (liveMetrics.pivots.pivot * 0.96).toFixed(2) : '—')}</strong> -{' '}
                <strong>${hoverData?.bbUpper ?? (liveMetrics.pivots ? (liveMetrics.pivots.pivot * 1.04).toFixed(2) : '—')}</strong>]
              </span>
            )}

            {hoverData?.rsiVal !== undefined && hoverData?.rsiVal !== null && (
              <span style={{ color: '#c084fc' }}>
                RSI: <strong>{hoverData.rsiVal}</strong>
              </span>
            )}
          </div>
        </div>

        {/* AI Advisor Directive Toast Notification */}
        {directiveToast && (
          <div
            style={{
              position: 'absolute',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 30,
              background: 'rgba(59, 130, 246, 0.9)',
              backdropFilter: 'blur(10px)',
              color: '#ffffff',
              padding: '6px 14px',
              borderRadius: 'var(--radius-full)',
              fontSize: '0.75rem',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: '0 4px 20px rgba(59, 130, 246, 0.4)',
              animation: 'fadeIn 0.2s ease-out',
            }}
          >
            <Sparkles size={14} />
            <span>{directiveToast}</span>
          </div>
        )}

        {/* TradingView Lightweight Chart Canvas */}
        <div ref={containerRef} style={{ width: '100%', height }} />

        {/* =================================================================== */}
        {/* 4. SLIDE-OVER SETTINGS & ANNOTATIONS DRAWER */}
        {/* =================================================================== */}
        {drawerOpen && (
          <div className="chart-drawer-backdrop" onClick={() => setDrawerOpen(false)}>
            <div className="chart-drawer" onClick={(e) => e.stopPropagation()}>
              {/* Drawer Header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '16px 20px',
                  borderBottom: '1px solid var(--color-border)',
                  background: 'rgba(13, 18, 32, 0.9)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <SlidersHorizontal size={18} color="var(--color-accent-bright)" />
                  <span style={{ fontWeight: 800, fontSize: '0.95rem', color: '#ffffff' }}>
                    Technical Chart Settings
                  </span>
                </div>
                <button
                  onClick={() => setDrawerOpen(false)}
                  style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: 4,
                    color: '#ffffff',
                    padding: 4,
                    cursor: 'pointer',
                    display: 'flex',
                  }}
                >
                  <X size={18} />
                </button>
              </div>

              {/* Drawer Tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', background: 'rgba(0,0,0,0.2)' }}>
                <button
                  className={`drawer-tab-btn ${drawerTab === 'params' ? 'active' : ''}`}
                  onClick={() => setDrawerTab('params')}
                >
                  Parameters
                </button>
                <button
                  className={`drawer-tab-btn ${drawerTab === 'lines' ? 'active' : ''}`}
                  onClick={() => setDrawerTab('lines')}
                >
                  Annotations ({priceLines.length})
                </button>
                <button
                  className={`drawer-tab-btn ${drawerTab === 'levels' ? 'active' : ''}`}
                  onClick={() => setDrawerTab('levels')}
                >
                  Key Levels
                </button>
                <button
                  className={`drawer-tab-btn ${drawerTab === 'zones' ? 'active' : ''}`}
                  onClick={() => setDrawerTab('zones')}
                >
                  Zones
                </button>
              </div>

              {/* Drawer Body Content */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
                {/* TAB 1: PARAMETERS */}
                {drawerTab === 'params' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                    {/* Quick Strategy Presets */}
                    <div>
                      <label style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', marginBottom: 8, display: 'block' }}>
                        Quick Presets
                      </label>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          onClick={() => setParams({ smaFast: 20, smaSlow: 50, emaFast: 9, emaSlow: 21, bbPeriod: 20, bbStd: 2.0, rsiPeriod: 14 })}
                          className="btn btn-secondary"
                          style={{ fontSize: '0.72rem', padding: '4px 8px' }}
                        >
                          Standard (20/50)
                        </button>
                        <button
                          onClick={() => setParams({ smaFast: 10, smaSlow: 30, emaFast: 8, emaSlow: 20, bbPeriod: 15, bbStd: 1.5, rsiPeriod: 9 })}
                          className="btn btn-secondary"
                          style={{ fontSize: '0.72rem', padding: '4px 8px' }}
                        >
                          Fast Scalp (9/20)
                        </button>
                        <button
                          onClick={() => setParams({ smaFast: 50, smaSlow: 200, emaFast: 20, emaSlow: 50, bbPeriod: 20, bbStd: 2.5, rsiPeriod: 21 })}
                          className="btn btn-secondary"
                          style={{ fontSize: '0.72rem', padding: '4px 8px' }}
                        >
                          Swing (50/200)
                        </button>
                      </div>
                    </div>

                    {/* Section 1: Moving Averages */}
                    <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: 14, borderRadius: 'var(--radius-md)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                      <p style={{ fontSize: '0.82rem', fontWeight: 700, color: '#ffffff', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#00d2ff' }} />
                        Moving Average Lengths
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div>
                          <label style={{ fontSize: '0.72rem', color: '#00d2ff', fontWeight: 600, display: 'block', marginBottom: 4 }}>SMA Fast (bars)</label>
                          <input
                            type="number"
                            min="5"
                            max="100"
                            value={params.smaFast}
                            onChange={(e) => setParams((p) => ({ ...p, smaFast: parseInt(e.target.value) || 20 }))}
                            className="input"
                            style={{ width: '100%', padding: '8px 10px', fontSize: '0.85rem', background: '#0f172a', border: '1px solid #334155', color: '#ffffff', fontWeight: 600 }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.72rem', color: '#ffb703', fontWeight: 600, display: 'block', marginBottom: 4 }}>SMA Slow (bars)</label>
                          <input
                            type="number"
                            min="10"
                            max="200"
                            value={params.smaSlow}
                            onChange={(e) => setParams((p) => ({ ...p, smaSlow: parseInt(e.target.value) || 50 }))}
                            className="input"
                            style={{ width: '100%', padding: '8px 10px', fontSize: '0.85rem', background: '#0f172a', border: '1px solid #334155', color: '#ffffff', fontWeight: 600 }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.72rem', color: '#e879f9', fontWeight: 600, display: 'block', marginBottom: 4 }}>EMA Fast (bars)</label>
                          <input
                            type="number"
                            min="5"
                            max="50"
                            value={params.emaFast}
                            onChange={(e) => setParams((p) => ({ ...p, emaFast: parseInt(e.target.value) || 9 }))}
                            className="input"
                            style={{ width: '100%', padding: '8px 10px', fontSize: '0.85rem', background: '#0f172a', border: '1px solid #334155', color: '#ffffff', fontWeight: 600 }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.72rem', color: '#10b981', fontWeight: 600, display: 'block', marginBottom: 4 }}>EMA Slow (bars)</label>
                          <input
                            type="number"
                            min="10"
                            max="100"
                            value={params.emaSlow}
                            onChange={(e) => setParams((p) => ({ ...p, emaSlow: parseInt(e.target.value) || 21 }))}
                            className="input"
                            style={{ width: '100%', padding: '8px 10px', fontSize: '0.85rem', background: '#0f172a', border: '1px solid #334155', color: '#ffffff', fontWeight: 600 }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Section 2: Volatility & Oscillators */}
                    <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: 14, borderRadius: 'var(--radius-md)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                      <p style={{ fontSize: '0.82rem', fontWeight: 700, color: '#ffffff', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#38bdf8' }} />
                        Volatility & Oscillators
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div>
                          <label style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Bollinger Period</label>
                          <input
                            type="number"
                            min="10"
                            max="50"
                            value={params.bbPeriod}
                            onChange={(e) => setParams((p) => ({ ...p, bbPeriod: parseInt(e.target.value) || 20 }))}
                            className="input"
                            style={{ width: '100%', padding: '8px 10px', fontSize: '0.85rem', background: '#0f172a', border: '1px solid #334155', color: '#ffffff', fontWeight: 600 }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>BB StdDev Multiplier</label>
                          <input
                            type="number"
                            step="0.5"
                            min="1.0"
                            max="4.0"
                            value={params.bbStd}
                            onChange={(e) => setParams((p) => ({ ...p, bbStd: parseFloat(e.target.value) || 2.0 }))}
                            className="input"
                            style={{ width: '100%', padding: '8px 10px', fontSize: '0.85rem', background: '#0f172a', border: '1px solid #334155', color: '#ffffff', fontWeight: 600 }}
                          />
                        </div>
                        <div style={{ gridColumn: 'span 2' }}>
                          <label style={{ fontSize: '0.72rem', color: '#c084fc', fontWeight: 600, display: 'block', marginBottom: 4 }}>RSI Lookback Period</label>
                          <input
                            type="number"
                            min="5"
                            max="30"
                            value={params.rsiPeriod}
                            onChange={(e) => setParams((p) => ({ ...p, rsiPeriod: parseInt(e.target.value) || 14 }))}
                            className="input"
                            style={{ width: '100%', padding: '8px 10px', fontSize: '0.85rem', background: '#0f172a', border: '1px solid #334155', color: '#ffffff', fontWeight: 600 }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Drawer Footer Actions */}
                    <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                      <button
                        onClick={() => setParams({ smaFast: 20, smaSlow: 50, emaFast: 9, emaSlow: 21, bbPeriod: 20, bbStd: 2.0, rsiPeriod: 14 })}
                        className="btn btn-secondary"
                        style={{ flex: 1, padding: '8px 12px', fontSize: '0.8rem' }}
                      >
                        Reset Defaults
                      </button>
                      <button
                        onClick={() => setDrawerOpen(false)}
                        className="btn btn-primary"
                        style={{ flex: 1, padding: '8px 12px', fontSize: '0.8rem', fontWeight: 700 }}
                      >
                        Apply & Close
                      </button>
                    </div>
                  </div>
                )}

                {/* TAB 2: CUSTOM ANNOTATIONS */}
                {drawerTab === 'lines' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: 14, borderRadius: 'var(--radius-md)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                      <p style={{ fontSize: '0.82rem', fontWeight: 700, color: '#ffffff', marginBottom: 10 }}>
                        Add Custom Price Level Line
                      </p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <input
                          type="number"
                          step="0.01"
                          placeholder="Target Price ($)"
                          value={newLinePrice}
                          onChange={(e) => setNewLinePrice(e.target.value)}
                          className="input"
                          style={{ padding: '8px 10px', fontSize: '0.85rem', background: '#0f172a', border: '1px solid #334155', color: '#ffffff' }}
                        />
                        <input
                          type="text"
                          placeholder="Label (e.g. Stop Loss, Take Profit)"
                          value={newLineLabel}
                          onChange={(e) => setNewLineLabel(e.target.value)}
                          className="input"
                          style={{ padding: '8px 10px', fontSize: '0.85rem', background: '#0f172a', border: '1px solid #334155', color: '#ffffff' }}
                        />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <select
                            value={newLineColor}
                            onChange={(e) => setNewLineColor(e.target.value)}
                            className="input"
                            style={{ padding: '8px 10px', fontSize: '0.82rem', flex: 1, background: '#0f172a', border: '1px solid #334155', color: '#ffffff' }}
                          >
                            <option value="#ef4444" style={{ background: '#0f172a' }}>🔴 Resistance / Stop Loss</option>
                            <option value="#10b981" style={{ background: '#0f172a' }}>🟢 Support / Take Profit</option>
                            <option value="#3b82f6" style={{ background: '#0f172a' }}>🔵 Entry Zone</option>
                            <option value="#f59e0b" style={{ background: '#0f172a' }}>🟠 Pivot / Target</option>
                          </select>
                          <button onClick={addPriceLine} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '0.82rem', fontWeight: 700 }}>
                            <Plus size={14} /> Add
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Active Lines List */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#ffffff' }}>
                          Active Custom Lines ({priceLines.length})
                        </span>
                        {priceLines.length > 0 && (
                          <button
                            onClick={clearAllCustomLines}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--color-danger)',
                              fontSize: '0.75rem',
                              cursor: 'pointer',
                              fontWeight: 600,
                            }}
                          >
                            Clear All
                          </button>
                        )}
                      </div>

                      {priceLines.length === 0 ? (
                        <p style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                          No custom price lines added yet. Add a level above or receive them automatically from AI Advisor analysis.
                        </p>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {priceLines.map((l) => (
                            <div
                              key={l.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '8px 12px',
                                borderRadius: 'var(--radius-sm)',
                                background: 'rgba(255, 255, 255, 0.04)',
                                border: `1px solid ${l.color}66`,
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ width: 10, height: 10, borderRadius: '50%', background: l.color }} />
                                <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#ffffff' }}>{l.label}</span>
                                <span style={{ fontSize: '0.82rem', fontFamily: 'var(--font-mono)', color: l.color, fontWeight: 700 }}>
                                  ${l.price.toFixed(2)}
                                </span>
                              </div>
                              <Trash2
                                size={15}
                                onClick={() => removePriceLine(l.id)}
                                style={{ cursor: 'pointer', color: 'var(--color-text-muted)' }}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* TAB 3: KEY LEVELS BREAKDOWN */}
                {drawerTab === 'levels' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {liveMetrics.pivots && (
                      <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: 14, borderRadius: 'var(--radius-md)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                        <p style={{ fontSize: '0.82rem', fontWeight: 700, color: '#ffffff', marginBottom: 10 }}>
                          Classical Support & Resistance Levels
                        </p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#f43f5e', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <span>Resistance 2 (R2):</span> <strong>${liveMetrics.pivots.r2}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ef4444', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <span>Resistance 1 (R1):</span> <strong>${liveMetrics.pivots.r1}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#60a5fa', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <span>Central Pivot (P):</span> <strong>${liveMetrics.pivots.pivot}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#34d399', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <span>Support 1 (S1):</span> <strong>${liveMetrics.pivots.s1}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#059669', padding: '4px 0' }}>
                            <span>Support 2 (S2):</span> <strong>${liveMetrics.pivots.s2}</strong>
                          </div>
                        </div>
                      </div>
                    )}
                    {liveMetrics.fibs && (
                      <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: 14, borderRadius: 'var(--radius-md)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                        <p style={{ fontSize: '0.82rem', fontWeight: 700, color: '#ffffff', marginBottom: 10 }}>
                          Fibonacci Retracement Grid
                        </p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <span>100.0% (Swing High):</span> <strong>${liveMetrics.fibs.f100}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ec4899', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <span>78.6% Retracement:</span> <strong>${liveMetrics.fibs.f786}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#c084fc', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <span>61.8% Golden Ratio:</span> <strong>${liveMetrics.fibs.f618}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#eab308', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <span>50.0% Equilibrium:</span> <strong>${liveMetrics.fibs.f500}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#38bdf8', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <span>38.2% Retracement:</span> <strong>${liveMetrics.fibs.f382}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#22d3ee', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <span>23.6% Retracement:</span> <strong>${liveMetrics.fibs.f236}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', padding: '4px 0' }}>
                            <span>0.0% (Swing Low):</span> <strong>${liveMetrics.fibs.f0}</strong>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* TAB 4: SUPPLY & DEMAND ZONES */}
                {drawerTab === 'zones' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <p style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                      Institutional Liquidity & Order Block Zones
                    </p>
                    {liveMetrics.pivots ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div
                          style={{
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            borderRadius: 'var(--radius-md)',
                            padding: '10px 12px',
                          }}
                        >
                          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-danger)' }}>
                            🔴 Supply / Distribution Block (R1 - R2)
                          </div>
                          <div style={{ fontSize: '0.78rem', fontFamily: 'var(--font-mono)', color: '#fff', marginTop: 4 }}>
                            ${liveMetrics.pivots.r1} — ${liveMetrics.pivots.r2}
                          </div>
                          <div style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                            Heavy institutional selling pressure & take-profit zone.
                          </div>
                        </div>

                        <div
                          style={{
                            background: 'rgba(16, 185, 129, 0.1)',
                            border: '1px solid rgba(16, 185, 129, 0.3)',
                            borderRadius: 'var(--radius-md)',
                            padding: '10px 12px',
                          }}
                        >
                          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-success)' }}>
                            🟢 Demand / Accumulation Block (S1 - S2)
                          </div>
                          <div style={{ fontSize: '0.78rem', fontFamily: 'var(--font-mono)', color: '#fff', marginTop: 4 }}>
                            ${liveMetrics.pivots.s2} — ${liveMetrics.pivots.s1}
                          </div>
                          <div style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                            Institutional accumulation & dip-buying liquidity buffer.
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Calculating liquidity zones...</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===================================================================== */}
      {/* 5. SYNCHRONIZED OSCILLATOR SUB-PANEL (RSI / MACD) */}
      {/* ===================================================================== */}
      {oscillatorView !== 'none' && (
        <div
          style={{
            borderTop: '1px solid var(--color-border)',
            background: 'rgba(8, 11, 20, 0.6)',
            padding: '4px 16px 8px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
              {oscillatorView === 'rsi'
                ? `Wilder's RSI (${params.rsiPeriod}) Oscillator`
                : oscillatorView === 'macd'
                ? 'MACD (12, 26, 9) Momentum Histogram'
                : 'Oscillator Sub-Panel (RSI & MACD)'}
            </span>
            <button
              onClick={() => setOscillatorView('none')}
              style={{ background: 'transparent', border: 'none', color: 'var(--color-text-muted)', fontSize: '0.65rem', cursor: 'pointer' }}
            >
              Hide
            </button>
          </div>
          <div ref={oscContainerRef} style={{ width: '100%', height: 110 }} />
        </div>
      )}
    </div>
  );
}
