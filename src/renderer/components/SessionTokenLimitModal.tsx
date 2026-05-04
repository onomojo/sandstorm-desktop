import React from 'react';
import { useAppStore } from '../store';

export function SessionTokenLimitModal() {
  const { sessionTokenLimitModal, setSessionTokenLimitModal } = useAppStore();

  if (!sessionTokenLimitModal) return null;

  const { resetAt } = sessionTokenLimitModal;

  let resetLabel = 'later';
  if (resetAt) {
    try {
      resetLabel = new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      // invalid date — keep default
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="session-token-limit-modal"
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-orange-400">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
          </div>
          <h2 className="text-[15px] font-semibold text-sandstorm-text">Token limit not yet refreshed</h2>
        </div>
        <p className="text-[13px] text-sandstorm-text-secondary mb-4">
          The account's usage window hasn't reset yet.{' '}
          {resetAt
            ? <>Resume will be available at <span className="font-medium text-sandstorm-text">{resetLabel}</span>.</>
            : 'Resume will be available once the limit refreshes.'}
        </p>
        <button
          onClick={() => setSessionTokenLimitModal(null)}
          className="w-full text-[13px] font-medium px-4 py-2 rounded-lg bg-sandstorm-accent/10 text-sandstorm-accent border border-sandstorm-accent/30 hover:bg-sandstorm-accent/20 transition-colors"
          data-testid="session-token-limit-modal-dismiss"
        >
          OK
        </button>
      </div>
    </div>
  );
}
