import React, { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import { StackCard } from './StackCard';
import { UninitializedProject } from './UninitializedProject';
import { ClaudeSession } from './ClaudeSession';

export function Dashboard() {
  const { setShowNewStackDialog, filteredStacks, activeProject } = useAppStore();
  const stacks = filteredStacks();
  const project = activeProject();

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
            </div>
          )}
        </div>
        {(project || !project) && (
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
        )}
      </div>

      {/* Stack list */}
      <div className="flex-1 overflow-y-auto p-6 min-h-0">
        {stacks.length === 0 ? (
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
            <p className="text-sm font-medium text-sandstorm-text-secondary mb-1">No stacks yet</p>
            <p className="text-xs text-sandstorm-muted mb-5">
              Create your first stack to get started
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
        )}
      </div>

      {/* Embedded Claude session */}
      <div className="h-[280px] shrink-0 border-t border-sandstorm-border">
        <ClaudeSession key={claudeTabId} tabId={claudeTabId} projectDir={project?.directory} />
      </div>
    </div>
  );
}
