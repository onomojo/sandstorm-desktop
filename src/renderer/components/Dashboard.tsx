import React, { useEffect, useState } from 'react';
import { useAppStore, StackHistoryRecord } from '../store';
import { StackCard } from './StackCard';
import { UninitializedProject } from './UninitializedProject';
import { ClaudeSession } from './ClaudeSession';

type DashboardTab = 'active' | 'history';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
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

const HISTORY_STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  completed: { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-400', label: 'Completed' },
  failed: { bg: 'bg-red-500/10 border-red-500/20', text: 'text-red-400', label: 'Failed' },
  torn_down: { bg: 'bg-gray-500/10 border-gray-500/20', text: 'text-gray-400', label: 'Torn Down' },
};

function HistoryCard({ record, showProject }: { record: StackHistoryRecord; showProject?: boolean }) {
  const badge = HISTORY_STATUS_BADGE[record.final_status] ?? HISTORY_STATUS_BADGE.torn_down;

  return (
    <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl p-4 opacity-80 hover:opacity-100 transition-all duration-150">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full shrink-0 ${
              record.final_status === 'completed' ? 'bg-emerald-400' :
              record.final_status === 'failed' ? 'bg-red-400' : 'bg-gray-500'
            }`} />
            {showProject && (
              <span className="text-[13px] text-sandstorm-muted truncate">{record.project} /</span>
            )}
            <span className="font-semibold text-[15px] text-sandstorm-text truncate">{record.stack_id}</span>
            <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${badge.bg} ${badge.text}`}>
              {badge.label}
            </span>
            <span className="text-[11px] text-sandstorm-muted ml-auto shrink-0">
              {formatRelativeDate(record.finished_at)}
            </span>
          </div>

          {(record.ticket || record.branch) && (
            <div className="mt-2 ml-5 flex items-center gap-1.5 text-xs text-sandstorm-muted">
              {record.ticket && (
                <span className="bg-sandstorm-bg px-2 py-0.5 rounded-md font-mono text-[11px] border border-sandstorm-border">
                  {record.ticket}
                </span>
              )}
              {record.branch && (
                <span className="bg-sandstorm-bg px-2 py-0.5 rounded-md font-mono text-[11px] border border-sandstorm-border flex items-center gap-1">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="opacity-60">
                    <path d="M6 3v12M18 9a3 3 0 01-3 3H9M18 9a3 3 0 10-3-3"/>
                  </svg>
                  {record.branch}
                </span>
              )}
            </div>
          )}

          {record.description && (
            <div className="mt-1.5 ml-5 text-xs text-sandstorm-text-secondary truncate">
              {record.description}
            </div>
          )}

          {record.task_prompt && (
            <div className="mt-1.5 ml-5 text-xs text-sandstorm-muted truncate" title={record.task_prompt}>
              Task: {record.task_prompt}
            </div>
          )}

          {record.error && record.final_status === 'failed' && (
            <div className="mt-2 ml-5 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2.5 py-1.5 truncate" title={record.error}>
              {record.error}
            </div>
          )}

          <div className="mt-2 ml-5 flex items-center gap-3 text-[11px] text-sandstorm-muted">
            <span>Duration: {formatDuration(record.duration_seconds)}</span>
            <span>Started: {new Date(record.created_at + (record.created_at.endsWith('Z') ? '' : 'Z')).toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Dashboard() {
  const { setShowNewStackDialog, filteredStacks, filteredStackHistory, activeProject } = useAppStore();
  const stacks = filteredStacks();
  const history = filteredStackHistory();
  const project = activeProject();

  const [dashboardTab, setDashboardTab] = useState<DashboardTab>('active');
  const [projectInitialized, setProjectInitialized] = useState<boolean | null>(null);

  useEffect(() => {
    if (!project) {
      setProjectInitialized(null);
      return;
    }
    let cancelled = false;
    window.sandstorm.projects.checkInit(project.directory).then((ok) => {
      if (!cancelled) setProjectInitialized(ok);
    });
    return () => { cancelled = true; };
  }, [project]);

  // Derive a stable tab ID for the Claude session
  const claudeTabId = project ? `project-${project.id}` : 'all';

  // If we have a selected project that isn't initialized, show that state
  if (project && projectInitialized === false) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-sandstorm-border shrink-0">
          <div>
            <h1 className="text-lg font-semibold text-sandstorm-text tracking-tight">{project.name}</h1>
            <p className="text-xs text-sandstorm-muted mt-0.5 font-mono">{project.directory}</p>
          </div>
        </div>
        <div className="flex-1">
          <UninitializedProject project={project} />
        </div>
      </div>
    );
  }

  const runningCount = stacks.filter((s) => s.status === 'running' || s.status === 'up').length;
  const completedCount = stacks.filter((s) => s.status === 'completed').length;
  const stoppedCount = stacks.filter((s) => s.status === 'stopped').length;

  const title = project ? project.name : 'All Stacks';
  const subtitle = project
    ? `${stacks.length} stack${stacks.length === 1 ? '' : 's'}`
    : stacks.length === 0
      ? 'No stacks running'
      : `${stacks.length} stack${stacks.length === 1 ? '' : 's'}`;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-sandstorm-border shrink-0">
        <div className="flex items-center gap-6">
          <div>
            <h1 className="text-lg font-semibold text-sandstorm-text tracking-tight">{title}</h1>
            <p className="text-xs text-sandstorm-muted mt-0.5">{subtitle}</p>
          </div>
          {stacks.length > 0 && (
            <div className="flex items-center gap-3 text-[11px]">
              {runningCount > 0 && (
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {runningCount} active
                </span>
              )}
              {completedCount > 0 && (
                <span className="flex items-center gap-1.5 text-sandstorm-accent">
                  <span className="w-1.5 h-1.5 rounded-full bg-sandstorm-accent" />
                  {completedCount} review
                </span>
              )}
              {stoppedCount > 0 && (
                <span className="flex items-center gap-1.5 text-gray-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                  {stoppedCount} stopped
                </span>
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowNewStackDialog(true)}
          className="flex items-center gap-1.5 px-4 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white rounded-lg transition-all text-sm font-medium shadow-glow hover:shadow-lg active:scale-[0.98]"
          data-testid="new-stack-btn"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          New Stack
        </button>
      </div>

      {/* Active / History tabs */}
      <div className="border-b border-sandstorm-border px-6 shrink-0">
        <div className="flex gap-0.5">
          <button
            onClick={() => setDashboardTab('active')}
            className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
              dashboardTab === 'active'
                ? 'border-sandstorm-accent text-sandstorm-text'
                : 'border-transparent text-sandstorm-muted hover:text-sandstorm-text-secondary'
            }`}
            data-testid="tab-active"
          >
            Active
            {stacks.length > 0 && (
              <span className="ml-1 text-[10px] bg-sandstorm-accent/10 text-sandstorm-accent px-1.5 py-0.5 rounded-full">
                {stacks.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setDashboardTab('history')}
            className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
              dashboardTab === 'history'
                ? 'border-sandstorm-accent text-sandstorm-text'
                : 'border-transparent text-sandstorm-muted hover:text-sandstorm-text-secondary'
            }`}
            data-testid="tab-history"
          >
            History
            {history.length > 0 && (
              <span className="ml-1 text-[10px] bg-sandstorm-surface text-sandstorm-muted px-1.5 py-0.5 rounded-full border border-sandstorm-border">
                {history.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Stack list / History list */}
      <div className="flex-1 overflow-y-auto p-6 min-h-0">
        {dashboardTab === 'active' ? (
          stacks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-sandstorm-muted">
              <div className="relative mb-6">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-sandstorm-surface to-sandstorm-bg border border-sandstorm-border flex items-center justify-center">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-sandstorm-muted">
                    <rect x="2" y="3" width="20" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                    <rect x="2" y="10" width="20" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                    <rect x="2" y="17" width="20" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2"/>
                  </svg>
                </div>
                <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-lg bg-sandstorm-accent/10 border border-sandstorm-accent/20 flex items-center justify-center">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-sandstorm-accent">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                </div>
              </div>
              <p className="text-sm font-medium text-sandstorm-text-secondary mb-1">No active stacks</p>
              <p className="text-xs text-sandstorm-muted mb-5">
                Create a new stack to get started
              </p>
              <button
                onClick={() => setShowNewStackDialog(true)}
                className="text-xs font-medium text-sandstorm-accent hover:text-sandstorm-accent-hover transition-colors"
              >
                Create a stack &rarr;
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {stacks.map((stack) => (
                <StackCard key={stack.id} stack={stack} showProject={!project} />
              ))}
            </div>
          )
        ) : (
          history.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-sandstorm-muted">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-4 opacity-50">
                <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <p className="text-sm font-medium text-sandstorm-text-secondary mb-1">No history yet</p>
              <p className="text-xs text-sandstorm-muted">
                Completed and torn-down stacks will appear here
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((record) => (
                <HistoryCard key={record.id} record={record} showProject={!project} />
              ))}
            </div>
          )
        )}
      </div>

      {/* Embedded Claude session */}
      <div className="h-[280px] shrink-0 border-t border-sandstorm-border">
        <ClaudeSession key={claudeTabId} tabId={claudeTabId} projectDir={project?.directory} />
      </div>
    </div>
  );
}
