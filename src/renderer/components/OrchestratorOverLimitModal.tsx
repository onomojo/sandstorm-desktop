import React from 'react';

interface OrchestratorOverLimitModalProps {
  onDismiss: () => void;
}

// Verbatim copy required by issue #238.
// Do not edit without updating the corresponding test.
export const ORCHESTRATOR_OVER_LIMIT_MESSAGE =
  'Your orchestrator session is too large. Wrap up the current session and start a new one. New stack creation is blocked until you start a new orchestrator session.';

/**
 * Modal shown when the user attempts to create a new stack while the current
 * orchestrator session has ≥250K tokens. Dismissing does NOT unblock stack
 * creation — the user must start a new orchestrator session.
 */
export function OrchestratorOverLimitModal({ onDismiss }: OrchestratorOverLimitModalProps) {
  return (
    <div
      data-testid="orchestrator-over-limit-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="orchestrator-over-limit-title"
      onClick={onDismiss}
    >
      <div
        className="bg-sandstorm-surface border border-red-500/40 rounded-xl shadow-2xl max-w-md w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="orchestrator-over-limit-title"
          className="text-base font-semibold text-red-400 mb-3"
        >
          Orchestrator session too large
        </h2>
        <p className="text-sm text-sandstorm-text-secondary whitespace-pre-wrap">
          {ORCHESTRATOR_OVER_LIMIT_MESSAGE}
        </p>
        <div className="mt-5 flex justify-end">
          <button
            onClick={onDismiss}
            data-testid="orchestrator-over-limit-dismiss"
            className="px-3 py-2 text-sm font-medium text-sandstorm-text bg-sandstorm-surface-hover hover:bg-sandstorm-border rounded-lg transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
