/**
 * frontend/components/portfolio/PortfolioAllocationView.tsx
 * Institutional Capital Allocation & What-If Rebalancing Suite for $100,000 Capital:
 * - Real-time Mark-to-Market Holdings Table & P&L tracking
 * - Asset Distribution Progress Bars & Capital Breakdown
 * - Interactive What-If Rebalancer with real-time MPT Risk/Return simulation
 * - 1-Click trigger to send rebalance plan to AI Advisor HITL gate
 */
'use client';

import { useState, useMemo } from 'react';
import {
  PieChart,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  Sliders,
  Sparkles,
  TrendingUp,
  Shield,
  RotateCcw,
  CheckCircle2,
  DollarSign,
} from 'lucide-react';
import { usePortfolioStore } from '@/store/portfolioStore';
import { ASSET_NAMES, ASSET_COLORS } from '@/constants/market';

interface PositionData {
  ticker: string;
  name: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  value: number;
  weightPct: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  dayChangePct: number;
  color: string;
}

interface PortfolioAllocationViewProps {
  onSelectTicker?: (ticker: string) => void;
  onSendChatQuery?: (query: string) => void;
}

export function PortfolioAllocationView({ onSelectTicker, onSendChatQuery }: PortfolioAllocationViewProps) {
  const capital = usePortfolioStore((s) => s.capital) || 100000;
  const ticks = usePortfolioStore((s) => s.ticks);

  // Active view tab: 'holdings' | 'rebalancer'
  const [activeTab, setActiveTab] = useState<'holdings' | 'rebalancer'>('holdings');

  // Baseline share counts calibrated to $100,000 capital
  const baseHoldings = useMemo(() => {
    return [
      { ticker: 'AAPL', shares: 78, avgCost: 310.50, color: ASSET_COLORS.AAPL },
      { ticker: 'MSFT', shares: 40, avgCost: 500.20, color: ASSET_COLORS.MSFT },
      { ticker: 'NVDA', shares: 79, avgCost: 220.40, color: ASSET_COLORS.NVDA },
      { ticker: 'GOOGL', shares: 44, avgCost: 335.80, color: ASSET_COLORS.GOOGL },
      { ticker: 'SPY', shares: 15, avgCost: 765.00, color: ASSET_COLORS.SPY },
    ];
  }, []);

  // Compute live mark-to-market positions
  const { positions, totalEquitiesValue, cashValue, totalNAV, totalUnrealizedPnL, totalUnrealizedPnLPct } = useMemo(() => {
    let totalEqVal = 0;
    let totalCost = 0;

    const posList: PositionData[] = baseHoldings.map((h) => {
      const livePrice = ticks[h.ticker]?.price ?? h.avgCost;
      const dayChangePct = (ticks[h.ticker]?.changePct ?? 0) * 100;
      const val = h.shares * livePrice;
      const cost = h.shares * h.avgCost;
      const pnl = val - cost;
      const pnlPct = (pnl / cost) * 100;

      totalEqVal += val;
      totalCost += cost;

      return {
        ticker: h.ticker,
        name: ASSET_NAMES[h.ticker] || h.ticker,
        shares: h.shares,
        avgCost: h.avgCost,
        currentPrice: livePrice,
        value: val,
        weightPct: 0, // calculated below
        unrealizedPnL: pnl,
        unrealizedPnLPct: pnlPct,
        dayChangePct,
        color: h.color,
      };
    });

    const cash = Math.max(0, capital - totalCost);
    const nav = totalEqVal + cash;

    // Calculate dynamic weights
    posList.forEach((p) => {
      p.weightPct = nav > 0 ? (p.value / nav) * 100 : 0;
    });

    const totalPnL = totalEqVal - totalCost;
    const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

    return {
      positions: posList,
      totalEquitiesValue: totalEqVal,
      cashValue: cash,
      totalNAV: nav,
      totalUnrealizedPnL: totalPnL,
      totalUnrealizedPnLPct: totalPnLPct,
    };
  }, [baseHoldings, ticks, capital]);

  // --- What-If Rebalancer State ---
  const [targetWeights, setTargetWeights] = useState<Record<string, number>>({
    AAPL: 25,
    MSFT: 20,
    NVDA: 20,
    GOOGL: 15,
    SPY: 15,
    CASH: 5,
  });

  const totalTargetWeight = useMemo(() => {
    return Object.values(targetWeights).reduce((sum, w) => sum + w, 0);
  }, [targetWeights]);

  // Projected Sharpe & Return simulator based on target weights
  const simulatedMetrics = useMemo(() => {
    const weights = targetWeights;
    // Expected annualized returns proxy
    const expReturns: Record<string, number> = {
      AAPL: 0.28,
      MSFT: 0.24,
      NVDA: 0.42,
      GOOGL: 0.26,
      SPY: 0.16,
      CASH: 0.05,
    };
    // Expected volatilities proxy
    const expVols: Record<string, number> = {
      AAPL: 0.22,
      MSFT: 0.20,
      NVDA: 0.38,
      GOOGL: 0.24,
      SPY: 0.14,
      CASH: 0.00,
    };

    let projectedReturn = 0;
    let weightedVolSum = 0;

    Object.keys(weights).forEach((k) => {
      const w = (weights[k] || 0) / 100;
      projectedReturn += w * (expReturns[k] || 0.15);
      weightedVolSum += Math.pow(w * (expVols[k] || 0.20), 2);
    });

    // Approximate portfolio vol with diversification correlation discount (0.65)
    const portfolioVol = Math.sqrt(weightedVolSum * 1.35);
    const riskFree = 0.0525;
    const sharpe = portfolioVol > 0 ? (projectedReturn - riskFree) / portfolioVol : 0;
    const var95_1d = (portfolioVol / Math.sqrt(252)) * 1.645 * capital;

    return {
      projectedReturn: +(projectedReturn * 100).toFixed(2),
      projectedVol: +(portfolioVol * 100).toFixed(2),
      simulatedSharpe: +sharpe.toFixed(2),
      simulatedVaR: Math.round(var95_1d),
    };
  }, [targetWeights, capital]);

  const resetTargetWeights = () => {
    setTargetWeights({
      AAPL: 25,
      MSFT: 20,
      NVDA: 20,
      GOOGL: 15,
      SPY: 15,
      CASH: 5,
    });
  };

  const handleSliderChange = (ticker: string, val: number) => {
    setTargetWeights((prev) => ({
      ...prev,
      [ticker]: val,
    }));
  };

  return (
    <div className="card" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Header & Tabs */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 'var(--radius-md)',
              background: 'rgba(16, 185, 129, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-success)',
            }}
          >
            <Wallet size={18} />
          </div>
          <div>
            <h3 style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--color-text-primary)' }}>
              Portfolio Capital & Holdings Suite ($100,000.00 NAV)
            </h3>
            <p style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
              Mark-to-market position weights, P&L tracking, and interactive What-If rebalancing simulator.
            </p>
          </div>
        </div>

        {/* View Tabs */}
        <div
          style={{
            display: 'flex',
            background: 'rgba(255, 255, 255, 0.04)',
            borderRadius: 'var(--radius-md)',
            padding: 3,
            border: '1px solid rgba(99, 131, 195, 0.15)',
          }}
        >
          <button
            onClick={() => setActiveTab('holdings')}
            style={{
              background: activeTab === 'holdings' ? 'var(--color-accent-primary)' : 'transparent',
              color: activeTab === 'holdings' ? '#ffffff' : 'var(--color-text-secondary)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: '5px 14px',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all var(--transition-fast)',
            }}
          >
            <PieChart size={14} />
            <span>Holdings & Allocation</span>
          </button>

          <button
            onClick={() => setActiveTab('rebalancer')}
            style={{
              background: activeTab === 'rebalancer' ? 'var(--color-accent-primary)' : 'transparent',
              color: activeTab === 'rebalancer' ? '#ffffff' : 'var(--color-text-secondary)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: '5px 14px',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all var(--transition-fast)',
            }}
          >
            <Sliders size={14} />
            <span>What-If Rebalancer</span>
          </button>
        </div>
      </div>

      {/* Allocation Progress Bar Banner */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>
          <span>Asset Distribution (% NAV)</span>
          <span>
            Total Value: <strong style={{ color: '#fff', fontFamily: 'var(--font-mono)' }}>${totalNAV.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          </span>
        </div>

        {/* Multi-segment Progress Bar */}
        <div
          style={{
            height: 12,
            width: '100%',
            borderRadius: 'var(--radius-full)',
            background: 'rgba(255, 255, 255, 0.05)',
            display: 'flex',
            overflow: 'hidden',
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          {positions.map((p) => (
            <div
              key={p.ticker}
              style={{
                width: `${p.weightPct}%`,
                background: p.color,
                transition: 'width 0.4s ease',
              }}
              title={`${p.ticker}: ${p.weightPct.toFixed(1)}% ($${p.value.toFixed(2)})`}
            />
          ))}
          <div
            style={{
              width: `${(cashValue / totalNAV) * 100}%`,
              background: ASSET_COLORS.CASH,
              transition: 'width 0.4s ease',
            }}
            title={`CASH: ${((cashValue / totalNAV) * 100).toFixed(1)}% ($${cashValue.toFixed(2)})`}
          />
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 4 }}>
          {positions.map((p) => (
            <div key={p.ticker} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.7rem' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
              <span style={{ color: '#fff', fontWeight: 600 }}>{p.ticker}:</span>
              <span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>{p.weightPct.toFixed(1)}%</span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.7rem' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: ASSET_COLORS.CASH }} />
            <span style={{ color: '#fff', fontWeight: 600 }}>CASH:</span>
            <span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>{((cashValue / totalNAV) * 100).toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {/* VIEW 1: HOLDINGS TABLE */}
      {activeTab === 'holdings' && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)', color: 'var(--color-text-muted)', textAlign: 'left' }}>
                <th style={{ padding: '8px 10px' }}>Asset</th>
                <th style={{ padding: '8px 10px' }}>Position</th>
                <th style={{ padding: '8px 10px' }}>Market Price</th>
                <th style={{ padding: '8px 10px' }}>Total Value</th>
                <th style={{ padding: '8px 10px' }}>Weight</th>
                <th style={{ padding: '8px 10px' }}>Unrealized P&L</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const isPnlPositive = p.unrealizedPnL >= 0;
                return (
                  <tr
                    key={p.ticker}
                    onClick={() => onSelectTicker?.(p.ticker)}
                    style={{
                      borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                      cursor: 'pointer',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 4, height: 28, borderRadius: 2, background: p.color }} />
                        <div>
                          <strong style={{ color: '#fff', fontSize: '0.8rem' }}>{p.ticker}</strong>
                          <div style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)' }}>{p.name}</div>
                        </div>
                      </div>
                    </td>

                    <td style={{ padding: '10px', fontFamily: 'var(--font-mono)' }}>
                      <div>{p.shares} shares</div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)' }}>Avg: ${p.avgCost.toFixed(2)}</div>
                    </td>

                    <td style={{ padding: '10px', fontFamily: 'var(--font-mono)' }}>
                      <div style={{ fontWeight: 600, color: '#fff' }}>${p.currentPrice.toFixed(2)}</div>
                      <div style={{ fontSize: '0.68rem', color: p.dayChangePct >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                        {p.dayChangePct >= 0 ? '+' : ''}{p.dayChangePct.toFixed(2)}% today
                      </div>
                    </td>

                    <td style={{ padding: '10px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#fff' }}>
                      ${p.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>

                    <td style={{ padding: '10px' }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: 'var(--radius-sm)',
                          background: 'rgba(255, 255, 255, 0.05)',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 600,
                          color: p.color,
                        }}
                      >
                        {p.weightPct.toFixed(1)}%
                      </span>
                    </td>

                    <td style={{ padding: '10px', fontFamily: 'var(--font-mono)' }}>
                      <div style={{ color: isPnlPositive ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>
                        {isPnlPositive ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                        <span>{isPnlPositive ? '+' : ''}${p.unrealizedPnL.toFixed(2)}</span>
                      </div>
                      <div style={{ fontSize: '0.68rem', color: isPnlPositive ? 'var(--color-success)' : 'var(--color-danger)', opacity: 0.85 }}>
                        ({isPnlPositive ? '+' : ''}{p.unrealizedPnLPct.toFixed(2)}%)
                      </div>
                    </td>

                    <td style={{ padding: '10px', textAlign: 'right' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectTicker?.(p.ticker);
                          onSendChatQuery?.(`Analyze risk and technical indicators for ${p.ticker}`);
                        }}
                        className="btn btn-secondary"
                        style={{ padding: '3px 8px', fontSize: '0.7rem' }}
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                );
              })}

              {/* Cash Row */}
              <tr style={{ background: 'rgba(255, 255, 255, 0.02)' }}>
                <td style={{ padding: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 4, height: 28, borderRadius: 2, background: ASSET_COLORS.CASH }} />
                    <div>
                      <strong style={{ color: '#fff', fontSize: '0.8rem' }}>USD CASH</strong>
                      <div style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)' }}>Unallocated Capital & Margin</div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '10px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>—</td>
                <td style={{ padding: '10px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>$1.00</td>
                <td style={{ padding: '10px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#fff' }}>
                  ${cashValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td style={{ padding: '10px' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 'var(--radius-sm)', background: 'rgba(255, 255, 255, 0.05)', fontFamily: 'var(--font-mono)', color: ASSET_COLORS.CASH }}>
                    {((cashValue / totalNAV) * 100).toFixed(1)}%
                  </span>
                </td>
                <td style={{ padding: '10px', color: 'var(--color-text-muted)' }}>—</td>
                <td style={{ padding: '10px', textAlign: 'right' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--color-success)', fontWeight: 600 }}>Available</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* VIEW 2: WHAT-IF REBALANCER SIMULATOR */}
      {activeTab === 'rebalancer' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 20, alignItems: 'start' }}>
          {/* Sliders Area */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                Target Weight Allocations:
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 700,
                    color: totalTargetWeight === 100 ? 'var(--color-success)' : 'var(--color-danger)',
                  }}
                >
                  Total: {totalTargetWeight}%
                </span>
                <button
                  onClick={resetTargetWeights}
                  style={{ background: 'transparent', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer' }}
                  title="Reset to Model Weights"
                >
                  <RotateCcw size={13} />
                </button>
              </div>
            </div>

            {Object.keys(targetWeights).map((sym) => (
              <div key={sym} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                  <span style={{ fontWeight: 600, color: ASSET_COLORS[sym] || '#fff' }}>{sym}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: '#fff' }}>
                    {targetWeights[sym]}% (${((targetWeights[sym] / 100) * capital).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })})
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="60"
                  step="5"
                  value={targetWeights[sym]}
                  onChange={(e) => handleSliderChange(sym, parseInt(e.target.value) || 0)}
                  style={{ width: '100%', accentColor: ASSET_COLORS[sym] || 'var(--color-accent-primary)', cursor: 'pointer' }}
                />
              </div>
            ))}
          </div>

          {/* Simulated Risk / Return Results Card */}
          <div
            style={{
              background: 'rgba(15, 23, 42, 0.9)',
              border: '1px solid var(--color-border-strong)',
              borderRadius: 'var(--radius-lg)',
              padding: '16px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Sparkles size={16} color="var(--color-accent-bright)" />
              <strong style={{ fontSize: '0.85rem', color: '#fff' }}>Simulated MPT Risk & Return Profile</strong>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)' }}>Projected CAGR</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-success)', fontFamily: 'var(--font-mono)' }}>
                  +{simulatedMetrics.projectedReturn}%
                </div>
              </div>

              <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)' }}>Simulated Volatility</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-warning)', fontFamily: 'var(--font-mono)' }}>
                  {simulatedMetrics.projectedVol}%
                </div>
              </div>

              <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)' }}>Simulated Sharpe</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-accent-bright)', fontFamily: 'var(--font-mono)' }}>
                  {simulatedMetrics.simulatedSharpe}
                </div>
              </div>

              <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)' }}>1-Day 95% VaR ($)</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-danger)', fontFamily: 'var(--font-mono)' }}>
                  ${simulatedMetrics.simulatedVaR}
                </div>
              </div>
            </div>

            <button
              onClick={() => {
                const weightsStr = Object.entries(targetWeights)
                  .map(([k, v]) => `${k}: ${v}%`)
                  .join(', ');
                onSendChatQuery?.(`Rebalance my $100,000 portfolio to target allocations: ${weightsStr} using Mean-Variance Optimization`);
              }}
              className="btn btn-primary"
              style={{ padding: '8px 14px', fontSize: '0.8rem', width: '100%', marginTop: 6 }}
            >
              <Sparkles size={14} /> Execute Strategy via AI Advisor (HITL 2FA)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
