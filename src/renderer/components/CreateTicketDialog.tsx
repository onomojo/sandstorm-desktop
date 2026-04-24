import React, { useState } from 'react';
import { useAppStore } from '../store';

type Phase = 'input' | 'creating' | 'created';

export function CreateTicketDialog() {
  const { setShowCreateTicketDialog, openRefineTicketDialogWith, activeProject } = useAppStore();
  const project = activeProject();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [created, setCreated] = useState<{ url: string; ticketId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => setShowCreateTicketDialog(false);

  const handleCreate = async () => {
    if (!project) {
      setError('Select a project tab first');
      return;
    }
    if (!title.trim() || !body.trim()) {
      setError('Title and body are both required');
      return;
    }
    setError(null);
    setPhase('creating');
    try {
      const result = await window.sandstorm.tickets.create(project.directory, title.trim(), body.trim());
      setCreated({ url: result.url, ticketId: result.ticketId });
      setPhase('created');
    } catch (err) {
      setPhase('input');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRefineNow = () => {
    if (!created) return;
    setShowCreateTicketDialog(false);
    // Hand off the just-filed ticket id so Refine doesn't ask for it again
    // (#317). The Refine dialog consumes + clears the prefill on mount.
    openRefineTicketDialogWith(created.ticketId);
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      data-testid="create-ticket-dialog"
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[640px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">Create Ticket</h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">
              Files a new GitHub issue in this project
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
          {!project && (
            <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
              Select a project tab first.
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5" data-testid="create-ticket-error">
              {error}
            </div>
          )}

          {phase === 'created' && created ? (
            <div className="space-y-3" data-testid="create-ticket-success">
              <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M20 6L9 17l-5-5"/>
                </svg>
                Filed issue #{created.ticketId}.
                <a
                  href={created.url}
                  onClick={(e) => { e.preventDefault(); window.open(created.url, '_blank'); }}
                  className="ml-auto underline"
                >
                  Open on GitHub
                </a>
              </div>
              <p className="text-xs text-sandstorm-text-secondary">
                Want to run the spec quality gate on this ticket now?
              </p>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                  Title <span className="text-sandstorm-accent">*</span>
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={phase === 'creating'}
                  placeholder="Add deterministic UI for ticket workflow"
                  className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[13px] text-sandstorm-text outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                  data-testid="create-ticket-title"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                  Body <span className="text-sandstorm-accent">*</span>
                </label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={phase === 'creating'}
                  rows={14}
                  placeholder="## Context&#10;&#10;...&#10;&#10;## Verification&#10;&#10;..."
                  className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs font-mono text-sandstorm-text resize-y outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                  data-testid="create-ticket-body"
                />
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={close}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
          >
            {phase === 'created' ? 'Done' : 'Cancel'}
          </button>
          {phase === 'created' && created ? (
            <button
              onClick={handleRefineNow}
              className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg transition-all active:scale-[0.98] shadow-glow"
              data-testid="create-ticket-refine-now"
            >
              Refine #{created.ticketId}
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={!project || !title.trim() || !body.trim() || phase === 'creating'}
              className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
              data-testid="create-ticket-submit"
            >
              {phase === 'creating' ? 'Filing…' : 'File Ticket'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
