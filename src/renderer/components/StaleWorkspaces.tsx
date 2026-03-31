import React, { useEffect, useState, useCallback } from 'react';
import { useAppStore, StaleWorkspace, CleanupResult } from '../store';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(i > 1 ? 1 : 0)} ${sizes[i]}`;
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function StaleWorkspaces() {
  const { staleWorkspaces, staleWorkspacesLoading, refreshStaleWorkspaces, cleanupStaleWorkspaces } = useAppStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);
  const [results, setResults] = useState<CleanupResult[] | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    refreshStaleWorkspaces();
  }, [refreshStaleWorkspaces]);

  const toggleSelect = useCallback((workspacePath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(workspacePath)) {
        next.delete(workspacePath);
      } else {
        next.add(workspacePath);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (selected.size === staleWorkspaces.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(staleWorkspaces.map((w) => w.workspacePath)));
    }
  }, [staleWorkspaces, selected.size]);

  const handleCleanup = useCallback(async () => {
    if (selected.size === 0) return;

    const hasUnpushed = staleWorkspaces
      .filter((w) => selected.has(w.workspacePath) && w.hasUnpushedChanges)
      .length;

    const message = hasUnpushed > 0
      ? `Delete ${selected.size} workspace${selected.size === 1 ? '' : 's'}? ${hasUnpushed} ha${hasUnpushed === 1 ? 's' : 've'} unpushed changes that will be lost.`
      : `Delete ${selected.size} workspace${selected.size === 1 ? '' : 's'}? This cannot be undone.`;

    if (!confirm(message)) return;

    setCleaning(true);
    try {
      const cleanupResults = await cleanupStaleWorkspaces(Array.from(selected));
      setResults(cleanupResults);
      setSelected(new Set());
    } finally {
      setCleaning(false);
    }
  }, [selected, staleWorkspaces, cleanupStaleWorkspaces]);

  if (dismissed || (staleWorkspaces.length === 0 && !staleWorkspacesLoading)) {
    return null;
  }

  const totalSize = staleWorkspaces.reduce((sum, w) => sum + w.sizeBytes, 0);
  const selectedSize = staleWorkspaces
    .filter((w) => selected.has(w.workspacePath))
    .reduce((sum, w) => sum + w.sizeBytes, 0);

  return (
    <div className="mx-4 mt-3 bg-amber-500/5 border border-amber-500/20 rounded-xl overflow-hidden" data-testid="stale-workspaces">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-amber-500/10">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-xs font-semibold text-amber-400">
            {staleWorkspaces.length} Stale Workspace{staleWorkspaces.length === 1 ? '' : 's'}
          </span>
          {totalSize > 0 && (
            <span className="text-[11px] text-sandstorm-muted">
              ({formatBytes(totalSize)} total)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refreshStaleWorkspaces()}
            disabled={staleWorkspacesLoading}
            className="text-[11px] text-sandstorm-muted hover:text-sandstorm-text-secondary transition-colors disabled:opacity-50"
            data-testid="stale-refresh-btn"
            title="Check again"
          >
            {staleWorkspacesLoading ? 'Scanning...' : 'Refresh'}
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="text-sandstorm-muted hover:text-sandstorm-text-secondary transition-colors p-0.5"
            title="Dismiss"
            data-testid="stale-dismiss-btn"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Results banner */}
      {results && (
        <div className="px-4 py-2 border-b border-amber-500/10 bg-sandstorm-surface/50">
          <div className="flex items-center gap-2 text-xs">
            {results.every((r) => r.success) ? (
              <span className="text-emerald-400">
                Successfully cleaned up {results.length} workspace{results.length === 1 ? '' : 's'}.
              </span>
            ) : (
              <span className="text-red-400">
                {results.filter((r) => r.success).length} succeeded, {results.filter((r) => !r.success).length} failed.
              </span>
            )}
            <button
              onClick={() => setResults(null)}
              className="text-sandstorm-muted hover:text-sandstorm-text-secondary"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Workspace list */}
      <div className="max-h-48 overflow-y-auto">
        {staleWorkspaces.map((workspace) => (
          <StaleWorkspaceRow
            key={workspace.workspacePath}
            workspace={workspace}
            selected={selected.has(workspace.workspacePath)}
            onToggle={() => toggleSelect(workspace.workspacePath)}
          />
        ))}
      </div>

      {/* Actions footer */}
      {staleWorkspaces.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-amber-500/10 bg-sandstorm-surface/30">
          <label className="flex items-center gap-2 cursor-pointer text-xs text-sandstorm-muted">
            <input
              type="checkbox"
              checked={selected.size === staleWorkspaces.length && staleWorkspaces.length > 0}
              onChange={selectAll}
              className="rounded border-sandstorm-border bg-sandstorm-bg text-sandstorm-accent focus:ring-sandstorm-accent/30"
              data-testid="stale-select-all"
            />
            Select all
          </label>
          <div className="flex items-center gap-3">
            {selected.size > 0 && (
              <span className="text-[11px] text-sandstorm-muted">
                {selected.size} selected ({formatBytes(selectedSize)})
              </span>
            )}
            <button
              onClick={handleCleanup}
              disabled={selected.size === 0 || cleaning}
              className="px-3 py-1.5 text-xs font-medium bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="stale-cleanup-btn"
            >
              {cleaning ? 'Cleaning up...' : `Clean Up${selected.size > 0 ? ` (${selected.size})` : ''}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StaleWorkspaceRow({
  workspace,
  selected,
  onToggle,
}: {
  workspace: StaleWorkspace;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-2 hover:bg-sandstorm-surface-hover/50 transition-colors cursor-pointer ${
        selected ? 'bg-sandstorm-surface/40' : ''
      }`}
      onClick={onToggle}
      data-testid="stale-workspace-row"
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        className="rounded border-sandstorm-border bg-sandstorm-bg text-sandstorm-accent focus:ring-sandstorm-accent/30 shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-sandstorm-text truncate">{workspace.stackId}</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${
            workspace.reason === 'orphaned'
              ? 'bg-orange-500/10 border-orange-500/20 text-orange-400'
              : 'bg-gray-500/10 border-gray-500/20 text-gray-400'
          }`}>
            {workspace.reason}
          </span>
          {workspace.hasUnpushedChanges && (
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full border bg-red-500/10 border-red-500/20 text-red-400">
              Unpushed changes
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-[11px] text-sandstorm-muted">
          <span>{workspace.project}</span>
          {workspace.sizeBytes > 0 && <span>{formatBytes(workspace.sizeBytes)}</span>}
          <span>Modified {formatRelativeDate(workspace.lastModified)}</span>
        </div>
      </div>
    </div>
  );
}
