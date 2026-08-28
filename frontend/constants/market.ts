/**
 * frontend/constants/market.ts
 * Centralized market constants, asset definitions, and environment endpoints.
 */

export const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'NVDA', 'SPY'] as const;
export type SupportedTicker = (typeof DEFAULT_TICKERS)[number];

export const DEFAULT_CAPITAL = 100000.0;

export const ASSET_NAMES: Record<string, string> = {
  AAPL: 'Apple Inc.',
  MSFT: 'Microsoft Corporation',
  NVDA: 'NVIDIA Corporation',
  GOOGL: 'Alphabet Inc.',
  SPY: 'SPDR S&P 500 ETF Trust',
  GLD: 'SPDR Gold Shares',
  TLT: 'iShares 20+ Year Treasury Bond ETF',
  CASH: 'USD Treasury / Cash Reserves',
};

export const ASSET_COLORS: Record<string, string> = {
  AAPL: '#38bdf8',
  MSFT: '#00d2ff',
  NVDA: '#10b981',
  GOOGL: '#f59e0b',
  SPY: '#8b5cf6',
  GLD: '#fbbf24',
  TLT: '#ec4899',
  CASH: '#64748b',
};

export const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:8080';

export const WS_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_WS_URL) || 'ws://localhost:8080';
