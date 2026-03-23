import React from 'react';
import { Stack, StackMetrics, useAppStore } from '../store';

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
};

const STATUS_LABELS: Record<string, string> = {
  building: 'Building',
  up: 'Up',
  running: 'Running',
  completed: 'Review',
  failed: 'Failed',
  idle: 'Idle',
  stopped: 'Stopped',
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

export function StackTableRow({ stack, showProject }: { stack: Stack; showProject?: boolean }) {
  const { selectStack, refreshStacks, stackMetrics } = useAppStore();
  const metrics: StackMetrics | undefined = stackMetrics[stack.id];

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
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${statusColor} shrink-0`} />
          <span className="text-sandstorm-text-secondary">{statusLabel}</span>
        </div>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="flex items-center gap-1.5 min-w-0">
          {showProject && (
            <span className="text-sandstorm-muted truncate">{stack.project}/</span>
          )}
          <span className="font-medium text-sandstorm-text truncate">{stack.id}</span>
        </div>
      </td>
      <td className="px-3 py-2 max-w-[200px]">
        <span className="text-sandstorm-text-secondary truncate block">
          {stack.description || <span className="text-sandstorm-muted">—</span>}
        </span>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
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
      <td className="px-3 py-2 whitespace-nowrap">
        {metrics && metrics.totalMemory > 0 ? (
          <div className="flex items-center gap-2 text-sandstorm-muted tabular-nums">
            <span title="Memory">{formatBytes(metrics.totalMemory)}</span>
            <span title="CPU">{metrics.containers.reduce((s, c) => s + c.cpuPercent, 0).toFixed(1)}%</span>
          </div>
        ) : (
          <span className="text-sandstorm-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-sandstorm-muted">
        {timeAgo(stack.updated_at)}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-right">
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
