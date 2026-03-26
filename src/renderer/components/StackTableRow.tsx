import React, { useState, useEffect } from 'react';
import { Stack, StackMetrics, useAppStore } from '../store';
import { getStackDuration, isTerminalStatus, DURATION_UPDATE_INTERVAL } from '../utils/duration';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

const STATUS_COLORS: Record<string, string> = {
  building: 'bg-amber-400',
  up: 'bg-emerald-400',
  running: 'bg-blue-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  idle: 'bg-amber-400',
  stopped: 'bg-gray-500',
  pushed: 'bg-violet-400',
  pr_created: 'bg-violet-400',
};

const STATUS_LABELS: Record<string, string> = {
  building: 'Building',
  up: 'Up',
  running: 'Running',
  completed: 'Review',
  failed: 'Failed',
  idle: 'Idle',
  stopped: 'Stopped',
  pushed: 'Pushed',
  pr_created: 'PR Open',
};

export function StackTableRow({ stack, showProject, columnWidths }: { stack: Stack; showProject?: boolean; columnWidths?: Record<string, number> }) {
  const { selectStack, refreshStacks, stackMetrics } = useAppStore();
  const metrics: StackMetrics | undefined = stackMetrics[stack.id];
  const [duration, setDuration] = useState(() =>
    getStackDuration(stack.created_at, stack.updated_at, stack.status)
  );

  useEffect(() => {
    setDuration(getStackDuration(stack.created_at, stack.updated_at, stack.status));

    // Only tick for active (non-terminal) stacks
    if (!isTerminalStatus(stack.status)) {
      const interval = setInterval(() => {
        setDuration(getStackDuration(stack.created_at, stack.updated_at, stack.status));
      }, DURATION_UPDATE_INTERVAL);
      return () => clearInterval(interval);
    }
  }, [stack.created_at, stack.updated_at, stack.status]);

  const runningCount = stack.services.filter((s) => s.status === 'running').length;
  const totalCount = stack.services.length;
  const statusColor = STATUS_COLORS[stack.status] ?? 'bg-gray-500';
  const statusLabel = STATUS_LABELS[stack.status] ?? stack.status;

  const handleTeardown = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Tear down stack "${stack.id}"?`)) return;
    try {
      await window.sandstorm.stacks.teardown(stack.id);
      refreshStacks();
    } catch (err) {
      alert(`Failed to tear down: ${err}`);
    }
  };

  return (
    <tr
      className="border-b border-sandstorm-border hover:bg-sandstorm-surface-hover cursor-pointer transition-colors group"
      onClick={() => selectStack(stack.id)}
    >
      <td className="px-3 py-2 whitespace-nowrap overflow-hidden" style={columnWidths?.status ? { width: `${columnWidths.status}px` } : undefined}>
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${statusColor} shrink-0`} />
          <span className="text-sandstorm-text-secondary">{statusLabel}</span>
        </div>
      </td>
      <td className="px-3 py-2 whitespace-nowrap overflow-hidden" style={columnWidths?.name ? { width: `${columnWidths.name}px` } : undefined}>
        <div className="flex items-center gap-1.5 min-w-0">
          {showProject && (
            <span className="text-sandstorm-muted truncate">{stack.project}/</span>
          )}
          <span className="font-medium text-sandstorm-text truncate">{stack.id}</span>
        </div>
      </td>
      <td className="px-3 py-2 overflow-hidden" style={columnWidths?.description ? { width: `${columnWidths.description}px` } : undefined}>
        <span className="text-sandstorm-text-secondary truncate block">
          {stack.description || <span className="text-sandstorm-muted">—</span>}
        </span>
      </td>
      <td className="px-3 py-2 whitespace-nowrap overflow-hidden" style={columnWidths?.services ? { width: `${columnWidths.services}px` } : undefined}>
        {totalCount > 0 ? (
          <div className="flex items-center gap-1.5">
            <span className="flex gap-0.5">
              {stack.services.map((svc, i) => (
                <span
                  key={i}
                  className={`w-1.5 h-1.5 rounded-full ${
                    svc.status === 'running'
                      ? 'bg-emerald-400'
                      : svc.status === 'exited'
                        ? 'bg-red-400'
                        : 'bg-amber-400'
                  }`}
                  title={`${svc.name}: ${svc.status}`}
                />
              ))}
            </span>
            <span className="text-sandstorm-muted tabular-nums">{runningCount}/{totalCount}</span>
          </div>
        ) : (
          <span className="text-sandstorm-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap overflow-hidden" style={columnWidths?.resources ? { width: `${columnWidths.resources}px` } : undefined}>
        {metrics && metrics.totalMemory > 0 ? (
          <div className="flex items-center gap-2 text-sandstorm-muted tabular-nums">
            <span title="Memory">{formatBytes(metrics.totalMemory)}</span>
            <span title="CPU">{metrics.containers.reduce((s, c) => s + c.cpuPercent, 0).toFixed(1)}%</span>
          </div>
        ) : (
          <span className="text-sandstorm-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-sandstorm-muted tabular-nums overflow-hidden" style={columnWidths?.duration ? { width: `${columnWidths.duration}px` } : undefined}>
        {duration}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-right overflow-hidden" style={columnWidths?.actions ? { width: `${columnWidths.actions}px` } : undefined}>
        <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
          {stack.status !== 'running' && (
            <button
              onClick={handleTeardown}
              className="text-[10px] px-1.5 py-0.5 rounded text-red-400 hover:bg-red-500/10 transition-colors"
            >
              Teardown
            </button>
          )}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sandstorm-muted">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </div>
      </td>
    </tr>
  );
}
