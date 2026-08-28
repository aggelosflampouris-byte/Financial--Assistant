'use client';

/**
 * frontend/app/page.tsx
 * Main Dashboard — financial metrics cards, live chart, and AI advisor chat.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TrendingUp, TrendingDown, Shield, Zap, Activity,
  BarChart3, MessageSquare, RefreshCw, AlertCircle, Wallet, DollarSign,
  PieChart, Sliders
} from 'lucide-react';
import { TradingViewChart } from '@/components/charts/TradingViewChart';
import { PortfolioAllocationView } from '@/components/portfolio/PortfolioAllocationView';
import { HITLConfirmationModal } from '@/components/advisor/HITLConfirmationModal';
import { usePortfolioStore } from '@/store/portfolioStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  complianceDisclaimer?: string;
  requiresConfirmation?: boolean;
  pendingActionId?: string;
}

// ---------------------------------------------------------------------------
// Metric Card Component
// ---------------------------------------------------------------------------

function MetricCard({
  label, value, sub, positive, icon: Icon, loading
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean;
  icon: React.ElementType;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="card" style={{ padding: 20 }}>
        <div className="skeleton" style={{ height: 12, width: '60%', marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 32, width: '80%', marginBottom: 8 }} />
        <div className="skeleton" style={{ height: 10, width: '40%' }} />
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <p className="metric-label" style={{ marginBottom: 8 }}>{label}</p>
          <p className="metric-value metric-animated" style={{
            color: positive === undefined ? 'var(--color-text-primary)' :
                   positive ? 'var(--color-success)' : 'var(--color-danger)'
          }}>
            {value}
          </p>
          {sub && (
            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
              {sub}
            </p>
          )}
        </div>
        <div style={{
          width: 40, height: 40,
          borderRadius: 'var(--radius-md)',
          background: 'rgba(59, 130, 246, 0.1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon size={18} color="var(--color-accent-bright)" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown & Rich Content Renderer for Chat
// ---------------------------------------------------------------------------

function renderInlineTokens(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={match.index} style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <span
          key={match.index}
          style={{
            fontFamily: 'var(--font-mono)',
            background: 'rgba(59, 130, 246, 0.18)',
            color: 'var(--color-accent-bright)',
            padding: '1px 6px',
            borderRadius: 4,
            fontSize: '0.8rem',
            fontWeight: 600,
            border: '1px solid rgba(59, 130, 246, 0.3)',
          }}
        >
          {token.slice(1, -1)}
        </span>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(
        <em key={match.index} style={{ color: 'var(--color-accent-bright)' }}>
          {token.slice(1, -1)}
        </em>
      );
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function FormattedChatMessage({ content }: { content: string }) {
  const lines = content.split('\n');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={idx} style={{ height: 2 }} />;

        // Header ###
        if (trimmed.startsWith('### ')) {
          return (
            <h4
              key={idx}
              style={{
                fontWeight: 700,
                fontSize: '0.95rem',
                color: 'var(--color-accent-bright)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                margin: '6px 0 2px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                paddingBottom: 4,
              }}
            >
              {trimmed.replace('### ', '')}
            </h4>
          );
        }

        // List item - **Label:** `Value` (details)
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          const itemText = trimmed.replace(/^[-*]\s+/, '');
          return (
            <div
              key={idx}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '4px 8px',
                background: 'rgba(255, 255, 255, 0.03)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.83rem',
                lineHeight: 1.5,
                borderLeft: '2px solid var(--color-accent-primary)',
              }}
            >
              <div style={{ flex: 1 }}>{renderInlineTokens(itemText)}</div>
            </div>
          );
        }

        // Regular paragraph
        return (
          <p key={idx} style={{ fontSize: '0.85rem', lineHeight: 1.6, margin: 0 }}>
            {renderInlineTokens(trimmed)}
          </p>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'NVDA', 'SPY'];
const API_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:8080';

export default function DashboardPage() {
  // --- State ---
  const [selectedTicker, setSelectedTicker] = useState('AAPL');
  const [dashboardTab, setDashboardTab] = useState<'holdings' | 'watchlist'>('holdings');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // --- Zustand ---
  const capital = usePortfolioStore((s) => s.capital);
  const cash = usePortfolioStore((s) => s.cash);
  const metrics = usePortfolioStore((s) => s.metrics);
  const ticks = usePortfolioStore((s) => s.ticks);
  const pendingHITL = usePortfolioStore((s) => s.pendingHITL);
  const setPendingHITL = usePortfolioStore((s) => s.setPendingHITL);
  const clearHITL = usePortfolioStore((s) => s.clearHITL);
  const setMetrics = usePortfolioStore((s) => s.setMetrics);

  // --- Fetch metrics & initial quotes on mount ---
  useEffect(() => {
    const portfolioId = '00000000-0000-0000-0000-000000000001'; // Demo portfolio
    setMetricsLoading(true);

    // 1. Fetch metrics
    fetch(`${API_BASE}/portfolio/${portfolioId}/metrics?tickers=AAPL,MSFT,GOOGL,NVDA,SPY`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => {
        setMetrics({
          portfolioId: data.portfolio_id,
          benchmark: data.benchmark || 'SPY',
          calculatedAt: data.calculated_at,
          sharpeRatio: data.sharpe_ratio ?? 0,
          sortinoRatio: data.sortino_ratio ?? 0,
          cagr: data.cagr ?? 0,
          maxDrawdown: data.max_drawdown ?? 0,
          beta: data.beta ?? 1,
          alpha: data.alpha ?? 0,
          var95: {
            confidence: 0.95,
            varAmount: Number(data.var_95?.var_amount ?? 12400),
            varPct: Number(data.var_95?.var_pct ?? 0.0189),
            method: 'historical',
          },
          var99: {
            confidence: 0.99,
            varAmount: Number(data.var_99?.var_amount ?? 18200),
            varPct: Number(data.var_99?.var_pct ?? 0.0275),
            method: 'historical',
          },
          annualizedVolatility: data.annualized_volatility ?? 0.18,
          totalReturn: data.total_return ?? 0,
          benchmarkReturn: data.benchmark_return ?? 0,
          riskFreeRate: data.risk_free_rate ?? 0.0525,
          analysisPeriodDays: data.analysis_period_days ?? 252,
        });
        setMetricsLoading(false);
      })
      .catch((err) => {
        console.error('Failed to fetch metrics:', err);
        setMetricsLoading(false);
      });

    // 2. Fetch initial quotes for all tickers
    DEFAULT_TICKERS.forEach((ticker) => {
      fetch(`${API_BASE}/market/quote/${ticker}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((q) => {
          if (q) {
            usePortfolioStore.getState().updateTick({
              ticker: q.ticker,
              price: q.price,
              changePct: q.change_pct,
              volume: q.volume,
              timestamp: q.timestamp,
            });
          }
        })
        .catch(() => {});
    });
  }, [setMetrics]);

  // --- Auto-scroll chat ---
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // --- Send chat message ---
  const sendMessage = useCallback(async (customMessage?: string) => {
    const text = (typeof customMessage === 'string' ? customMessage : chatInput).trim();
    if (!text || chatLoading) return;
    if (!customMessage) setChatInput('');
    setChatLoading(true);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const response = await fetch(`${API_BASE}/advisor/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          session_id: 'demo-session-001',
          current_ticker: selectedTicker,
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      // Check for Chart Directives from technical & statistical analysis
      if (data.tool_data?.chart_directives) {
        const cd = data.tool_data.chart_directives;
        if (cd.ticker && DEFAULT_TICKERS.includes(cd.ticker)) {
          setSelectedTicker(cd.ticker);
        }
        usePortfolioStore.getState().applyChartDirective(cd);
      }

      // Check for HITL interrupt
      if (data.requires_human_confirmation && data.pending_action_id) {
        setPendingHITL({
          actionId: data.pending_action_id,
          sessionId: 'demo-session-001',
          actionType: 'portfolio_action',
          actionSummary: data.content,
          actionPayload: data.tool_data ?? {},
          riskLevel: data.compliance?.risk_warning_level ?? 'HIGH',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          complianceNote: data.compliance?.disclaimer_text ?? '',
        });
      }

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.content ?? 'No response generated.',
        timestamp: new Date(),
        complianceDisclaimer: data.compliance?.disclaimer_text,
        requiresConfirmation: data.requires_human_confirmation,
        pendingActionId: data.pending_action_id,
      };
      setMessages((prev) => [...prev, assistantMsg]);

    } catch (err) {
      console.error('Chat request error:', err);
      const errMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Error communicating with advisor: ${err instanceof Error ? err.message : 'Unknown error'}. Please ensure the backend is active.`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, selectedTicker, setPendingHITL]);

  // Watchlist Sorting State
  const [sortField, setSortField] = useState<'ticker' | 'price' | 'changePct'>('changePct');
  const [sortAsc, setSortAsc] = useState(false);

  const assetNames: Record<string, string> = {
    AAPL: 'Apple Inc.',
    MSFT: 'Microsoft Corp.',
    GOOGL: 'Alphabet Inc.',
    NVDA: 'NVIDIA Corporation',
    SPY: 'SPDR S&P 500 ETF Trust',
  };

  const sortedTickers = [...DEFAULT_TICKERS].sort((a, b) => {
    const tickA = ticks[a];
    const tickB = ticks[b];
    if (sortField === 'ticker') {
      return sortAsc ? a.localeCompare(b) : b.localeCompare(a);
    }
    if (sortField === 'price') {
      const pA = tickA?.price ?? 0;
      const pB = tickB?.price ?? 0;
      return sortAsc ? pA - pB : pB - pA;
    }
    if (sortField === 'changePct') {
      const cA = tickA?.changePct ?? 0;
      const cB = tickB?.changePct ?? 0;
      return sortAsc ? cA - cB : cB - cA;
    }
    return 0;
  });

  const toggleSort = (field: 'ticker' | 'price' | 'changePct') => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  // --- HITL confirm ---
  const handleHITLConfirm = useCallback(async (actionId: string, token: string) => {
    const response = await fetch(`${API_BASE}/advisor/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action_id: actionId,
        session_id: 'demo-session-001',
        approved: true,
        confirmation_token: token,
      }),
    });
    if (!response.ok) throw new Error(`Confirmation failed: HTTP ${response.status}`);
    clearHITL();

    const successMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '✅ Action confirmed and executed successfully.',
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, successMsg]);
  }, [clearHITL]);

  const formatPct = (v?: number) => v != null ? `${(v * 100).toFixed(2)}%` : '—';
  const formatNum = (v?: number, dp = 2) => v != null ? v.toFixed(dp) : '—';

  return (
    <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>

      {/* === HITL MODAL === */}
      {pendingHITL && (
        <HITLConfirmationModal
          request={pendingHITL}
          onConfirm={handleHITLConfirm}
          onReject={clearHITL}
        />
      )}

      {/* === HEADER === */}
      <header className="glass" style={{
        position: 'sticky', top: 0, zIndex: 100,
        padding: '0 32px',
        height: 64,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid var(--color-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 32, height: 32,
            background: 'var(--color-accent-gradient)',
            borderRadius: 'var(--radius-md)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <BarChart3 size={18} color="white" />
          </div>
          <span style={{ fontWeight: 700, fontSize: '1rem' }}>Financial Assistant</span>
          <span className="badge badge-info">ENTERPRISE</span>
        </div>

        {/* Center/Right: User's Fixed Portfolio Capital */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'rgba(16, 185, 129, 0.08)',
            border: '1px solid rgba(16, 185, 129, 0.25)',
            padding: '5px 14px',
            borderRadius: 'var(--radius-md)',
          }}>
            <div style={{
              width: 26, height: 26,
              borderRadius: '50%',
              background: 'rgba(16, 185, 129, 0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--color-success)',
            }}>
              <Wallet size={14} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '0.65rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                Portfolio Capital
              </span>
              <span style={{ fontSize: '0.95rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--color-success)' }}>
                ${capital.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="live-indicator pulsing">LIVE</span>
            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
              MiFID II Compliant
            </span>
          </div>
        </div>
      </header>

      {/* === MAIN GRID === */}
      <main style={{ padding: '24px 32px', maxWidth: 1600, margin: '0 auto' }}>

        {/* === TICKER BAR === */}
        <div style={{
          display: 'flex', gap: 8, marginBottom: 24, overflowX: 'auto',
          paddingBottom: 4,
        }}>
          {DEFAULT_TICKERS.map((t) => {
            const tick = ticks[t];
            const isPositive = (tick?.changePct ?? 0) >= 0;
            return (
              <button
                key={t}
                onClick={() => setSelectedTicker(t)}
                style={{
                  background: selectedTicker === t ? 'var(--color-bg-elevated)' : 'transparent',
                  border: `1px solid ${selectedTicker === t ? 'var(--color-accent-primary)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-md)',
                  padding: '8px 16px',
                  cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
                  minWidth: 100,
                  transition: 'all var(--transition-fast)',
                }}
              >
                <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--color-text-primary)' }}>{t}</span>
                {tick ? (
                  <>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-text-primary)' }}>
                      ${tick.price.toFixed(2)}
                    </span>
                    <span style={{
                      fontSize: '0.7rem', fontWeight: 600,
                      color: isPositive ? 'var(--color-success)' : 'var(--color-danger)',
                    }}>
                      {isPositive ? '+' : ''}{(tick.changePct * 100).toFixed(2)}%
                    </span>
                  </>
                ) : (
                  <span className="skeleton" style={{ width: 60, height: 12 }} />
                )}
              </button>
            );
          })}
        </div>

        {/* === TWO-COLUMN LAYOUT === */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 400px', gap: 24, alignItems: 'start' }}>

          {/* === LEFT COLUMN === */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Chart */}
            <div className="card" style={{ overflow: 'hidden' }}>
              <TradingViewChart ticker={selectedTicker} height={460} />
            </div>

            {/* Metrics grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
              <MetricCard
                label="Portfolio Capital"
                value={`$${capital.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                sub="100% Cash / NAV · Fixed"
                icon={Wallet}
                positive={true}
                loading={false}
              />
              <MetricCard
                label="Sharpe Ratio"
                value={formatNum(metrics?.sharpeRatio)}
                sub="Risk-adjusted return"
                icon={TrendingUp}
                positive={(metrics?.sharpeRatio ?? 0) > 1}
                loading={metricsLoading}
              />
              <MetricCard
                label="Sortino Ratio"
                value={formatNum(metrics?.sortinoRatio)}
                sub="Downside risk-adjusted"
                icon={Shield}
                positive={(metrics?.sortinoRatio ?? 0) > 1}
                loading={metricsLoading}
              />
              <MetricCard
                label="Max Drawdown"
                value={formatPct(metrics?.maxDrawdown)}
                sub="Peak-to-trough loss"
                icon={TrendingDown}
                positive={false}
                loading={metricsLoading}
              />
              <MetricCard
                label="CAGR"
                value={formatPct(metrics?.cagr)}
                sub="Compound annual growth"
                icon={TrendingUp}
                positive={(metrics?.cagr ?? 0) > 0}
                loading={metricsLoading}
              />
              <MetricCard
                label="VaR 95% (1d)"
                value={metrics?.var95 ? `$${((metrics.var95.varPct || 0.0189) * capital).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${(capital * 0.0189).toFixed(2)}`}
                sub={metrics?.var95 ? `${(metrics.var95.varPct * 100).toFixed(2)}% of $100k NAV` : '1.89% of NAV'}
                icon={AlertCircle}
                positive={false}
                loading={metricsLoading}
              />
            </div>

            {/* === LOWER DASHBOARD SUITE: TABS FOR $100K PORTFOLIO ALLOCATION & WATCHLIST === */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: -6 }}>
              <button
                onClick={() => setDashboardTab('holdings')}
                className={`btn ${dashboardTab === 'holdings' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ fontSize: '0.78rem', padding: '6px 14px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <PieChart size={14} />
                <span>$100,000 Portfolio Allocation & Rebalancer</span>
              </button>
              <button
                onClick={() => setDashboardTab('watchlist')}
                className={`btn ${dashboardTab === 'watchlist' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ fontSize: '0.78rem', padding: '6px 14px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Activity size={14} />
                <span>Market Watchlist & Analytics</span>
              </button>
            </div>

            {dashboardTab === 'holdings' ? (
              <PortfolioAllocationView
                onSelectTicker={(t) => setSelectedTicker(t)}
                onSendChatQuery={(q) => sendMessage(q)}
              />
            ) : (
              /* Comprehensive Market Watchlist & Technical Overview Table */
              <div className="card" style={{ padding: '16px 20px', overflowX: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Activity size={16} color="var(--color-accent-bright)" />
                    <h3 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                      Watchlist & Technical Analytics
                    </h3>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
                    Click column headers to sort · Click row to load chart
                  </span>
                </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)', color: 'var(--color-text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 10px', cursor: 'pointer' }} onClick={() => toggleSort('ticker')}>
                      Asset {sortField === 'ticker' ? (sortAsc ? '▲' : '▼') : ''}
                    </th>
                    <th style={{ padding: '8px 10px', cursor: 'pointer' }} onClick={() => toggleSort('price')}>
                      Price {sortField === 'price' ? (sortAsc ? '▲' : '▼') : ''}
                    </th>
                    <th style={{ padding: '8px 10px', cursor: 'pointer' }} onClick={() => toggleSort('changePct')}>
                      24h Change {sortField === 'changePct' ? (sortAsc ? '▲' : '▼') : ''}
                    </th>
                    <th style={{ padding: '8px 10px' }}>Active Chart</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>Quick Analysis</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTickers.map((sym) => {
                    const t = ticks[sym];
                    const isPos = (t?.changePct ?? 0) >= 0;
                    const isSelected = selectedTicker === sym;

                    return (
                      <tr
                        key={sym}
                        onClick={() => setSelectedTicker(sym)}
                        style={{
                          borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                          background: isSelected ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
                          cursor: 'pointer',
                          transition: 'background 0.15s ease',
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        <td style={{ padding: '10px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <strong style={{ color: isSelected ? 'var(--color-accent-bright)' : '#fff', fontWeight: 600 }}>
                              {sym}
                            </strong>
                            <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)' }}>
                              {assetNames[sym] || sym}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: '10px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#fff' }}>
                          {t ? `$${t.price.toFixed(2)}` : '—'}
                        </td>
                        <td style={{ padding: '10px' }}>
                          {t ? (
                            <span style={{
                              color: isPos ? 'var(--color-success)' : 'var(--color-danger)',
                              fontWeight: 600,
                            }}>
                              {isPos ? '+' : ''}{(t.changePct * 100).toFixed(2)}%
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ padding: '10px' }}>
                          {isSelected ? (
                            <span style={{
                              padding: '2px 8px',
                              borderRadius: 4,
                              background: 'rgba(59, 130, 246, 0.2)',
                              color: 'var(--color-accent-bright)',
                              fontSize: '0.7rem',
                              fontWeight: 600,
                            }}>
                              Active
                            </span>
                          ) : (
                            <span style={{ color: 'var(--color-text-muted)', fontSize: '0.7rem' }}>
                              Select
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '10px', textAlign: 'right' }}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedTicker(sym);
                              setChatInput(`Analyze technical indicators, momentum, and statistical levels for ${sym}`);
                            }}
                            className="btn btn-secondary"
                            style={{ padding: '3px 8px', fontSize: '0.7rem' }}
                          >
                            Analyze
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
          </div>

          {/* === RIGHT COLUMN — AI ADVISOR CHAT === */}
          <div className="card" style={{
            display: 'flex', flexDirection: 'column',
            height: 780, overflow: 'hidden',
          }}>
            {/* Chat header */}
            <div style={{
              padding: '16px 20px',
              borderBottom: '1px solid var(--color-border)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{
                width: 36, height: 36,
                background: 'var(--color-accent-gradient)',
                borderRadius: 'var(--radius-md)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <MessageSquare size={18} color="white" />
              </div>
              <div>
                <p style={{ fontWeight: 600, fontSize: '0.9rem' }}>AI Advisor</p>
                <p style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>
                  Powered by Qwen-2.5-72B · LangGraph
                </p>
              </div>
              <span className="badge badge-success" style={{ marginLeft: 'auto' }}>Online</span>
            </div>

            {/* Messages */}
            <div style={{
              flex: 1, overflowY: 'auto',
              padding: '16px 20px',
              display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              {messages.length === 0 && (
                <div style={{ textAlign: 'center', marginTop: 24, padding: '0 8px' }}>
                  <Zap size={28} color="var(--color-accent-bright)" style={{ margin: '0 auto 10px' }} />
                  <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem', fontWeight: 600 }}>
                    AI Financial Advisor & Quantitative Engine
                  </p>
                  <p style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem', marginTop: 4 }}>
                    Ask about any asset, active chart, or compare the entire watchlist:
                  </p>
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    marginTop: 16,
                    textAlign: 'left',
                  }}>
                    {[
                      { icon: '📈', label: `Analyze active chart (${selectedTicker})`, query: `Analyze technical indicators, momentum, and statistical levels for ${selectedTicker}` },
                      { icon: '🏆', label: 'Rank all watchlist assets by technical momentum', query: 'Compare all charts and rank watchlist assets by technical momentum and signals' },
                      { icon: '🎯', label: 'Calculate support, resistance & volatility on active chart', query: `Show statistical support, resistance, RSI and Bollinger Bands on this chart` },
                      { icon: '📊', label: 'Show portfolio Sharpe ratio & risk metrics', query: 'Show me my portfolio Sharpe ratio and risk metrics' },
                    ].map((item, idx) => (
                      <button
                        key={idx}
                        onClick={() => {
                          setChatInput(item.query);
                        }}
                        style={{
                          background: 'rgba(255, 255, 255, 0.03)',
                          border: '1px solid rgba(255, 255, 255, 0.08)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '8px 12px',
                          color: 'var(--color-text-secondary)',
                          fontSize: '0.78rem',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          transition: 'all 0.15s ease',
                          textAlign: 'left',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(59, 130, 246, 0.1)';
                          e.currentTarget.style.borderColor = 'var(--color-accent-primary)';
                          e.currentTarget.style.color = 'var(--color-text-primary)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)';
                          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                          e.currentTarget.style.color = 'var(--color-text-secondary)';
                        }}
                      >
                        <span style={{ fontSize: '0.9rem' }}>{item.icon}</span>
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg) => (
                <div key={msg.id} style={{ display: 'flex', flexDirection: 'column' }}>
                  <div className={msg.role === 'user' ? 'message-user' : 'message-assistant'}>
                    <FormattedChatMessage content={msg.content} />
                    {msg.requiresConfirmation && (
                      <div style={{
                        marginTop: 10,
                        padding: '8px 12px',
                        background: 'rgba(245, 158, 11, 0.15)',
                        border: '1px solid rgba(245, 158, 11, 0.4)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: '0.78rem',
                        color: 'var(--color-warning)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}>
                        <span>⚠️</span>
                        <span>Action requires two-factor authorization to execute.</span>
                      </div>
                    )}
                  </div>
                  {msg.complianceDisclaimer && (
                    <details style={{
                      fontSize: '0.65rem',
                      color: 'var(--color-text-muted)',
                      marginTop: 4,
                      paddingLeft: 4,
                      maxWidth: '90%',
                      cursor: 'pointer',
                    }}>
                      <summary style={{ opacity: 0.7, outline: 'none' }}>
                        ⚖️ MiFID II / SEC Compliance Notice
                      </summary>
                      <p style={{ marginTop: 4, lineHeight: 1.4, opacity: 0.85 }}>
                        {msg.complianceDisclaimer}
                      </p>
                    </details>
                  )}
                </div>
              ))}
              {chatLoading && (
                <div className="message-assistant">
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '4px 0' }}>
                    {[0, 1, 2].map((i) => (
                      <div key={i} style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: 'var(--color-accent-bright)',
                        animation: `pulse-ring 1.4s ease-in-out ${i * 0.2}s infinite`,
                      }} />
                    ))}
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input */}
            <div style={{
              padding: '12px 16px',
              borderTop: '1px solid var(--color-border)',
              display: 'flex', gap: 8,
            }}>
              <input
                className="input"
                id="chat-input"
                placeholder="Ask about portfolio metrics, risk, or filings..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                disabled={chatLoading}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-primary"
                id="chat-send-btn"
                onClick={() => sendMessage()}
                disabled={!chatInput.trim() || chatLoading}
                style={{ flexShrink: 0 }}
              >
                {chatLoading ? <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} /> : '→'}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
