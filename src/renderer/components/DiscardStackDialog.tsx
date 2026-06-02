import React from 'react';

interface DiscardStackDialogProps {
  onBackToBacklog: () => void;
  onCloseTicket: () => void;
  onCancel: () => void;
  'data-testid'?: string;
}

export function DiscardStackDialog({
  onBackToBacklog,
  onCloseTicket,
  onCancel,
  'data-testid': testId = 'discard-stack-dialog',
}: DiscardStackDialogProps) {
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[60] animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      aria-label="Discard stack"
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[480px] shadow-dialog animate-slide-up">
        <div className="px-6 py-4 border-b border-sandstorm-border">
          <h2 className="text-base font-semibold text-sandstorm-text">Discard stack</h2>
        </div>
        <div className="px-6 py-5">
          <p className="text-xs text-sandstorm-text-secondary">
            This will tear down the local stack and all changes it made. Any already-created remote PR will not be closed — you can close it on GitHub or Jira manually. What would you like to do with the ticket?
          </p>
        </div>
        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
            data-testid="discard-dialog-cancel"
          >
            Cancel
          </button>
          <button
            onClick={onCloseTicket}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover border border-sandstorm-border"
            data-testid="discard-dialog-close-ticket"
          >
            Close ticket
          </button>
          <button
            onClick={onBackToBacklog}
            className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-all active:scale-[0.98]"
            data-testid="discard-dialog-back-to-backlog"
          >
            Back to backlog
          </button>
        </div>
      </div>
    </div>
  );
}
