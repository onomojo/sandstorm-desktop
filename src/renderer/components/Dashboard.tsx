import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useAppStore } from '../store';
import { StackCard } from './StackCard';
import { StackTableRow } from './StackTableRow';
import { UninitializedProject } from './UninitializedProject';
import { ClaudeSession } from './ClaudeSession';

export function Dashboard() {
  const { setShowNewStackDialog, filteredStacks, activeProject } = useAppStore();
  const stacks = filteredStacks();
  const project = activeProject();

  const [projectInitialized, setProjectInitialized] = useState<boolean | null>(null);
  const [viewMode, _setViewMode] = useState<'cards' | 'table'>(() => {
    const saved = localStorage.getItem('sandstorm-view-mode');
    return saved === 'table' ? 'table' : 'cards';
  });
  const setViewMode = (mode: 'cards' | 'table') => {
    localStorage.setItem('sandstorm-view-mode', mode);
    _setViewMode(mode);
  };
  const [leftWidth, setLeftWidth] = useState(55); // percentage
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftWidth(Math.min(80, Math.max(20, pct)));
    };
    const handleMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

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
      <div className="flex items-center justify-between px-6 py-3 border-b border-sandstorm-border shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-sandstorm-text tracking-tight">{title}</h1>
          <p className="text-xs text-sandstorm-muted mt-0.5">{subtitle}</p>
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

      {/* Two-column layout: Claude chat (left) + Stacks (right) */}
      <div className="flex-1 flex min-h-0" ref={containerRef}>
        {/* Left column — Claude orchestration chat */}
        <div className="shrink-0 border-r border-sandstorm-border" style={{ width: `${leftWidth}%` }}>
          <ClaudeSession key={claudeTabId} tabId={claudeTabId} projectDir={project?.directory} />
        </div>

        {/* Draggable divider */}
        <div
          className="w-1 shrink-0 cursor-col-resize hover:bg-sandstorm-accent/30 active:bg-sandstorm-accent/50 transition-colors relative group"
          onMouseDown={handleMouseDown}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>

        {/* Right column — Stacks panel */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <div className="flex items-center gap-3 px-4 border-b border-sandstorm-border shrink-0 h-10">
            <span className="text-xs font-semibold text-sandstorm-muted uppercase tracking-wide">Stacks</span>
            {runningCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {runningCount} active
              </span>
            )}
            {completedCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-sandstorm-accent">
                <span className="w-1.5 h-1.5 rounded-full bg-sandstorm-accent" />
                {completedCount} review
              </span>
            )}
            <div className="ml-auto flex items-center gap-0.5 bg-sandstorm-bg rounded-md p-0.5 border border-sandstorm-border">
              <button
                onClick={() => setViewMode('cards')}
                className={`p-1 rounded transition-colors ${viewMode === 'cards' ? 'bg-sandstorm-surface text-sandstorm-text shadow-sm' : 'text-sandstorm-muted hover:text-sandstorm-text-secondary'}`}
                title="Card view"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={`p-1 rounded transition-colors ${viewMode === 'table' ? 'bg-sandstorm-surface text-sandstorm-text shadow-sm' : 'text-sandstorm-muted hover:text-sandstorm-text-secondary'}`}
                title="Table view"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
          {stacks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-sandstorm-muted p-4">
              <div className="relative mb-6">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sandstorm-surface to-sandstorm-bg border border-sandstorm-border flex items-center justify-center">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-sandstorm-muted">
                    <rect x="2" y="3" width="20" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                    <rect x="2" y="10" width="20" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                    <rect x="2" y="17" width="20" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2"/>
                  </svg>
                </div>
                <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-lg bg-sandstorm-accent/10 border border-sandstorm-accent/20 flex items-center justify-center">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-sandstorm-accent">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                </div>
              </div>
              <p className="text-sm font-medium text-sandstorm-text-secondary mb-1">No stacks yet</p>
              <p className="text-xs text-sandstorm-muted mb-4">
                Create your first stack to get started
              </p>
              <button
                onClick={() => setShowNewStackDialog(true)}
                className="text-xs font-medium text-sandstorm-accent hover:text-sandstorm-accent-hover transition-colors"
              >
                Create a stack &rarr;
              </button>
            </div>
          ) : viewMode === 'cards' ? (
            <div className="space-y-2 p-4">
              {stacks.map((stack) => (
                <StackCard key={stack.id} stack={stack} showProject={!project} />
              ))}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-sandstorm-border text-sandstorm-muted">
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-left font-medium px-3 py-2">Name</th>
                  <th className="text-left font-medium px-3 py-2">Description</th>
                  <th className="text-left font-medium px-3 py-2">Services</th>
                  <th className="text-left font-medium px-3 py-2">Updated</th>
                  <th className="text-right font-medium px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {stacks.map((stack) => (
                  <StackTableRow key={stack.id} stack={stack} showProject={!project} />
                ))}
              </tbody>
            </table>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
