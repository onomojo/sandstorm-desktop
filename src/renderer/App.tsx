import React, { useEffect } from 'react';
import { useAppStore } from './store';
import { Dashboard } from './components/Dashboard';
import { StackDetail } from './components/StackDetail';
import { NewStackDialog } from './components/NewStackDialog';
import { ProjectTabs } from './components/ProjectTabs';
import { OpenProjectDialog } from './components/OpenProjectDialog';

export default function App() {
  const {
    selectedStackId,
    showNewStackDialog,
    showOpenProjectDialog,
    refreshStacks,
    refreshProjects,
    selectStack,
    error,
  } = useAppStore();

  useEffect(() => {
    refreshProjects();
    refreshStacks();
    const interval = setInterval(refreshStacks, 3000);

    const unsubCompleted = window.sandstorm.on('task:completed', () => {
      refreshStacks();
    });
    const unsubFailed = window.sandstorm.on('task:failed', () => {
      refreshStacks();
    });
    const unsubNavigate = window.sandstorm.on(
      'navigate:stack',
      (stackId: unknown) => {
        selectStack(stackId as string);
      }
    );
    const unsubStacksUpdated = window.sandstorm.on('stacks:updated', () => {
      refreshStacks();
    });

    return () => {
      clearInterval(interval);
      unsubCompleted();
      unsubFailed();
      unsubNavigate();
      unsubStacksUpdated();
    };
  }, [refreshStacks, refreshProjects, selectStack]);

  return (
    <div className="h-screen flex flex-col bg-sandstorm-bg text-sandstorm-text">
      {/* Title bar */}
      <div className="titlebar-drag h-10 bg-sandstorm-surface border-b border-sandstorm-border flex items-center px-4 shrink-0">
        <div className="titlebar-no-drag flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-sandstorm-accent to-indigo-400 flex items-center justify-center shadow-sm">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-white">
              <path d="M13 3L4 14h7l-2 7 9-11h-7l2-7z" fill="currentColor"/>
            </svg>
          </div>
          <span className="text-xs font-semibold text-sandstorm-muted tracking-wide uppercase">
            Sandstorm
          </span>
        </div>
      </div>

      {/* Project tabs */}
      <ProjectTabs />

      {/* Error banner */}
      {error && (
        <div className="bg-red-500/10 border-b border-red-500/20 px-4 py-2.5 text-sm text-red-400 flex items-center gap-2 shrink-0 animate-fade-in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            <path d="M12 8v4m0 4h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          {error}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        {selectedStackId ? (
          <StackDetail
            stackId={selectedStackId}
            onBack={() => selectStack(null)}
          />
        ) : (
          <Dashboard />
        )}
      </div>

      {/* Dialogs */}
      {showNewStackDialog && <NewStackDialog />}
      {showOpenProjectDialog && <OpenProjectDialog />}
    </div>
  );
}
