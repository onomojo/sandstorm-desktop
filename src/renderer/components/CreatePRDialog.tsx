import React, { useEffect, useState } from 'react';
import { useAppStore } from '../store';

export function CreatePRDialog({ stackId }: { stackId: string }) {
  const { setShowCreatePRDialog, refreshStacks } = useAppStore();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [drafting, setDrafting] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDrafting(true);
    setError(null);
    window.sandstorm.pr
      .draftBody(stackId)
      .then((drafted) => {
        if (cancelled) return;
        setTitle(drafted.title);
        setBody(drafted.body);
        setDrafting(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setDrafting(false);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [stackId]);

  const close = () => setShowCreatePRDialog(null);

  const handleCreate = async () => {
    if (!title.trim() || !body.trim()) {
      setError('Title and body are both required');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await window.sandstorm.pr.create(stackId, title.trim(), body.trim());
      await refreshStacks();
      window.open(result.url, '_blank');
      close();
    } catch (err) {
      setCreating(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      data-testid="create-pr-dialog"
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[640px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">Create Pull Request</h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">
              Stack <span className="font-mono">{stackId}</span> — drafted by one ephemeral Claude call
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
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5" data-testid="pr-error">
              {error}
            </div>
          )}

          {drafting ? (
            <div className="text-xs text-sandstorm-muted flex items-center gap-2 py-8 justify-center" data-testid="pr-drafting">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="48" strokeDashoffset="32"/>
              </svg>
              Drafting PR title and body…
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[13px] text-sandstorm-text outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                  data-testid="pr-title"
                />
                <p className={`text-[10px] mt-1 ${title.length > 70 ? 'text-amber-400' : 'text-sandstorm-muted'}`}>
                  {title.length}/70 chars
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                  Body
                </label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={14}
                  className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs font-mono text-sandstorm-text resize-y outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                  data-testid="pr-body"
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
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={drafting || creating || !title.trim() || !body.trim()}
            className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
            data-testid="pr-create"
          >
            {creating ? 'Creating…' : 'Create PR'}
          </button>
        </div>
      </div>
    </div>
  );
}
