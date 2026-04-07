import React from 'react';
import { useAppStore, ThresholdLevel, AccountUsage } from '../store';
import { formatTokenCount } from '../utils/format';

interface Props {
  level: ThresholdLevel;
  usage: AccountUsage | null;
  onClose: () => void;
}

export function SessionWarningModal({ level, usage, onClose }: Props) {
  const {
    sessionHaltAll,
    sessionAcknowledgeCritical,
    sessionResumeAll,
    refreshStacks,
  } = useAppStore();

  const resetIn = usage?.reset_in ?? 'unknown';
  const resetAt = usage?.reset_at
    ? new Date(usage.reset_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  const handleHaltAll = async () => {
    await sessionHaltAll();
    onClose();
  };

  const handleContinue = async () => {
    await sessionAcknowledgeCritical();
    onClose();
  };

  const handleResumeOverride = async () => {
    await sessionResumeAll();
    await refreshStacks();
    onClose();
  };

  if (level === 'critical') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="session-warning-modal">
        <div className="bg-sandstorm-surface border border-amber-500/30 rounded-xl shadow-2xl w-[420px] p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-sandstorm-text">Approaching Session Limit</h2>
              <p className="text-xs text-amber-400 font-medium">{Math.round(usage?.percent ?? 95)}% of session tokens used</p>
            </div>
          </div>

          <p className="text-sm text-sandstorm-text-secondary mb-1">
            You're about to hit your session token limit. Extra usage will be <span className="text-amber-400 font-medium">significantly more expensive</span>.
          </p>
          {usage && usage.limit_tokens > 0 && (
            <p className="text-xs text-sandstorm-muted mb-4">
              {formatTokenCount(usage.used_tokens)} / {formatTokenCount(usage.limit_tokens)} tokens used
              {resetAt && <> &middot; Resets at {resetAt}</>}
            </p>
          )}

          <div className="flex flex-col gap-2">
            <button
              onClick={handleHaltAll}
              className="w-full py-2 px-4 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded-lg transition-colors"
              data-testid="halt-all-button"
            >
              Halt All Stacks
            </button>
            <button
              onClick={handleContinue}
              className="w-full py-2 px-4 bg-sandstorm-surface-hover hover:bg-sandstorm-border text-sandstorm-text-secondary text-sm rounded-lg transition-colors"
              data-testid="continue-button"
            >
              Continue (I accept extra usage costs)
            </button>
            <button
              onClick={onClose}
              className="w-full py-1.5 text-xs text-sandstorm-muted hover:text-sandstorm-text-secondary transition-colors"
              data-testid="remind-later-button"
            >
              Remind me at 100%
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (level === 'limit' || level === 'over_limit') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="session-warning-modal">
        <div className="bg-sandstorm-surface border border-red-500/30 rounded-xl shadow-2xl w-[420px] p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center shrink-0 animate-pulse">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-400">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-sandstorm-text">Session Token Limit Reached</h2>
              <p className="text-xs text-red-400 font-medium">All stacks have been halted</p>
            </div>
          </div>

          <p className="text-sm text-sandstorm-text-secondary mb-1">
            All running stacks have been halted to prevent extra usage charges.
          </p>
          <p className="text-xs text-sandstorm-muted mb-4">
            Your session resets {resetAt ? `at ${resetAt}` : `in ${resetIn}`}.
          </p>

          <div className="flex flex-col gap-2">
            <button
              onClick={onClose}
              className="w-full py-2 px-4 bg-sandstorm-surface-hover hover:bg-sandstorm-border text-sandstorm-text text-sm font-medium rounded-lg transition-colors"
              data-testid="dismiss-button"
            >
              OK
            </button>
            <button
              onClick={handleResumeOverride}
              className="w-full py-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
              data-testid="resume-override-button"
            >
              Resume stacks (extra usage will apply)
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
