import React from 'react';
import { Stack, useAppStore } from '../store';

const STATUS_COLORS: Record<string, string> = {
  building: 'bg-yellow-500',
  up: 'bg-blue-500',
  running: 'bg-blue-500 animate-pulse',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  idle: 'bg-yellow-500',
  stopped: 'bg-gray-500',
};

const STATUS_LABELS: Record<string, string> = {
  building: 'BUILDING',
  up: 'UP',
  running: 'RUNNING',
  completed: 'NEEDS REVIEW',
  failed: 'FAILED',
  idle: 'IDLE',
  stopped: 'STOPPED',
};

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

export function StackCard({ stack }: { stack: Stack }) {
  const { selectStack, refreshStacks } = useAppStore();

  const runningCount = stack.services.filter(
    (s) => s.status === 'running'
  ).length;
  const totalCount = stack.services.length;
  const failedServices = stack.services.filter((s) => s.status === 'exited');

  const handleTeardown = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Tear down stack "${stack.id}"?`)) return;
    try {
      await window.sandstorm.stacks.teardown(stack.id);
      await refreshStacks();
    } catch (err) {
      alert(`Failed to tear down: ${err}`);
    }
  };

  const statusColor = STATUS_COLORS[stack.status] ?? 'bg-gray-500';
  const statusLabel = STATUS_LABELS[stack.status] ?? stack.status.toUpperCase();

  return (
    <div
      className="bg-sandstorm-surface border border-sandstorm-border rounded-lg p-4 hover:border-sandstorm-accent/50 transition-colors cursor-pointer"
      onClick={() => selectStack(stack.id)}
      data-testid={`stack-card-${stack.id}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          {/* Stack name and status */}
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${statusColor}`} />
            <span className="font-semibold text-lg truncate">{stack.id}</span>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded ${
                stack.status === 'completed'
                  ? 'bg-green-900/40 text-green-400'
                  : stack.status === 'failed'
                    ? 'bg-red-900/40 text-red-400'
                    : stack.status === 'running'
                      ? 'bg-blue-900/40 text-blue-400'
                      : 'bg-gray-800 text-gray-400'
              }`}
              data-testid={`stack-status-${stack.id}`}
            >
              {statusLabel}
            </span>
            <span className="text-xs text-sandstorm-muted">
              {timeAgo(stack.updated_at)}
            </span>
          </div>

          {/* Ticket and branch */}
          <div className="mt-1 ml-5 text-sm text-sandstorm-muted">
            {stack.ticket && <span>{stack.ticket}</span>}
            {stack.ticket && stack.branch && <span> &middot; </span>}
            {stack.branch && <span>{stack.branch}</span>}
          </div>

          {/* Description */}
          {stack.description && (
            <div className="mt-1 ml-5 text-sm text-sandstorm-text/70 truncate">
              "{stack.description}"
            </div>
          )}

          {/* Service health summary */}
          {totalCount > 0 && (
            <div className="mt-2 ml-5 flex items-center gap-2 text-xs">
              <span className="text-sandstorm-muted">Services:</span>
              <span className="flex gap-0.5">
                {stack.services.map((svc, i) => (
                  <span
                    key={i}
                    className={`w-2 h-2 rounded-full ${
                      svc.status === 'running'
                        ? 'bg-green-500'
                        : svc.status === 'exited'
                          ? 'bg-red-500'
                          : 'bg-yellow-500'
                    }`}
                    title={`${svc.name}: ${svc.status}`}
                  />
                ))}
              </span>
              <span className="text-sandstorm-muted">
                {runningCount}/{totalCount} up
                {failedServices.length > 0 && (
                  <span className="text-red-400">
                    {' '}
                    &mdash; {failedServices.map((s) => s.name).join(', ')}{' '}
                    exited
                  </span>
                )}
              </span>
            </div>
          )}
        </div>

        {/* Arrow to detail */}
        <div className="text-sandstorm-muted ml-4 mt-1 text-lg">&rsaquo;</div>
      </div>

      {/* Action buttons */}
      <div className="mt-3 ml-5 flex gap-2">
        {stack.status === 'completed' && (
          <>
            <ActionButton label="View Diff" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
            <ActionButton label="Push" onClick={(e) => { e.stopPropagation(); window.sandstorm.push.execute(stack.id); }} />
          </>
        )}
        {stack.status === 'running' && (
          <ActionButton label="View Output" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
        )}
        {(stack.status === 'up' || stack.status === 'idle') && (
          <ActionButton label="New Task" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
        )}
        <ActionButton label="Shell" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
        {stack.status !== 'running' && (
          <ActionButton label="Tear Down" onClick={handleTeardown} danger />
        )}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`titlebar-no-drag text-xs px-3 py-1 rounded border transition-colors ${
        danger
          ? 'border-red-800 text-red-400 hover:bg-red-900/30'
          : 'border-sandstorm-border text-sandstorm-muted hover:bg-sandstorm-border/50 hover:text-sandstorm-text'
      }`}
    >
      {label}
    </button>
  );
}
