import React, { useState } from 'react';
import { useAppStore, RefinementSession } from '../store';

function sessionLabel(s: RefinementSession): string {
  switch (s.status) {
    case 'running': return 'running';
    case 'ready': return s.result?.passed ? 'passed' : 'needs answers';
    case 'errored': return 'error';
    case 'interrupted': return 'interrupted';
    default: return s.status;
  }
}

function statusColor(s: RefinementSession): string {
  switch (s.status) {
    case 'running': return 'text-sandstorm-accent';
    case 'ready': return s.result?.passed ? 'text-emerald-400' : 'text-amber-400';
    case 'errored': return 'text-red-400';
    case 'interrupted': return 'text-amber-400';
    default: return 'text-sandstorm-muted';
  }
}

function StatusDot({ session }: { session: RefinementSession }) {
  const base = 'w-2 h-2 rounded-full shrink-0';
  if (session.status === 'running') {
    return <span className={`${base} bg-sandstorm-accent animate-pulse`} />;
  }
  if (session.status === 'ready') {
    return <span className={`${base} ${session.result?.passed ? 'bg-emerald-400' : 'bg-amber-400'}`} />;
  }
  if (session.status === 'errored' || session.status === 'interrupted') {
    return <span className={`${base} bg-red-400`} />;
  }
  return <span className={`${base} bg-sandstorm-muted`} />;
}

export function RefinementIndicator() {
  const {
    refinementSessions,
    openRefinementSession,
    setShowRefineTicketDialog,
    showRefineTicketDialog,
    activeProject,
  } = useAppStore();
  const project = activeProject();
  const [expanded, setExpanded] = useState(false);

  // Only show sessions for the active project (or all if no project selected).
  const visibleSessions = project
    ? refinementSessions.filter((s) => s.projectDir === project.directory)
    : refinementSessions;

  if (visibleSessions.length === 0) return null;

  const runningCount = visibleSessions.filter((s) => s.status === 'running').length;
  const readyCount = visibleSessions.filter((s) => s.status === 'ready').length;

  const handleOpen = (session: RefinementSession) => {
    openRefinementSession(session.id);
    setShowRefineTicketDialog(true);
    setExpanded(false);
  };

  return (
    <div className="relative" data-testid="refinement-indicator">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sandstorm-surface border border-sandstorm-border hover:border-sandstorm-accent/40 text-xs transition-colors"
        aria-label={`${visibleSessions.length} refinement(s) in progress`}
        data-testid="refinement-indicator-pill"
      >
        {runningCount > 0 && (
          <span className="w-2 h-2 rounded-full bg-sandstorm-accent animate-pulse shrink-0" />
        )}
        {runningCount === 0 && readyCount > 0 && (
          <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
        )}
        {runningCount === 0 && readyCount === 0 && (
          <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" />
        )}
        <span className="text-sandstorm-text-secondary">
          {visibleSessions.length} refinement{visibleSessions.length !== 1 ? 's' : ''}
        </span>
      </button>

      {expanded && (
        <div
          className="absolute right-0 top-full mt-1.5 w-64 bg-sandstorm-surface border border-sandstorm-border rounded-xl shadow-dialog z-50 py-1 animate-fade-in"
          data-testid="refinement-indicator-dropdown"
        >
          {visibleSessions.map((session) => (
            <button
              key={session.id}
              onClick={() => handleOpen(session)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-sandstorm-surface-hover text-left transition-colors"
              data-testid={`refinement-session-${session.id}`}
            >
              <StatusDot session={session} />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-sandstorm-text font-mono truncate">
                  #{session.ticketId}
                </div>
                <div className={`text-[10px] ${statusColor(session)}`}>
                  {sessionLabel(session)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Click-away to close dropdown */}
      {expanded && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setExpanded(false)}
        />
      )}
    </div>
  );
}
