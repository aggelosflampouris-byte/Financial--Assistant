/**
 * frontend/components/alerts/AlertsNotificationManager.tsx
 * Institutional Real-Time Technical & Risk Signals Alert Manager:
 * - Technical Rule Triggers (Price thresholds, Golden/Death Crosses, RSI Oversold/Overbought, S/R Breakouts)
 * - Risk Guardrail Triggers (Max Drawdown Circuit Breaker, Single-Asset Concentration Breach)
 * - Live Triggered Alerts Log & Push Dispatch Center
 */
'use client';

import { useState } from 'react';
import {
  Bell,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Zap,
  TrendingUp,
  TrendingDown,
  ShieldAlert,
} from 'lucide-react';
import { usePortfolioStore } from '@/store/portfolioStore';

export interface AlertRule {
  id: string;
  ticker: string;
  condition:
    | 'PRICE_ABOVE'
    | 'PRICE_BELOW'
    | 'RSI_OVERSOLD'
    | 'RSI_OVERBOUGHT'
    | 'GOLDEN_CROSS'
    | 'DEATH_CROSS'
    | 'DRAWDOWN_BREACH';
  thresholdValue?: number;
  enabled: boolean;
  createdAt: string;
}

export interface TriggeredAlert {
  id: string;
  timestamp: string;
  ticker: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

interface AlertsNotificationManagerProps {
  onSelectTicker?: (ticker: string) => void;
  onSendChatQuery?: (query: string) => void;
}

export function AlertsNotificationManager({
  onSelectTicker,
  onSendChatQuery,
}: AlertsNotificationManagerProps) {
  const [selectedTicker, setSelectedTicker] = useState('AAPL');
  const [condition, setCondition] = useState<AlertRule['condition']>('PRICE_ABOVE');
  const [threshold, setThreshold] = useState('320.00');

  const [rules, setRules] = useState<AlertRule[]>([
    {
      id: 'rule-1',
      ticker: 'AAPL',
      condition: 'PRICE_ABOVE',
      thresholdValue: 320.0,
      enabled: true,
      createdAt: 'Today, 08:00',
    },
    {
      id: 'rule-2',
      ticker: 'NVDA',
      condition: 'RSI_OVERBOUGHT',
      thresholdValue: 70.0,
      enabled: true,
      createdAt: 'Today, 08:15',
    },
    {
      id: 'rule-3',
      ticker: 'ALL',
      condition: 'DRAWDOWN_BREACH',
      thresholdValue: 2.5,
      enabled: true,
      createdAt: 'Today, 08:30',
    },
  ]);

  const [triggeredAlerts, setTriggeredAlerts] = useState<TriggeredAlert[]>([
    {
      id: 'trig-1',
      timestamp: '10:14:22',
      ticker: 'NVDA',
      message: 'RSI (14) crossed above 70.0 (Overbought). Momentum exhaustion risk.',
      severity: 'WARNING',
    },
    {
      id: 'trig-2',
      timestamp: '09:45:10',
      ticker: 'AAPL',
      message: 'Golden Cross detected: SMA 20 ($314.20) crossed above SMA 50 ($312.80).',
      severity: 'INFO',
    },
  ]);

  const handleAddRule = (e: React.FormEvent) => {
    e.preventDefault();
    const newRule: AlertRule = {
      id: `rule-${Date.now()}`,
      ticker: selectedTicker,
      condition,
      thresholdValue: parseFloat(threshold) || undefined,
      enabled: true,
      createdAt: 'Just now',
    };
    setRules((prev) => [newRule, ...prev]);
  };

  const toggleRule = (id: string) => {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  };

  const deleteRule = (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="card" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 'var(--radius-md)',
              background: 'rgba(234, 179, 8, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#eab308',
            }}
          >
            <Bell size={18} />
          </div>
          <div>
            <h3 style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--color-text-primary)' }}>
              Real-Time Signals & Risk Alerts Engine
            </h3>
            <p style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
              Automated trigger rules for price breakouts, moving average crosses, RSI divergence, and portfolio circuit breakers.
            </p>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: 20, alignItems: 'start' }}>
        {/* Create Rule Form */}
        <form
          onSubmit={handleAddRule}
          style={{
            background: 'rgba(15, 23, 42, 0.7)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--color-border)',
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <h4 style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff' }}>Configure New Alert Trigger</h4>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: 10 }}>
            <div>
              <label style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>Target Asset</label>
              <select
                value={selectedTicker}
                onChange={(e) => setSelectedTicker(e.target.value)}
                className="input"
                style={{ marginTop: 4, padding: '6px 8px', fontSize: '0.78rem' }}
              >
                {['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'SPY', 'ALL'].map((s) => (
                  <option key={s} value={s} style={{ background: '#0f172a' }}>
                    {s === 'ALL' ? 'Entire Portfolio (NAV)' : s}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>Trigger Condition</label>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value as AlertRule['condition'])}
                className="input"
                style={{ marginTop: 4, padding: '6px 8px', fontSize: '0.78rem' }}
              >
                <option value="PRICE_ABOVE" style={{ background: '#0f172a' }}>Price Breaks Above Target</option>
                <option value="PRICE_BELOW" style={{ background: '#0f172a' }}>Price Breaks Below Target</option>
                <option value="RSI_OVERSOLD" style={{ background: '#0f172a' }}>RSI Oversold (&lt; 30)</option>
                <option value="RSI_OVERBOUGHT" style={{ background: '#0f172a' }}>RSI Overbought (&gt; 70)</option>
                <option value="GOLDEN_CROSS" style={{ background: '#0f172a' }}>Golden Cross (SMA 20 &gt; 50)</option>
                <option value="DEATH_CROSS" style={{ background: '#0f172a' }}>Death Cross (SMA 20 &lt; 50)</option>
                <option value="DRAWDOWN_BREACH" style={{ background: '#0f172a' }}>Max Drawdown Breach (&gt; 2.5%)</option>
              </select>
            </div>
          </div>

          {(condition === 'PRICE_ABOVE' || condition === 'PRICE_BELOW') && (
            <div>
              <label style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>Threshold Value ($)</label>
              <input
                type="number"
                step="0.01"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="input"
                style={{ marginTop: 4, padding: '6px 8px', fontSize: '0.78rem', fontFamily: 'var(--font-mono)' }}
              />
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ padding: '8px 0', fontSize: '0.78rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 4 }}
          >
            <Plus size={14} />
            <span>Create Alert Trigger</span>
          </button>
        </form>

        {/* Triggered Alerts Stream */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{
              background: 'rgba(15, 23, 42, 0.7)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--color-border)',
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              minHeight: 220,
            }}
          >
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--color-text-primary)' }}>
              Live Triggered Signals Stream ({triggeredAlerts.length})
            </span>

            {triggeredAlerts.map((t) => (
              <div
                key={t.id}
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {t.severity === 'CRITICAL' ? (
                    <ShieldAlert size={16} color="var(--color-danger)" />
                  ) : t.severity === 'WARNING' ? (
                    <AlertTriangle size={16} color="var(--color-warning)" />
                  ) : (
                    <Zap size={16} color="var(--color-accent-bright)" />
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <strong style={{ color: '#fff', fontSize: '0.75rem' }}>${t.ticker}</strong>
                      <span style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {t.timestamp}
                      </span>
                    </div>
                    <span style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                      {t.message}
                    </span>
                  </div>
                </div>

                <button
                  onClick={() =>
                    onSendChatQuery?.(
                      `Analyze the implications of this signal: "${t.message}" on ${t.ticker} and advise on trade positioning.`
                    )
                  }
                  className="btn btn-secondary"
                  style={{ padding: '3px 8px', fontSize: '0.68rem', whiteSpace: 'nowrap' }}
                >
                  Analyze
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
