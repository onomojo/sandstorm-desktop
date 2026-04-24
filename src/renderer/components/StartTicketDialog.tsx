import React, { useState, useMemo } from 'react';
import { useAppStore } from '../store';

function suggestStackName(ticketId: string): string {
  const id = ticketId.replace(/^#/, '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return id ? `ticket-${id}` : '';
}

export function StartTicketDialog() {
  const { setShowStartTicketDialog, refreshStacks, activeProject } = useAppStore();
  const project = activeProject();

  const [ticketId, setTicketId] = useState('');
  const [stackName, setStackName] = useState('');
  const [touchedName, setTouchedName] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanTicketId = useMemo(() => ticketId.trim().replace(/^#/, ''), [ticketId]);
  const effectiveName = touchedName ? stackName : suggestStackName(cleanTicketId);

  const close = () => setShowStartTicketDialog(false);

  const handleStart = async () => {
    if (!project) {
      setError('Select a project tab first');
      return;
    }
    if (!cleanTicketId) {
      setError('Ticket ID is required');
      return;
    }
    if (!effectiveName.trim()) {
      setError('Stack name is required');
      return;
    }
    setError(null);
    setStarting(true);
    try {
      const fetched = await window.sandstorm.tickets.fetch(cleanTicketId, project.directory);
      await window.sandstorm.stacks.create({
        name: effectiveName.trim(),
        projectDir: project.directory,
        ticket: cleanTicketId,
        branch: `feat/${cleanTicketId}-${effectiveName.trim()}`,
        description:
          fetched.body
            .split('\n')
            .find((l) => l.trim())
            ?.replace(/^#\s*/, '')
            .slice(0, 120) ?? null,
        runtime: 'docker',
        task: fetched.body,
        gateApproved: true,
      });
      await refreshStacks();
      close();
    } catch (err) {
      setStarting(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      data-testid="start-ticket-dialog"
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[480px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">Start Ticket</h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">
              Spin up a stack with the ticket body as its initial task — zero LLM in the dispatch path
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
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5" data-testid="start-ticket-error">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
              Ticket ID <span className="text-sandstorm-accent">*</span>
            </label>
            <input
              type="text"
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
              disabled={starting}
              placeholder="310"
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[13px] font-mono text-sandstorm-text outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
              data-testid="start-ticket-id"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
              Stack Name <span className="text-sandstorm-accent">*</span>
            </label>
            <input
              type="text"
              value={effectiveName}
              onChange={(e) => {
                setTouchedName(true);
                setStackName(e.target.value);
              }}
              disabled={starting}
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[13px] font-mono text-sandstorm-text outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
              data-testid="start-ticket-stack-name"
            />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={close}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={!project || !cleanTicketId || !effectiveName.trim() || starting}
            className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
            data-testid="start-ticket-launch"
          >
            {starting ? 'Launching…' : 'Launch Stack'}
          </button>
        </div>
      </div>
    </div>
  );
}
