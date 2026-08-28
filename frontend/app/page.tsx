'use client';

/**
 * frontend/app/page.tsx
 * Main Dashboard — financial metrics cards, live chart, and AI advisor chat.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TrendingUp, TrendingDown, Shield, Zap, Activity,
  BarChart3, MessageSquare, RefreshCw, AlertCircle, Wallet, DollarSign,
  PieChart, Sliders, Send, Building2, Newspaper, Layers, UploadCloud, Bell, FileText, Briefcase
} from 'lucide-react';
import { TradingViewChart } from '@/components/charts/TradingViewChart';
import { PortfolioAllocationView } from '@/components/portfolio/PortfolioAllocationView';
import { OrderManagementTicket } from '@/components/trading/OrderManagementTicket';
import { QuantRiskStudio } from '@/components/risk/QuantRiskStudio';
import { FundamentalsStudio } from '@/components/fundamentals/FundamentalsStudio';
import { MarketNewsWire } from '@/components/news/MarketNewsWire';
import { DocumentAttachmentStudio } from '@/components/documents/DocumentAttachmentStudio';
import { AlertsNotificationManager } from '@/components/alerts/AlertsNotificationManager';
import { ResearchReportCard, ResearchReportData } from '@/components/advisor/ResearchReportCard';
import { HITLConfirmationModal } from '@/components/advisor/HITLConfirmationModal';
import { usePortfolioStore } from '@/store/portfolioStore';
import { DEFAULT_TICKERS, ASSET_NAMES, API_BASE } from '@/constants/market';

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
  reportData?: ResearchReportData;
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

export default function DashboardPage() {
  // --- State ---
  const [selectedTicker, setSelectedTicker] = useState('AAPL');
  const [dashboardTab, setDashboardTab] = useState<'holdings' | 'trading' | 'risk' | 'fundamentals' | 'news' | 'documents' | 'alerts' | 'watchlist'>('holdings');
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
        reportData: data.tool_data?.report_data,
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

      {/* === ACCESSIBLE SKIP LINK === */}
      <a
        href="#main-content"
        className="sr-only"
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 1000,
          background: 'var(--color-accent-primary)',
          color: '#fff',
          padding: '8px 16px',
          borderRadius: 4,
          fontWeight: 600,
        }}
      >
        Skip to main content
      </a>

      {/* === HEADER === */}
      <header
        role="banner"
        className="glass"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          padding: '0 24px',
          minHeight: 64,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 32,
              height: 32,
              background: 'var(--color-accent-gradient)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <BarChart3 size={18} color="white" />
          </div>
          <div>
            <h1 style={{ fontWeight: 700, fontSize: '0.95rem', margin: 0, color: '#fff' }}>
              Apex Financial Assistant
            </h1>
            <p style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', margin: 0 }}>
              Institutional Quantitative Execution & Research
            </p>
          </div>
        </div>

        {/* Center/Right: User's Fixed Portfolio Capital & Active Ticker */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Active Asset Pill */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(59, 130, 246, 0.08)',
              border: '1px solid rgba(59, 130, 246, 0.25)',
              padding: '4px 12px',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>Active Asset:</span>
            <strong style={{ fontSize: '0.85rem', color: 'var(--color-accent-bright)' }}>{selectedTicker}</strong>
            {ticks[selectedTicker] && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: '#fff' }}>
                ${ticks[selectedTicker].price.toFixed(2)}
              </span>
            )}
          </div>

          {/* Fixed $100k Capital Badge */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(16, 185, 129, 0.08)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              padding: '4px 12px',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: 'rgba(16, 185, 129, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-success)',
              }}
            >
              <Wallet size={12} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '0.62rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                Fixed Capital
              </span>
              <span style={{ fontSize: '0.88rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--color-success)' }}>
                ${capital.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="live-indicator pulsing" aria-label="Real-time live market feed active">LIVE</span>
            <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>MiFID II</span>
          </div>
        </div>
      </header>

      {/* === MAIN DASHBOARD === */}
      <main id="main-content" className="dashboard-main" tabIndex={-1}>

        {/* === TICKER NAVIGATION STRIP === */}
        <nav role="navigation" aria-label="Watchlist asset selector" className="ticker-strip">
          {DEFAULT_TICKERS.map((t) => {
            const tick = ticks[t];
            const isPositive = (tick?.changePct ?? 0) >= 0;
            const isSelected = selectedTicker === t;
            return (
              <button
                key={t}
                onClick={() => setSelectedTicker(t)}
                aria-pressed={isSelected}
                style={{
                  background: isSelected ? 'var(--color-bg-elevated)' : 'rgba(255, 255, 255, 0.02)',
                  border: `1px solid ${isSelected ? 'var(--color-accent-primary)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-md)',
                  padding: '8px 14px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  minWidth: 105,
                  transition: 'all var(--transition-fast)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.85rem', color: isSelected ? 'var(--color-accent-bright)' : '#fff' }}>
                    {t}
                  </span>
                  {isSelected && (
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-accent-bright)' }} />
                  )}
                </div>
                {tick ? (
                  <>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-text-primary)' }}>
                      ${tick.price.toFixed(2)}
                    </span>
                    <span style={{
                      fontSize: '0.7rem',
                      fontWeight: 600,
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
        </nav>

        {/* === RESPONSIVE 2-COLUMN GRID === */}
        <div className="dashboard-grid">

          {/* === LEFT COLUMN: CHART & WORKSPACE STUDIOS === */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* Interactive Chart Canvas */}
            <section aria-label="Technical Candlestick Chart" className="card" style={{ overflow: 'hidden' }}>
              <TradingViewChart ticker={selectedTicker} height={460} />
            </section>

            {/* Essential Portfolio Metrics */}
            <section aria-label="Quantitative Risk & Return Metrics" className="metrics-row">
              <MetricCard
                label="Portfolio NAV"
                value={`$${capital.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                sub="100% Cash / NAV · Fixed"
                icon={Wallet}
                positive={true}
                loading={false}
              />
              <MetricCard
                label="Sharpe Ratio"
                value={formatNum(metrics?.sharpeRatio)}
                sub="Risk-adjusted alpha"
                icon={TrendingUp}
                positive={(metrics?.sharpeRatio ?? 0) > 1}
                loading={metricsLoading}
              />
              <MetricCard
                label="Sortino Ratio"
                value={formatNum(metrics?.sortinoRatio)}
                sub="Downside risk protection"
                icon={Shield}
                positive={(metrics?.sortinoRatio ?? 0) > 1}
                loading={metricsLoading}
              />
              <MetricCard
                label="Max Drawdown"
                value={formatPct(metrics?.maxDrawdown)}
                sub="Peak-to-trough risk"
                icon={TrendingDown}
                positive={false}
                loading={metricsLoading}
              />
              <MetricCard
                label="CAGR (1Y)"
                value={formatPct(metrics?.cagr)}
                sub="Compounded growth"
                icon={TrendingUp}
                positive={(metrics?.cagr ?? 0) > 0}
                loading={metricsLoading}
              />
              <MetricCard
                label="1D 95% VaR"
                value={metrics?.var95 ? `$${((metrics.var95.varPct || 0.0189) * capital).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${(capital * 0.0189).toFixed(2)}`}
                sub={metrics?.var95 ? `${(metrics.var95.varPct * 100).toFixed(2)}% boundary` : '1.89% boundary'}
                icon={AlertCircle}
                positive={false}
                loading={metricsLoading}
              />
            </section>

            {/* Workspace Studio Navigation Tabs */}
            <div
              role="tablist"
              aria-label="Institutional Analysis Modules"
              className="tab-nav-bar"
            >
              {[
                { id: 'holdings', label: '$100k Portfolio', icon: PieChart },
                { id: 'trading', label: 'Trade OMS', icon: Send },
                { id: 'risk', label: 'Quant Risk Studio', icon: Activity },
                { id: 'fundamentals', label: 'Fundamentals (10-K)', icon: Building2 },
                { id: 'news', label: 'News & Sentiment', icon: Newspaper },
                { id: 'documents', label: 'Documents & RAG', icon: UploadCloud },
              ].map((tab) => {
                const Icon = tab.icon;
                const isActive = dashboardTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    role="tab"
                    id={`tab-${tab.id}`}
                    aria-selected={isActive}
                    aria-controls={`tabpanel-${tab.id}`}
                    onClick={() => setDashboardTab(tab.id as typeof dashboardTab)}
                    className={`btn ${isActive ? 'btn-primary' : 'btn-secondary'}`}
                    style={{
                      fontSize: '0.74rem',
                      padding: '6px 12px',
                      borderRadius: 'var(--radius-md)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <Icon size={13} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Active Studio Content Panel */}
            <div role="tabpanel" id={`tabpanel-${dashboardTab}`} aria-labelledby={`tab-${dashboardTab}`}>
              {dashboardTab === 'holdings' && (
                <PortfolioAllocationView
                  onSelectTicker={(t) => setSelectedTicker(t)}
                  onSendChatQuery={(q) => sendMessage(q)}
                />
              )}

              {dashboardTab === 'trading' && (
                <OrderManagementTicket
                  activeTicker={selectedTicker}
                  onSelectTicker={(t) => setSelectedTicker(t)}
                  onSendChatQuery={(q) => sendMessage(q)}
                />
              )}

              {dashboardTab === 'risk' && (
                <QuantRiskStudio />
              )}

              {dashboardTab === 'fundamentals' && (
                <FundamentalsStudio
                  ticker={selectedTicker}
                  onSendChatQuery={(q) => sendMessage(q)}
                />
              )}

              {dashboardTab === 'news' && (
                <MarketNewsWire
                  activeTicker={selectedTicker}
                  onSelectTicker={(t) => setSelectedTicker(t)}
                  onSendChatQuery={(q) => sendMessage(q)}
                />
              )}

              {dashboardTab === 'documents' && (
                <DocumentAttachmentStudio
                  onSendChatQuery={(q) => sendMessage(q)}
                />
              )}

              {dashboardTab === 'alerts' && (
                <AlertsNotificationManager
                  onSelectTicker={(t) => setSelectedTicker(t)}
                  onSendChatQuery={(q) => sendMessage(q)}
                />
              )}
            </div>
          </div>

          {/* === RIGHT COLUMN — AI RESEARCH ADVISOR CHAT === */}
          <div
            role="complementary"
            aria-label="AI Quantitative Research Advisor"
            className="card chat-panel"
            style={{
              display: 'flex',
              flexDirection: 'column',
              height: 780,
              overflow: 'hidden',
            }}
          >
            {/* Chat header */}
            <div style={{
              padding: '12px 18px',
              borderBottom: '1px solid var(--color-border)',
              display: 'flex', alignItems: 'center', gap: 10,
              flexWrap: 'wrap',
            }}>
              <div style={{
                width: 34, height: 34,
                background: 'var(--color-accent-gradient)',
                borderRadius: 'var(--radius-md)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <MessageSquare size={17} color="white" />
              </div>
              <div>
                <p style={{ fontWeight: 600, fontSize: '0.85rem' }}>AI Research Advisor</p>
                <p style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)' }}>
                  LangGraph Quant & Technical Engine
                </p>
              </div>

              {/* 1-Click Research & Portfolio Report Buttons */}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  onClick={() => sendMessage(`Generate institutional research report and technical teardown paper for ${selectedTicker}`)}
                  className="btn btn-secondary"
                  style={{
                    padding: '4px 8px',
                    fontSize: '0.7rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(59, 130, 246, 0.12)',
                    borderColor: 'rgba(59, 130, 246, 0.3)',
                    color: 'var(--color-accent-bright)',
                  }}
                  title={`Generate downloadable research report paper for ${selectedTicker}`}
                >
                  <FileText size={12} />
                  <span>Report ({selectedTicker})</span>
                </button>

                <button
                  onClick={() => sendMessage(`Generate complete report of the full portfolio performance and risk audit`)}
                  className="btn btn-secondary"
                  style={{
                    padding: '4px 8px',
                    fontSize: '0.7rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(16, 185, 129, 0.12)',
                    borderColor: 'rgba(16, 185, 129, 0.3)',
                    color: 'var(--color-success)',
                  }}
                  title="Generate complete audit report for the full $100,000 portfolio"
                >
                  <Briefcase size={12} />
                  <span>Portfolio ($100k)</span>
                </button>
              </div>
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
                      { icon: '💼', label: 'Generate Complete Report of Full Portfolio ($100k)', query: 'Generate complete report of the full portfolio performance and risk audit' },
                      { icon: '📄', label: `Generate Institutional Report Paper (${selectedTicker})`, query: `Generate institutional research report and technical teardown paper for ${selectedTicker}` },
                      { icon: '📈', label: `Analyze active chart (${selectedTicker})`, query: `Analyze technical indicators, momentum, and statistical levels for ${selectedTicker}` },
                      { icon: '🏆', label: 'Rank all watchlist assets by technical momentum', query: 'Compare all charts and rank watchlist assets by technical momentum and signals' },
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
                    {msg.reportData && (
                      <ResearchReportCard report={msg.reportData} />
                    )}
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
