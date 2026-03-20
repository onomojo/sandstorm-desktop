import React, { useEffect } from 'react';
import { useAppStore } from './store';
import { Dashboard } from './components/Dashboard';
import { StackDetail } from './components/StackDetail';
import { NewStackDialog } from './components/NewStackDialog';

export default function App() {
  const {
    selectedStackId,
    showNewStackDialog,
    refreshStacks,
    selectStack,
    error,
  } = useAppStore();

  useEffect(() => {
    // Initial load
    refreshStacks();

    // Poll for updates every 3 seconds
    const interval = setInterval(refreshStacks, 3000);

    // Listen for task events from main process
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

    return () => {
      clearInterval(interval);
      unsubCompleted();
      unsubFailed();
      unsubNavigate();
    };
  }, [refreshStacks, selectStack]);

  return (
    <div className="h-screen flex flex-col bg-sandstorm-bg">
      {/* Title bar drag region */}
      <div className="titlebar-drag h-8 bg-sandstorm-surface border-b border-sandstorm-border flex items-center px-4">
        <span className="titlebar-no-drag text-sm text-sandstorm-muted font-medium">
          Sandstorm Desktop
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-900/30 border-b border-red-800 px-4 py-2 text-sm text-red-300">
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

      {/* New Stack Dialog */}
      {showNewStackDialog && <NewStackDialog />}
    </div>
  );
}
