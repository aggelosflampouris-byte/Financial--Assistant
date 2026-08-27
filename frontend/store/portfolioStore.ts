/**
 * frontend/store/portfolioStore.ts
 * Zustand store for portfolio state, metrics, and real-time tick data.
 */
import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketTick {
  ticker: string;
  price: number;
  changePct: number;
  volume: number;
  timestamp: string;
}

export interface VaRResult {
  confidence: number;
  varAmount: number;
  varPct: number;
  method: string;
}

export interface PortfolioMetrics {
  portfolioId: string;
  benchmark: string;
  calculatedAt: string;
  sharpeRatio: number;
  sortinoRatio: number;
  cagr: number;
  maxDrawdown: number;
  beta: number;
  alpha: number;
  var95: VaRResult;
  var99: VaRResult;
  annualizedVolatility: number;
  totalReturn: number;
  benchmarkReturn: number;
  riskFreeRate: number;
  analysisPeriodDays: number;
}

export interface ChartDirective {
  ticker?: string;
  timeframe?: '1D' | '5D' | '1M' | '3M' | '6M' | '1Y' | 'YTD';
  chart_type?: 'candlestick' | 'area' | 'line' | 'bar';
  enable_indicators?: string[];
  add_price_lines?: Array<{ id: string; price: number; label: string; color: string }>;
}

export interface HITLRequest {
  actionId: string;
  sessionId: string;
  actionType: string;
  actionSummary: string;
  actionPayload: Record<string, unknown>;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  expiresAt: string;
  complianceNote: string;
}

// ---------------------------------------------------------------------------
// State interface
// ---------------------------------------------------------------------------

interface PortfolioState {
  // Ticks
  ticks: Record<string, MarketTick>;
  tickHistory: Record<string, MarketTick[]>;

  // Metrics
  metrics: PortfolioMetrics | null;
  metricsLoading: boolean;
  metricsError: string | null;

  // Chart Directive from AI Advisor
  chartDirective: ChartDirective | null;

  // HITL
  pendingHITL: HITLRequest | null;
  hitlConfirming: boolean;

  // Connection status
  wsConnected: Record<string, boolean>;

  // Actions
  updateTick: (tick: MarketTick) => void;
  setMetrics: (metrics: PortfolioMetrics) => void;
  setMetricsLoading: (loading: boolean) => void;
  setMetricsError: (error: string | null) => void;
  applyChartDirective: (directive: ChartDirective | null) => void;
  setPendingHITL: (request: HITLRequest | null) => void;
  setHITLConfirming: (confirming: boolean) => void;
  setWsConnected: (ticker: string, connected: boolean) => void;
  clearHITL: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePortfolioStore = create<PortfolioState>()(
  devtools(
    subscribeWithSelector((set, get) => ({
      // Initial state
      ticks: {},
      tickHistory: {},
      metrics: null,
      metricsLoading: false,
      metricsError: null,
      chartDirective: null,
      pendingHITL: null,
      hitlConfirming: false,
      wsConnected: {},

      // Actions
      updateTick: (tick) =>
        set((state) => {
          const history = state.tickHistory[tick.ticker] ?? [];
          const MAX_HISTORY = 200;
          return {
            ticks: { ...state.ticks, [tick.ticker]: tick },
            tickHistory: {
              ...state.tickHistory,
              [tick.ticker]: [...history.slice(-MAX_HISTORY + 1), tick],
            },
          };
        }),

      setMetrics: (metrics) => set({ metrics, metricsLoading: false, metricsError: null }),

      setMetricsLoading: (metricsLoading) => set({ metricsLoading }),

      setMetricsError: (metricsError) => set({ metricsError, metricsLoading: false }),

      applyChartDirective: (chartDirective) => set({ chartDirective }),

      setPendingHITL: (pendingHITL) => set({ pendingHITL }),

      setHITLConfirming: (hitlConfirming) => set({ hitlConfirming }),

      setWsConnected: (ticker, connected) =>
        set((state) => ({
          wsConnected: { ...state.wsConnected, [ticker]: connected },
        })),

      clearHITL: () => set({ pendingHITL: null, hitlConfirming: false }),
    })),
    { name: 'portfolio-store' }
  )
);
