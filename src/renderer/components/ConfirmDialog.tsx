import React from 'react';

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  'data-testid'?: string;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  'data-testid': testId = 'confirm-dialog',
}: ConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[60] animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[480px] shadow-dialog animate-slide-up">
        <div className="px-6 py-4 border-b border-sandstorm-border">
          <h2 className="text-base font-semibold text-sandstorm-text">{title}</h2>
        </div>
        <div className="px-6 py-5">
          <p className="text-xs text-sandstorm-text-secondary">{body}</p>
        </div>
        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-all active:scale-[0.98]"
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
