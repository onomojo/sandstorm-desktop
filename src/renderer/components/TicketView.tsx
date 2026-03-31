import React, { useState } from 'react';
import { Stack, StackMetrics, useAppStore } from '../store';
import { getStackDuration } from '../utils/duration';

const STATUS_COLORS: Record<string, string> = {
  building: 'bg-amber-400',
  rebuilding: 'bg-amber-400 animate-pulse',
  up: 'bg-emerald-400',
  running: 'bg-blue-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  idle: 'bg-amber-400',
  stopped: 'bg-gray-500',
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
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

interface TicketGroup {
  ticket: string | null;
  stacks: Stack[];
}

function groupStacksByTicket(stacks: Stack[]): TicketGroup[] {
  const grouped = new Map<string, Stack[]>();
  const ungrouped: Stack[] = [];

  for (const stack of stacks) {
    if (stack.ticket) {
      const existing = grouped.get(stack.ticket);
      if (existing) {
        existing.push(stack);
      } else {
        grouped.set(stack.ticket, [stack]);
      }
    } else {
      ungrouped.push(stack);
    }
  }

  const groups: TicketGroup[] = [];
  for (const [ticket, ticketStacks] of grouped) {
    groups.push({ ticket, stacks: ticketStacks });
  }
  if (ungrouped.length > 0) {
    groups.push({ ticket: null, stacks: ungrouped });
  }
  return groups;
}

function statusSummary(stacks: Stack[]): string {
  const counts: Record<string, number> = {};
  for (const s of stacks) {
    const label = STATUS_LABELS[s.status] ?? s.status;
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, count]) => `${count} ${label.toLowerCase()}`)
    .join(', ');
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export function TicketView({ stacks, showProject }: { stacks: Stack[]; showProject?: boolean }) {
  const groups = groupStacksByTicket(stacks);
  const [expandedTickets, setExpandedTickets] = useState<Set<string | null>>(new Set());

  const toggleTicket = (ticket: string | null) => {
    setExpandedTickets((prev) => {
      const next = new Set(prev);
      if (next.has(ticket)) {
        next.delete(ticket);
      } else {
        next.add(ticket);
      }
      return next;
    });
  };

  if (groups.length === 0) return null;

  return (
    <div className="space-y-2 p-4">
      {groups.map((group) => {
        const key = group.ticket ?? '__ungrouped__';
        const isExpanded = expandedTickets.has(group.ticket);

        return (
          <div
            key={key}
            className="bg-sandstorm-surface border border-sandstorm-border rounded-xl overflow-hidden shadow-card"
          >
            {/* Level 1: Ticket header */}
            <button
              onClick={() => toggleTicket(group.ticket)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-sandstorm-surface-hover transition-colors text-left"
            >
              <span className="text-sandstorm-muted">
                <ChevronIcon expanded={isExpanded} />
              </span>
              <span className="font-semibold text-sm text-sandstorm-text font-mono">
                {group.ticket ?? 'Ungrouped'}
              </span>
              <span className="text-[11px] text-sandstorm-muted">
                {group.stacks.length} stack{group.stacks.length === 1 ? '' : 's'}
              </span>
              <span className="ml-auto text-[11px] text-sandstorm-muted">
                {statusSummary(group.stacks)}
              </span>
            </button>

            {/* Level 2: Stacks within ticket */}
            <div
              className={`transition-all duration-200 ease-in-out overflow-hidden ${
                isExpanded ? 'max-h-[5000px] opacity-100' : 'max-h-0 opacity-0'
              }`}
            >
              <div className="border-t border-sandstorm-border">
                {group.stacks.map((stack) => (
                  <TicketStackRow key={stack.id} stack={stack} showProject={showProject} />
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TicketStackRow({ stack, showProject }: { stack: Stack; showProject?: boolean }) {
  const { selectStack, refreshStacks, stackMetrics } = useAppStore();
  const metrics: StackMetrics | undefined = stackMetrics[stack.id];
  const [expanded, setExpanded] = useState(false);

  const statusColor = STATUS_COLORS[stack.status] ?? 'bg-gray-500';
  const badge = STATUS_BADGE[stack.status] ?? { bg: 'bg-gray-500/10 border-gray-500/20', text: 'text-gray-400' };
  const statusLabel = STATUS_LABELS[stack.status] ?? stack.status;

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

  return (
    <div className="group border-t border-sandstorm-border first:border-t-0">
      {/* Stack row */}
      <div className="flex items-center gap-3 px-4 py-2.5 pl-8 hover:bg-sandstorm-surface-hover transition-colors">
        {/* Chevron for services */}
        {stack.services.length > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="text-sandstorm-muted hover:text-sandstorm-text-secondary transition-colors"
          >
            <ChevronIcon expanded={expanded} />
          </button>
        ) : (
          <span className="w-[14px]" />
        )}

        <div className={`w-2 h-2 rounded-full ${statusColor} shrink-0`} />

        {showProject && (
          <span className="text-[11px] text-sandstorm-muted truncate">{stack.project} /</span>
        )}

        <button
          onClick={() => selectStack(stack.id)}
          className="font-medium text-[13px] text-sandstorm-text hover:text-sandstorm-accent transition-colors truncate text-left"
        >
          {stack.id}
        </button>

        <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${badge.bg} ${badge.text}`}>
          {statusLabel}
        </span>

        {stack.current_model && (
          <span className="text-[10px] text-sandstorm-muted px-1.5 py-0.5 rounded border border-sandstorm-border bg-sandstorm-bg" data-testid={`ticket-stack-model-${stack.id}`}>
            {stack.current_model.charAt(0).toUpperCase() + stack.current_model.slice(1)}
          </span>
        )}

        {stack.description && (
          <span className="text-[11px] text-sandstorm-text-secondary truncate hidden xl:inline">
            {stack.description}
          </span>
        )}

        <span className="ml-auto text-[11px] text-sandstorm-muted tabular-nums shrink-0">
          {getStackDuration(stack.created_at, stack.updated_at, stack.status)}
        </span>

        {/* Hover action buttons */}
        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {stack.status === 'completed' && (
            <>
              <ActionButton label="View Diff" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
              <ActionButton label="Push" onClick={(e) => { e.stopPropagation(); window.sandstorm.push.execute(stack.id); }} primary />
            </>
          )}
          {stack.status === 'running' && (
            <ActionButton label="View Output" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
          )}
          {(stack.status === 'up' || stack.status === 'idle') && (
            <ActionButton label="New Task" onClick={(e) => { e.stopPropagation(); selectStack(stack.id); }} />
          )}
          {stack.status === 'stopped' && (
            <ActionButton label="Start" onClick={handleStart} primary />
          )}
          {(stack.status === 'up' || stack.status === 'idle' || stack.status === 'running' || stack.status === 'completed') && (
            <ActionButton label="Stop" onClick={handleStop} />
          )}
          {stack.status !== 'running' && stack.status !== 'building' && stack.status !== 'rebuilding' && (
            <ActionButton label="Tear Down" onClick={handleTeardown} danger />
          )}
        </div>
      </div>

      {/* Level 3: Services within stack */}
      <div
        className={`transition-all duration-200 ease-in-out overflow-hidden ${
          expanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        {stack.services.map((svc) => {
          const containerStats = metrics?.containers.find((c) => c.containerId === svc.containerId);
          return (
            <div
              key={svc.containerId}
              className="flex items-center gap-2 px-4 py-1.5 pl-16 text-[11px] border-t border-sandstorm-border/50 bg-sandstorm-bg/30"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  svc.status === 'running'
                    ? 'bg-emerald-400'
                    : svc.status === 'exited'
                      ? 'bg-red-400'
                      : svc.status === 'restarting'
                        ? 'bg-amber-400 animate-pulse'
                        : 'bg-gray-500'
                }`}
              />
              <span className="font-medium text-sandstorm-text">{svc.name}</span>
              <span className="text-sandstorm-muted capitalize">
                {svc.status}
                {svc.status === 'exited' && svc.exitCode !== undefined && (
                  <span className="text-red-400"> ({svc.exitCode})</span>
                )}
              </span>
              {containerStats && (
                <span className="ml-auto text-sandstorm-muted tabular-nums">
                  {formatBytes(containerStats.memoryUsage)} / {containerStats.cpuPercent.toFixed(1)}% CPU
                </span>
              )}
            </div>
          );
        })}
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
