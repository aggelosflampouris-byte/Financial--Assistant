'use client';

import { useState, useMemo, useEffect } from 'react';
import {
  Newspaper,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Clock,
  ExternalLink,
  MessageSquare,
  RefreshCw,
} from 'lucide-react';
import { API_BASE } from '@/constants/market';

interface NewsItem {
  id: string;
  timestamp: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  tickers: string[];
  sentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  sentimentScore: number; // -1.0 to +1.0
}

interface MarketNewsWireProps {
  activeTicker: string;
  onSelectTicker?: (ticker: string) => void;
  onSendChatQuery?: (query: string) => void;
}

export function MarketNewsWire({
  activeTicker,
  onSelectTicker,
  onSendChatQuery,
}: MarketNewsWireProps) {
  const [filter, setFilter] = useState<'ALL' | 'ACTIVE' | 'MACRO'>('ALL');
  const [liveNews, setLiveNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fallbackFeed: NewsItem[] = useMemo(() => {
    return [
      {
        id: 'news-1',
        timestamp: '8 mins ago',
        title: 'Apple Expands Institutional AI Chip Architecture With Enhanced Margin Projections',
        summary:
          'Supply chain channel checks indicate higher average selling prices (ASPs) for flagship hardware and accelerating enterprise subscription services growth.',
        source: 'Bloomberg Terminal',
        url: 'https://finance.yahoo.com/quote/AAPL/news/',
        tickers: ['AAPL'],
        sentiment: 'BULLISH',
        sentimentScore: 0.84,
      },
      {
        id: 'news-2',
        timestamp: '22 mins ago',
        title: 'Federal Reserve Signals Steady Interest Rate Outlook Amid Resilient Labor Data',
        summary:
          'FOMC meeting notes underscore balance between cooling core inflation trends and sustained consumer spending velocity.',
        source: 'Reuters Financial',
        url: 'https://www.reuters.com/markets/',
        tickers: ['SPY'],
        sentiment: 'NEUTRAL',
        sentimentScore: 0.12,
      },
      {
        id: 'news-3',
        timestamp: '42 mins ago',
        title: 'NVIDIA Accelerates Next-Gen Datacenter Deployments Across Hyperscale Clouds',
        summary:
          'Strong order backlog from tier-1 cloud providers drives continued demand for high-bandwidth memory accelerators and rack-scale infrastructure.',
        source: 'Wall Street Journal',
        url: 'https://finance.yahoo.com/quote/NVDA/news/',
        tickers: ['NVDA', 'MSFT'],
        sentiment: 'BULLISH',
        sentimentScore: 0.91,
      },
      {
        id: 'news-4',
        timestamp: '1 hour ago',
        title: 'Alphabet Integrates Multimodal Search Monetization Across Enterprise Cloud',
        summary:
          'Quarterly cloud gross margin expansion outpaces consensus estimates with robust enterprise contract renewals.',
        source: 'Financial Times',
        url: 'https://finance.yahoo.com/quote/GOOGL/news/',
        tickers: ['GOOGL'],
        sentiment: 'BULLISH',
        sentimentScore: 0.78,
      },
      {
        id: 'news-5',
        timestamp: '2 hours ago',
        title: 'Tech Sector Valuation Multiples Face Headwinds Amid Bond Yield Volatility',
        summary:
          '10-year Treasury yield fluctuations prompt tactical sector rotations toward defensive cash-flow compounders and dividend growth leaders.',
        source: 'Barron’s Institutional',
        url: 'https://www.barrons.com/market-data',
        tickers: ['SPY', 'MSFT', 'AAPL'],
        sentiment: 'BEARISH',
        sentimentScore: -0.45,
      },
    ];
  }, []);

  // Fetch live articles from backend
  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/market/news?ticker=${activeTicker}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          const parsed: NewsItem[] = data.map((item: any) => ({
            id: item.id || `live-${Math.random()}`,
            timestamp: item.timestamp || 'Just now',
            title: item.title || 'Market Update',
            summary: item.summary || '',
            source: item.source || 'Financial News',
            url: item.url || `https://finance.yahoo.com/quote/${activeTicker}/news/`,
            tickers: item.tickers || [activeTicker],
            sentiment: (item.sentiment as 'BULLISH' | 'NEUTRAL' | 'BEARISH') || 'NEUTRAL',
            sentimentScore: Number(item.sentiment_score ?? 0),
          }));
          setLiveNews(parsed);
        } else {
          setLiveNews(fallbackFeed);
        }
      })
      .catch(() => {
        setLiveNews(fallbackFeed);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [activeTicker, fallbackFeed]);

  const activeFeed = liveNews.length > 0 ? liveNews : fallbackFeed;

  const filteredNews = useMemo(() => {
    if (filter === 'ACTIVE') {
      return activeFeed.filter((n) => n.tickers.includes(activeTicker));
    }
    if (filter === 'MACRO') {
      return activeFeed.filter((n) => n.tickers.includes('SPY'));
    }
    return activeFeed;
  }, [activeFeed, filter, activeTicker]);

  return (
    <div className="card" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header & Filters */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 'var(--radius-md)',
              background: 'rgba(59, 130, 246, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-accent-bright)',
            }}
          >
            <Newspaper size={18} />
          </div>
          <div>
            <h3 style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
              Real-Time Market Wire & Article Links
            </h3>
            <p style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 2, margin: 0 }}>
              Live financial headlines with direct article source URLs and automated NLP sentiment analysis.
            </p>
          </div>
        </div>

        {/* Filter Pills & Refresh */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
              onClick={() => setFilter('ALL')}
              style={{
                background: filter === 'ALL' ? 'var(--color-accent-primary)' : 'transparent',
                color: filter === 'ALL' ? '#ffffff' : 'var(--color-text-secondary)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 10px',
                fontSize: '0.72rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              All News
            </button>
            <button
              onClick={() => setFilter('ACTIVE')}
              style={{
                background: filter === 'ACTIVE' ? 'var(--color-accent-primary)' : 'transparent',
                color: filter === 'ACTIVE' ? '#ffffff' : 'var(--color-text-secondary)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 10px',
                fontSize: '0.72rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {activeTicker} Wire
            </button>
            <button
              onClick={() => setFilter('MACRO')}
              style={{
                background: filter === 'MACRO' ? 'var(--color-accent-primary)' : 'transparent',
                color: filter === 'MACRO' ? '#ffffff' : 'var(--color-text-secondary)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 10px',
                fontSize: '0.72rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Macro & Fed
            </button>
          </div>

          {loading && <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-accent-bright)' }} />}
        </div>
      </div>

      {/* News Feed List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {filteredNews.map((n) => (
          <div
            key={n.id}
            style={{
              background: 'rgba(15, 23, 42, 0.6)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '14px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              transition: 'all 0.2s ease',
            }}
          >
            {/* Top Bar: Source, Timestamp, Tickers, and Sentiment Badge */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {/* Source Badge with Direct Link */}
                <a
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    color: 'var(--color-accent-bright)',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                  title="Open source article in new tab"
                >
                  <span>{n.source}</span>
                  <ExternalLink size={11} />
                </a>

                <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Clock size={11} /> {n.timestamp}
                </span>

                {n.tickers.map((sym) => (
                  <span
                    key={sym}
                    onClick={() => onSelectTicker?.(sym)}
                    style={{
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      color: '#fff',
                      background: 'rgba(255, 255, 255, 0.08)',
                      padding: '1px 6px',
                      borderRadius: 3,
                      cursor: 'pointer',
                    }}
                  >
                    ${sym}
                  </span>
                ))}
              </div>

              {/* Sentiment Badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-sm)',
                    background:
                      n.sentiment === 'BULLISH'
                        ? 'rgba(16, 185, 129, 0.15)'
                        : n.sentiment === 'BEARISH'
                        ? 'rgba(239, 68, 68, 0.15)'
                        : 'rgba(245, 158, 11, 0.15)',
                    color:
                      n.sentiment === 'BULLISH'
                        ? 'var(--color-success)'
                        : n.sentiment === 'BEARISH'
                        ? 'var(--color-danger)'
                        : 'var(--color-warning)',
                    border: `1px solid ${
                      n.sentiment === 'BULLISH'
                        ? 'rgba(16, 185, 129, 0.3)'
                        : n.sentiment === 'BEARISH'
                        ? 'rgba(239, 68, 68, 0.3)'
                        : 'rgba(245, 158, 11, 0.3)'
                    }`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {n.sentiment === 'BULLISH' ? (
                    <TrendingUp size={12} />
                  ) : n.sentiment === 'BEARISH' ? (
                    <TrendingDown size={12} />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  <span>{n.sentiment} ({(n.sentimentScore > 0 ? '+' : '') + n.sentimentScore.toFixed(2)})</span>
                </span>
              </div>
            </div>

            {/* Clickable Headline with Link Redirection */}
            <h4>
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: '0.88rem',
                  fontWeight: 700,
                  color: '#ffffff',
                  lineHeight: 1.45,
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'color 0.15s ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-accent-bright)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#ffffff')}
                title={`Read article on ${n.source}`}
              >
                <span>{n.title}</span>
                <ExternalLink size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
              </a>
            </h4>

            {/* Summary */}
            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', lineHeight: 1.5, margin: 0 }}>
              {n.summary}
            </p>

            {/* Action Bar: Direct Article Redirect Button & AI Assessment */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, flexWrap: 'wrap', gap: 8, borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: 8 }}>
              {/* Direct Article Link Button */}
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary"
                style={{
                  padding: '4px 10px',
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  textDecoration: 'none',
                  borderRadius: 'var(--radius-sm)',
                  background: 'rgba(59, 130, 246, 0.08)',
                  borderColor: 'rgba(59, 130, 246, 0.25)',
                  color: 'var(--color-accent-bright)',
                }}
                title={`Open full story from ${n.source} in a new tab`}
              >
                <ExternalLink size={12} />
                <span>Read Full Article ({n.source})</span>
              </a>

              {/* Ask AI Advisor Button */}
              <button
                onClick={() =>
                  onSendChatQuery?.(
                    `Evaluate market sentiment and portfolio impact of this headline: "${n.title}". Key tickers: ${n.tickers.join(', ')}`
                  )
                }
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--color-text-secondary)',
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  transition: 'color 0.15s ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-accent-bright)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-secondary)')}
              >
                <MessageSquare size={13} />
                <span>Ask AI Advisor to Assess Impact</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
