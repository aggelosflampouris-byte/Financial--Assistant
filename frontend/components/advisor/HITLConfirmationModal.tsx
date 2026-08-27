/**
 * frontend/components/advisor/HITLConfirmationModal.tsx
 * Human-in-the-Loop confirmation modal — intercepts transactional agent actions
 * and requires explicit user confirmation with 2FA-like UX before execution.
 */
'use client';

import { useState, useCallback } from 'react';
import { AlertTriangle, CheckCircle, XCircle, Clock } from 'lucide-react';
import { usePortfolioStore, HITLRequest } from '@/store/portfolioStore';

interface HITLConfirmationModalProps {
  request: HITLRequest;
  onConfirm: (actionId: string, token: string) => Promise<void>;
  onReject: () => void;
}

export function HITLConfirmationModal({
  request,
  onConfirm,
  onReject,
}: HITLConfirmationModalProps) {
  const [confirmText, setConfirmText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The user must type "CONFIRM" to enable the button — mirrors real 2FA UX
  const REQUIRED_TEXT = 'CONFIRM';
  const isTextValid = confirmText.trim().toUpperCase() === REQUIRED_TEXT;

  const riskColors: Record<string, string> = {
    HIGH: 'var(--color-danger)',
    MEDIUM: 'var(--color-warning)',
    LOW: 'var(--color-success)',
  };
  const riskColor = riskColors[request.riskLevel] ?? 'var(--color-warning)';

  const handleConfirm = useCallback(async () => {
    if (!isTextValid || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      // In production: call Auth0 MFA API to get a signed token
      // For now, generate a placeholder token (replace with real 2FA)
      const mockToken = `hitl-${request.actionId}-${Date.now()}-confirmed`;
      await onConfirm(request.actionId, mockToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed');
      setIsSubmitting(false);
    }
  }, [isTextValid, isSubmitting, request.actionId, onConfirm]);

  const expiresAt = new Date(request.expiresAt);
  const minutesLeft = Math.max(
    0,
    Math.ceil((expiresAt.getTime() - Date.now()) / 60000)
  );

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true"
         aria-labelledby="hitl-title">
      <div className="modal-panel">

        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 24,
        }}>
          <div style={{
            width: 44,
            height: 44,
            borderRadius: 'var(--radius-md)',
            background: `rgba(245, 158, 11, 0.15)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <AlertTriangle size={22} color="var(--color-warning)" />
          </div>
          <div>
            <h2 id="hitl-title" style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              marginBottom: 2,
            }}>
              Action Requires Confirmation
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className={`badge badge-${request.riskLevel === 'HIGH' ? 'danger' : 'warning'}`}>
                {request.riskLevel} RISK
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                <Clock size={12} style={{ display: 'inline', marginRight: 4 }} />
                Expires in {minutesLeft} min
              </span>
            </div>
          </div>
        </div>

        {/* Action Summary */}
        <div style={{
          background: 'rgba(59, 130, 246, 0.06)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: '14px 16px',
          marginBottom: 20,
        }}>
          <p style={{ fontSize: '0.875rem', lineHeight: 1.6 }}>
            {request.actionSummary}
          </p>
        </div>

        {/* Action details */}
        {Object.entries(request.actionPayload).length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <p style={{
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--color-text-muted)',
              marginBottom: 8,
              fontWeight: 600,
            }}>
              Order Details
            </p>
            <pre style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              background: 'rgba(0,0,0,0.3)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
              overflowX: 'auto',
              color: 'var(--color-text-secondary)',
              maxHeight: 140,
              overflow: 'auto',
            }}>
              {JSON.stringify(request.actionPayload, null, 2)}
            </pre>
          </div>
        )}

        {/* Confirmation input */}
        <div style={{ marginBottom: 20 }}>
          <label htmlFor="confirm-input" style={{
            display: 'block',
            fontSize: '0.8rem',
            color: 'var(--color-text-secondary)',
            marginBottom: 8,
          }}>
            Type <strong style={{ color: 'var(--color-text-primary)' }}>CONFIRM</strong> to proceed:
          </label>
          <input
            id="confirm-input"
            className="input"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
            placeholder="CONFIRM"
            autoComplete="off"
            disabled={isSubmitting}
            aria-describedby={error ? 'confirm-error' : undefined}
          />
          {error && (
            <p id="confirm-error" style={{
              fontSize: '0.8rem',
              color: 'var(--color-danger)',
              marginTop: 6,
            }}>
              {error}
            </p>
          )}
        </div>

        {/* Compliance disclaimer */}
        <p style={{
          fontSize: '0.7rem',
          color: 'var(--color-text-muted)',
          lineHeight: 1.5,
          marginBottom: 20,
          padding: '10px 12px',
          background: 'rgba(0,0,0,0.2)',
          borderRadius: 'var(--radius-sm)',
        }}>
          {request.complianceNote}
        </p>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            className="btn btn-secondary"
            onClick={onReject}
            disabled={isSubmitting}
            style={{ flex: 1 }}
            id="hitl-reject-btn"
          >
            <XCircle size={16} />
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={!isTextValid || isSubmitting}
            style={{
              flex: 2,
              opacity: isTextValid ? 1 : 0.4,
              cursor: isTextValid ? 'pointer' : 'not-allowed',
            }}
            id="hitl-confirm-btn"
          >
            {isSubmitting ? (
              <>Processing...</>
            ) : (
              <>
                <CheckCircle size={16} />
                Confirm & Execute
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
