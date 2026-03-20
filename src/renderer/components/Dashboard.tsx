import React from 'react';
import { useAppStore } from '../store';
import { StackCard } from './StackCard';

export function Dashboard() {
  const { stacks, setShowNewStackDialog } = useAppStore();

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-sandstorm-border">
        <div>
          <h1 className="text-xl font-semibold">Stacks</h1>
          <p className="text-sm text-sandstorm-muted mt-1">
            {stacks.length === 0
              ? 'No stacks running'
              : `${stacks.length} stack${stacks.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <button
          onClick={() => setShowNewStackDialog(true)}
          className="px-4 py-2 bg-sandstorm-accent text-white rounded-lg hover:bg-indigo-500 transition-colors text-sm font-medium"
          data-testid="new-stack-btn"
        >
          + New Stack
        </button>
      </div>

      {/* Stack list */}
      <div className="flex-1 overflow-y-auto p-6 space-y-3">
        {stacks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-sandstorm-muted">
            <p className="text-lg mb-2">No stacks yet</p>
            <p className="text-sm">
              Click "+ New Stack" to create your first stack
            </p>
          </div>
        ) : (
          stacks.map((stack) => <StackCard key={stack.id} stack={stack} />)
        )}
      </div>
    </div>
  );
}
