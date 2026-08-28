'use client';

/**
 * frontend/app/page.tsx
 * Main Dashboard — financial metrics cards, live chart, and AI advisor chat.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TrendingUp, TrendingDown, Shield, Zap, Activity,
  BarChart3, MessageSquare, RefreshCw, AlertCircle, Wallet, DollarSign,
  PieChart, Sliders, Send, Building2, Newspaper, Layers, UploadCloud, Bell, FileText, Briefcase,
  Plus, X, Eye, Search, Check
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
// Types & Constants
// ---------------------------------------------------------------------------

const PORTFOLIO_ASSETS = [
  { ticker: 'AAPL', name: 'Apple Inc.', weight: '26.2%' },
  { ticker: 'MSFT', name: 'Microsoft Corp.', weight: '19.9%' },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', weight: '17.7%' },
  { ticker: 'GOOGL', name: 'Alphabet Inc.', weight: '16.8%' },
  { ticker: 'SPY', name: 'SPDR S&P 500 ETF', weight: '11.0%' },
];

const INITIAL_WATCHLIST = ['TSLA', 'AMD', 'AMZN', 'META', 'NFLX', 'COIN'];

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
      <div className="card" style={{ padding: 16 }}>
        <div className="skeleton" style={{ height: 12, width: '60%', marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 32, width: '80%', marginBottom: 8 }} />
        <div className="skeleton" style={{ height: 10, width: '40%' }} />
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <p className="metric-label" style={{ marginBottom: 6 }}>{label}</p>
          <p className="metric-value metric-animated" style={{
            fontSize: '1.45rem',
            color: positive === undefined ? 'var(--color-text-primary)' :
                   positive ? 'var(--color-success)' : 'var(--color-danger)'
          }}>
            {value}
          </p>
          {sub && (
            <p style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
              {sub}
            </p>
          )}
        </div>
        <div style={{
          width: 36, height: 36,
          borderRadius: 'var(--radius-md)',
          background: 'rgba(59, 130, 246, 0.1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon size={16} color="var(--color-accent-bright)" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown & Rich Content Renderer
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
      parts.push(<strong key={match.index} style={{ color: 'var(--color-text-primary)' }}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(<span key={match.index} style={{ fontFamily: 'var(--font-mono)', background: 'rgba(59, 130, 246, 0.1)', color: 'var(--color-accent-bright)', padding: '1px 4px', borderRadius: 4 }}>{token.slice(1, -1)}</span>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(<em key={match.index} style={{ color: 'var(--color-accent-bright)' }}>{token.slice(1, -1)}</em>);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function FormattedChatMessage({ content }: { content: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {content.split('\n').map((line, idx) => (
        <p key={idx} style={{ fontSize: '0.85rem', lineHeight: 1.6, margin: 0 }}>
          {renderInlineTokens(line)}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const [selectedTicker, setSelectedTicker] = useState('AAPL');
  const [watchlistTickers, setWatchlistTickers] = useState<string[]>(INITIAL_WATCHLIST);
  const [showAddTicker, setShowAddTicker] = useState(false);
  const [newTickerInput, setNewTickerInput] = useState('');
  const [dashboardTab, setDashboardTab] = useState<'holdings' | 'trading' | 'risk' | 'fundamentals' | 'news' | 'documents' | 'alerts' | 'watchlist'>('holdings');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const capital = usePortfolioStore((s) => s.capital);
  const metrics = usePortfolioStore((s) => s.metrics);
  const ticks = usePortfolioStore((s) => s.ticks);
  const pendingHITL = usePortfolioStore((s) => s.pendingHITL);
  const setPendingHITL = usePortfolioStore((s) => s.setPendingHITL);
  const clearHITL = usePortfolioStore((s) => s.clearHITL);
  const setMetrics = usePortfolioStore((s) => s.setMetrics);

  const handleAddTicker = (sym?: string) => {
    const raw = (sym || newTickerInput).trim().toUpperCase();
    if (!raw) return;
    if (!PORTFOLIO_ASSETS.some(p => p.ticker === raw) && !watchlistTickers.includes(raw)) {
      setWatchlistTickers(prev => [...prev, raw]);
    }
    setSelectedTicker(raw);
    setShowAddTicker(false);
    setNewTickerInput('');
    fetch(`${API_BASE}/market/quote/${raw}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((q) => {
        if (q) {
          usePortfolioStore.getState().updateTick({
            ticker: q.ticker, price: q.price, changePct: q.change_pct, volume: q.volume, timestamp: q.timestamp,
          });
        }
      })
      .catch(() => {});
  };

  const handleRemoveWatchlist = (sym: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setWatchlistTickers(prev => prev.filter(t => t !== sym));
    if (selectedTicker === sym) setSelectedTicker('AAPL');
  };

  useEffect(() => {
    setMetricsLoading(true);
    fetch(`${API_BASE}/portfolio/00000000-0000-0000-0000-000000000001/metrics`)
      .then((r) => r.json())
      .then((data) => {
        setMetrics(data);
        setMetricsLoading(false);
      })
      .catch(() => setMetricsLoading(false));

    const allSymbols = Array.from(new Set([...PORTFOLIO_ASSETS.map(p => p.ticker), ...INITIAL_WATCHLIST]));
    allSymbols.forEach((ticker) => {
      fetch(`${API_BASE}/market/quote/${ticker}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((q) => {
          if (q) {
            usePortfolioStore.getState().updateTick({
              ticker: q.ticker, price: q.price, changePct: q.change_pct, volume: q.volume, timestamp: q.timestamp,
            });
          }
        })
        .catch(() => {});
    });
  }, [setMetrics]);

  useEffect(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);

  const sendMessage = useCallback(async (customMessage?: string) => {
    const text = (typeof customMessage === 'string' ? customMessage : chatInput).trim();
    if (!text || chatLoading) return;
    if (!customMessage) setChatInput('');
    setChatLoading(true);

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, timestamp: new Date() };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const res = await fetch(`${API_BASE}/advisor/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, user_id: 'trader-01', session_id: 'default-session', ticker: selectedTicker }),
      });
      const data = await res.json();
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.reply || 'No response.',
        timestamp: new Date(),
        complianceDisclaimer: data.compliance_disclaimer,
        requiresConfirmation: data.requires_confirmation,
        pendingActionId: data.pending_action_id,
        reportData: data.tool_data?.report_data,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (data.requires_confirmation && data.pending_action_id) {
        setPendingHITL({
          actionId: data.pending_action_id,
          sessionId: 'default-session',
          actionType: data.action_type || 'trade',
          actionSummary: data.content || 'Action requires user authorization.',
          actionPayload: data.action_payload || {},
          riskLevel: 'HIGH',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          complianceNote: data.compliance_disclaimer,
        });
      }
    } catch {
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: 'Error.', timestamp: new Date() }]);
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, selectedTicker, setPendingHITL]);

  const handleHITLConfirm = async (actionId: string) => {
    try {
      await fetch(`${API_BASE}/advisor/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_id: actionId, confirmed: true }),
      });
      clearHITL();
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: '✅ Executed.', timestamp: new Date() }]);
    } catch {
      clearHITL();
    }
  };

  const formatPct = (v?: number) => v != null ? `${(v * 100).toFixed(2)}%` : '—';
  const formatNum = (v?: number) => v != null ? v.toFixed(2) : '—';

  return (
    <div className="app-container">
      {pendingHITL && <HITLConfirmationModal request={pendingHITL} onConfirm={handleHITLConfirm} onReject={clearHITL} />}
      
      <header role="banner" className="glass" style={{
        position: 'sticky', top: 0, zIndex: 100, padding: '0 20px', minHeight: 64,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--color-border)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 32, height: 32, background: 'var(--color-accent-gradient)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <BarChart3 size={18} color="white" />
          </div>
          <div>
            <h1 style={{ fontWeight: 700, fontSize: '0.95rem', margin: 0 }}>Apex Institutional</h1>
            <p style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)' }}>Quantitative Research Terminal</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.25)', padding: '4px 12px', borderRadius: 8 }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>Active Chart:</span>
            <strong style={{ fontSize: '0.85rem', color: 'var(--color-accent-bright)' }}>{selectedTicker}</strong>
            {ticks[selectedTicker] && <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>${ticks[selectedTicker].price.toFixed(2)}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)', padding: '4px 12px', borderRadius: 8 }}>
            <Wallet size={14} color="var(--color-success)" />
            <span style={{ fontSize: '0.88rem', fontWeight: 700 }}>${capital.toLocaleString()}</span>
          </div>
        </div>
      </header>

      <main id="main-content" className="dashboard-main" tabIndex={-1}>
        <div className="dashboard-layout-3col">
          <aside aria-label="Assets and Watchlist Navigator" className="sidebar-sticky-container">
            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Layers size={15} color="var(--color-accent-bright)" /> <span style={{ fontSize: '0.82rem', fontWeight: 700 }}>Assets</span></div>
              <button onClick={() => setShowAddTicker(!showAddTicker)} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '0.7rem' }}>{showAddTicker ? <X size={12}/> : <Plus size={12}/>}</button>
            </div>
            {showAddTicker && (
              <div style={{ padding: 10, background: 'rgba(59, 130, 246, 0.05)', display: 'flex', gap: 6 }}>
                <input className="input" value={newTickerInput} onChange={(e) => setNewTickerInput(e.target.value)} autoFocus style={{ padding: '4px 8px', fontSize: '0.75rem', width: '100%' }} />
                <button onClick={() => handleAddTicker()} className="btn btn-primary" style={{ padding: '3px 8px', fontSize: '0.7rem' }}>Add</button>
              </div>
            )}
            <div className="sidebar-scroll-area">
              <div className="sidebar-section-header"><span>Portfolio</span></div>
              {PORTFOLIO_ASSETS.map((p) => (
                <button key={p.ticker} onClick={() => setSelectedTicker(p.ticker)} className={`ticker-item-card ${selectedTicker === p.ticker ? 'active' : ''}`}>
                  <div><strong>{p.ticker}</strong><br/><span style={{ fontSize: '0.65rem' }}>{p.name}</span></div>
                  <div>${ticks[p.ticker]?.price.toFixed(2) || '—'}</div>
                </button>
              ))}
              <div className="sidebar-section-header" style={{ marginTop: 12 }}><span>Watchlist</span></div>
              {watchlistTickers.map((t) => (
                <div key={t} onClick={() => setSelectedTicker(t)} className={`ticker-item-card ${selectedTicker === t ? 'active' : ''}`} style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <strong>{t}</strong>
                  <button onClick={(e) => handleRemoveWatchlist(t, e)} style={{ background: 'none', border: 'none', color: '#666' }}><X size={12}/></button>
                </div>
              ))}
            </div>
          </aside>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* 1. Interactive Candlestick Chart */}
            <section aria-label="Technical Candlestick Chart" className="card" style={{ overflow: 'hidden' }}>
              <TradingViewChart ticker={selectedTicker} height={440} />
            </section>

            {/* 2. 6 Essential Portfolio Metrics Cards */}
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
                value={formatNum(metrics?.sharpeRatio ?? 1.48)}
                sub="Risk-adjusted alpha"
                icon={TrendingUp}
                positive={(metrics?.sharpeRatio ?? 1.48) > 1}
                loading={metricsLoading}
              />
              <MetricCard
                label="Sortino Ratio"
                value={formatNum(metrics?.sortinoRatio ?? 2.12)}
                sub="Downside risk protection"
                icon={Shield}
                positive={(metrics?.sortinoRatio ?? 2.12) > 1}
                loading={metricsLoading}
              />
              <MetricCard
                label="Max Drawdown"
                value={formatPct(metrics?.maxDrawdown ?? -0.141)}
                sub="Peak-to-trough risk"
                icon={TrendingDown}
                positive={false}
                loading={metricsLoading}
              />
              <MetricCard
                label="CAGR (1Y)"
                value={formatPct(metrics?.cagr ?? 0.3217)}
                sub="Compounded growth"
                icon={TrendingUp}
                positive={(metrics?.cagr ?? 0.3217) > 0}
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

            {/* 3. Tabbed Workspace Studio */}
            <div className="workspace-card">
              {/* Tab Selector Header */}
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
                        fontSize: '0.72rem',
                        padding: '5px 11px',
                        borderRadius: 'var(--radius-sm)',
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
              <div
                role="tabpanel"
                id={`tabpanel-${dashboardTab}`}
                aria-labelledby={`tab-${dashboardTab}`}
                className="workspace-body"
              >
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
          </div>

          {/* ========================================================= */}
          {/* COLUMN 3: RIGHT STICKY AI RESEARCH ADVISOR TERMINAL       */}
          {/* ========================================================= */}
          <aside
            role="complementary"
            aria-label="AI Quantitative Research Advisor"
            className="chat-sticky-container"
          >
            {/* Chat header */}
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--color-border)',
              display: 'flex', alignItems: 'center', gap: 10,
              flexWrap: 'wrap',
              background: 'rgba(13, 18, 32, 0.7)',
            }}>
              <div style={{
                width: 32, height: 32,
                background: 'var(--color-accent-gradient)',
                borderRadius: 'var(--radius-md)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <MessageSquare size={16} color="white" />
              </div>
              <div>
                <p style={{ fontWeight: 600, fontSize: '0.82rem', margin: 0 }}>AI Research Advisor</p>
                <p style={{ fontSize: '0.66rem', color: 'var(--color-text-muted)', margin: 0 }}>
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
            <div className="chat-scroll-area">
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
          </aside>
        </div>
      </main>
    </div>
  );
}
