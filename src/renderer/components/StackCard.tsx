import React from 'react';
import { Stack, StackMetrics, useAppStore } from '../store';
import { getStackDuration } from '../utils/duration';
import { formatTokenCount, buildTokenTooltip } from '../utils/format';

const STATUS_COLORS: Record<string, string> = {
  building: 'bg-amber-400',
  rebuilding: 'bg-amber-400 animate-pulse',
  up: 'bg-emerald-400',
  running: 'bg-blue-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  idle: 'bg-amber-400',
  stopped: 'bg-gray-500',
  pushed: 'bg-violet-400',
  pr_created: 'bg-violet-400',
  rate_limited: 'bg-orange-400 animate-pulse',
};

const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
  building: { bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-400' },
  rebuilding: { bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-400' },
  up: { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-400' },
  running: { bg: 'bg-blue-500/10 border-blue-500/20', text: 'text-blue-400' },
  completed: { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-400' },
  failed: { bg: 'bg-red-500/10 border-red-500/20', text: 'text-red-400' },
  idle: { bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-400' },
  stopped: { bg: 'bg-gray-500/10 border-gray-500/20', text: 'text-gray-400' },
  pushed: { bg: 'bg-violet-500/10 border-violet-500/20', text: 'text-violet-400' },
  pr_created: { bg: 'bg-violet-500/10 border-violet-500/20', text: 'text-violet-400' },
  rate_limited: { bg: 'bg-orange-500/10 border-orange-500/20', text: 'text-orange-400' },
};

const STATUS_LABELS: Record<string, string> = {
  building: 'Building',
  rebuilding: 'Rebuilding Image',
  up: 'Up',
  running: 'Running',
  completed: 'Needs Review',
  failed: 'Failed',
  idle: 'Idle',
  stopped: 'Stopped',
  pushed: 'Pushed',
  pr_created: 'PR Open',
  rate_limited: 'Rate Limited',
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function StackCard({ stack, showProject }: { stack: Stack; showProject?: boolean }) {
  const { selectStack, refreshStacks, stackMetrics } = useAppStore();
  const metrics: StackMetrics | undefined = stackMetrics[stack.id];

  const runningCount = stack.services.filter(
    (s) => s.status === 'running'
  ).length;
  const totalCount = stack.services.length;
  const failedServices = stack.services.filter((s) => s.status === 'exited');

  const handleTeardown = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Tear down stack "${stack.id}"? This will destroy all containers, volumes, and workspace files.`)) return;
    try {
      await window.sandstorm.stacks.teardown(stack.id);
      refreshStacks();
    } catch (err) {
      alert(`Failed to tear down: ${err}`);
    }
  };

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.sandstorm.stacks.stop(stack.id);
      refreshStacks();
    } catch (err) {
      alert(`Failed to stop: ${err}`);
    }
  };

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.sandstorm.stacks.start(stack.id);
      refreshStacks();
    } catch (err) {
      alert(`Failed to start: ${err}`);
    }
  };

  const statusColor = STATUS_COLORS[stack.status] ?? 'bg-gray-500';
  const badge = STATUS_BADGE[stack.status] ?? { bg: 'bg-gray-500/10 border-gray-500/20', text: 'text-gray-400' };
  const statusLabel = STATUS_LABELS[stack.status] ?? stack.status;

  return (
    <div
      className="group bg-sandstorm-surface border border-sandstorm-border rounded-xl p-4 hover:border-sandstorm-border-light hover:bg-sandstorm-surface-hover transition-all duration-150 cursor-pointer shadow-card hover:shadow-card-hover"
      onClick={() => selectStack(stack.id)}
      data-testid={`stack-card-${stack.id}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          {/* Stack name and status */}
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${statusColor} shrink-0`} />
            {showProject && (
              <span className="text-[13px] text-sandstorm-muted truncate">{stack.project} /</span>
            )}
            <span className="font-semibold text-[15px] text-sandstorm-text truncate">{stack.id}</span>
            <span
              className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${badge.bg} ${badge.text}`}
              data-testid={`stack-status-${stack.id}`}
            >
              {statusLabel}
            </span>
            <span className="text-[11px] text-sandstorm-muted ml-auto shrink-0">
              {timeAgo(stack.updated_at)}
            </span>
          </div>

          {/* Ticket and branch */}
          {(stack.ticket || stack.branch) && (
            <div className="mt-2 ml-5 flex items-center gap-1.5 text-xs text-sandstorm-muted">
              {stack.ticket && (
                <span className="bg-sandstorm-bg px-2 py-0.5 rounded-md font-mono text-[11px] border border-sandstorm-border">
                  {stack.ticket}
                </span>
              )}
              {stack.branch && (
                <span className="bg-sandstorm-bg px-2 py-0.5 rounded-md font-mono text-[11px] border border-sandstorm-border flex items-center gap-1">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="opacity-60">
                    <path d="M6 3v12M18 9a3 3 0 01-3 3H9M18 9a3 3 0 10-3-3"/>
                  </svg>
                  {stack.branch}
                </span>
              )}
            </div>
          )}

          {/* Description */}
          {stack.description && (
            <div className="mt-1.5 ml-5 text-xs text-sandstorm-text-secondary truncate">
              {stack.description}
            </div>
          )}

          {/* Error message for failed stacks */}
          {stack.status === 'failed' && stack.error && (
            <div className="mt-2 ml-5 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2.5 py-1.5 truncate" title={stack.error}>
              {stack.error}
            </div>
          )}

          {/* Service health summary */}
          {totalCount > 0 && (
            <div className="mt-3 ml-5 flex items-center gap-2.5 text-[11px]">
              <span className="text-sandstorm-muted font-medium">Services</span>
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
              <span className="text-sandstorm-muted tabular-nums">
                {runningCount}/{totalCount} up
                {failedServices.length > 0 && (
                  <span className="text-red-400 ml-1.5">
                    {failedServices.map((s) => s.name).join(', ')} exited
                  </span>
                )}
              </span>
            </div>
          )}

          {/* Rate limit indicator */}
          {stack.status === 'rate_limited' && stack.rate_limit_reset_at && (
            <div className="mt-2 ml-5 text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-md px-2.5 py-1.5 flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
              </svg>
              Rate limited — resumes at {new Date(stack.rate_limit_reset_at).toLocaleTimeString()}
            </div>
          )}

          {/* Metrics */}
          {metrics && (
            <div className="mt-2 ml-5 flex items-center gap-3 text-[11px] text-sandstorm-muted">
              {metrics.totalMemory > 0 && (
                <span className="tabular-nums" title="Total memory usage">
                  {formatBytes(metrics.totalMemory)}
                </span>
              )}
              {metrics.containers.length > 0 && (
                <span className="tabular-nums" title="Total CPU usage">
                  {metrics.containers.reduce((sum, c) => sum + c.cpuPercent, 0).toFixed(1)}% CPU
                </span>
              )}
              <span className="tabular-nums" title="Running duration">
                {getStackDuration(stack.created_at, stack.updated_at, stack.status)}
              </span>
              {metrics.taskMetrics.totalTasks > 0 && (
                <>
                  <span className="tabular-nums" title="Task iterations">
                    {metrics.taskMetrics.completedTasks}/{metrics.taskMetrics.totalTasks} tasks
                  </span>
                  {metrics.taskMetrics.avgTaskDurationMs > 0 && (
                    <span className="tabular-nums" title="Average task duration">
                      avg {formatMs(metrics.taskMetrics.avgTaskDurationMs)}
                    </span>
                  )}
                </>
              )}
              {(stack.total_input_tokens > 0 || stack.total_output_tokens > 0) && (
                <span className="tabular-nums" title={buildTokenTooltip(stack)}>
                  {formatTokenCount(stack.total_input_tokens + stack.total_output_tokens)} tokens
                </span>
              )}
            </div>
          )}
        </div>

        {/* Arrow */}
        <div className="text-sandstorm-muted ml-4 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </div>
      </div>

      {/* PR badge for pr_created stacks */}
      {stack.status === 'pr_created' && stack.pr_url && (
        <div className="mt-2 ml-5">
          <a
            href={stack.pr_url}
            onClick={(e) => { e.stopPropagation(); window.open(stack.pr_url!, '_blank'); e.preventDefault(); }}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-violet-400 bg-violet-500/10 border border-violet-500/20 rounded-md px-2 py-1 hover:bg-violet-500/20 transition-colors"
            data-testid={`pr-link-${stack.id}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M6 9v12"/>
            </svg>
            PR #{stack.pr_number}
          </a>
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-3 ml-5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {(stack.status === 'completed' || stack.status === 'pushed' || stack.status === 'pr_created') && (
          <>
            <ActionButton label="View Diff" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
            <ActionButton label="Push" onClick={(e) => { e.stopPropagation(); window.sandstorm.push.execute(stack.id); }} primary />
          </>
        )}
        {stack.status === 'running' && (
          <ActionButton label="View Output" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
        )}
        {(stack.status === 'up' || stack.status === 'idle' || stack.status === 'pushed' || stack.status === 'pr_created') && (
          <ActionButton label="New Task" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
        )}
        {stack.status === 'stopped' && (
          <ActionButton label="Start" onClick={handleStart} primary />
        )}
        {(stack.status === 'up' || stack.status === 'idle' || stack.status === 'running' || stack.status === 'completed' || stack.status === 'pushed' || stack.status === 'pr_created') && (
          <ActionButton label="Stop" onClick={handleStop} />
        )}
        {stack.status !== 'stopped' && (
          <ActionButton label="Shell" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
        )}
        {stack.status !== 'running' && stack.status !== 'building' && stack.status !== 'rebuilding' && (
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
  primary,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  primary?: boolean;
}) {
  const base = 'titlebar-no-drag text-[11px] font-medium px-2.5 py-1 rounded-md transition-all active:scale-[0.97]';
  const variant = danger
    ? 'text-red-400 hover:bg-red-500/10 hover:text-red-300'
    : primary
      ? 'bg-sandstorm-accent/10 text-sandstorm-accent hover:bg-sandstorm-accent/20'
      : 'text-sandstorm-muted hover:bg-sandstorm-surface hover:text-sandstorm-text-secondary';

  return (
    <button onClick={onClick} className={`${base} ${variant}`}>
      {label}
    </button>
  );
}
