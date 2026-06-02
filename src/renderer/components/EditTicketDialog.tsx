import React, { useState, useEffect } from 'react';
import { useAppStore } from '../store';

type Phase = 'loading' | 'input' | 'saving';

export function EditTicketDialog() {
  const { setShowEditTicketDialog, editTicketTarget, refreshBoardTickets } = useAppStore();

  const [body, setBody] = useState('');
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);

  const close = () => setShowEditTicketDialog(false);

  useEffect(() => {
    if (!editTicketTarget) return;
    window.sandstorm.tickets.fetchRaw(editTicketTarget.ticketId, editTicketTarget.projectDir)
      .then((rawBody) => {
        setBody(rawBody ?? '');
        setPhase('input');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setPhase('input');
      });
  }, [editTicketTarget]);

  const handleSave = async () => {
    if (!editTicketTarget || !body.trim()) return;
    setError(null);
    setPhase('saving');
    try {
      await window.sandstorm.tickets.update(editTicketTarget.projectDir, editTicketTarget.ticketId, body.trim());
      void refreshBoardTickets(editTicketTarget.projectDir);
      close();
    } catch (err: unknown) {
      setPhase('input');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      data-testid="edit-ticket-dialog"
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[640px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">
              Edit Ticket {editTicketTarget ? `#${editTicketTarget.ticketId}` : ''}
            </h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">
              Edit the description body of this ticket
            </p>
          </div>
          <button
            onClick={close}
            className="text-sandstorm-muted hover:text-sandstorm-text transition-colors p-1.5 rounded-md hover:bg-sandstorm-surface-hover"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5" data-testid="edit-ticket-error">
              {error}
            </div>
          )}

          {phase === 'loading' ? (
            <div className="flex items-center justify-center py-8" data-testid="edit-ticket-loading">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="animate-spin text-sandstorm-muted">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="48" strokeDashoffset="32"/>
              </svg>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                Description <span className="text-sandstorm-accent">*</span>
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={phase === 'saving'}
                rows={14}
                placeholder="## Context&#10;&#10;...&#10;&#10;## Verification&#10;&#10;..."
                className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs font-mono text-sandstorm-text resize-y outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                data-testid="edit-ticket-body"
                autoFocus
              />
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={close}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={() => { void handleSave(); }}
            disabled={!body.trim() || phase !== 'input'}
            className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
            data-testid="edit-ticket-submit"
          >
            {phase === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
