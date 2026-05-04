import React, { useEffect, useRef, useState } from 'react';
import { Stack, StackMetrics, useAppStore } from '../store';
import { getStackDuration, isTerminalStatus, DURATION_UPDATE_INTERVAL } from '../utils/duration';
import { StackRowPopover } from './StackRowPopover';

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
  session_paused: 'bg-orange-400',
};

const STATUS_LABELS: Record<string, string> = {
  building: 'Building',
  rebuilding: 'Rebuilding',
  up: 'Up',
  running: 'Running',
  completed: 'Review',
  failed: 'Failed',
  idle: 'Idle',
  stopped: 'Stopped',
  pushed: 'Pushed',
  pr_created: 'PR Open',
  rate_limited: 'Limited',
  session_paused: 'Halted',
};

const POPOVER_OPEN_DELAY_MS = 150;

function makePrEligible(stack: Stack): boolean {
  return (stack.status === 'completed' || stack.status === 'pushed') && !stack.pr_url;
}

export function StackTableRow({
  stack,
  showProject,
  columnWidths,
}: {
  stack: Stack;
  showProject?: boolean;
  columnWidths?: Record<string, number>;
}) {
  const { selectStack, refreshStacks, stackMetrics, setShowCreatePRDialog, resumeStackWithContinuation } = useAppStore();
  const metrics: StackMetrics | undefined = stackMetrics[stack.id];
  const [duration, setDuration] = useState(() =>
    getStackDuration(stack.created_at, stack.updated_at, stack.status),
  );
  const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDuration(getStackDuration(stack.created_at, stack.updated_at, stack.status));
    if (!isTerminalStatus(stack.status)) {
      const interval = setInterval(() => {
        setDuration(getStackDuration(stack.created_at, stack.updated_at, stack.status));
      }, DURATION_UPDATE_INTERVAL);
      return () => clearInterval(interval);
    }
  }, [stack.created_at, stack.updated_at, stack.status]);

  useEffect(() => () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
  }, []);

  const handleMouseEnter = () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    enterTimer.current = setTimeout(() => {
      if (rowRef.current) {
        setPopoverRect(rowRef.current.getBoundingClientRect());
      }
    }, POPOVER_OPEN_DELAY_MS);
  };

  const handleMouseLeave = () => {
    if (enterTimer.current) {
      clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
    setPopoverRect(null);
  };

  // #316 — the popover is anchored to the row's right edge and overlaps
  // the action buttons in narrow viewports, blocking clicks. Suppress it
  // entirely when the cursor enters the actions cell so buttons stay
  // clickable. We don't auto-reopen on leave; the user can mouse off and
  // back on if they want details again.
  const handleActionsEnter = () => {
    if (enterTimer.current) {
      clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
    setPopoverRect(null);
  };

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

  const handleMakePr = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowCreatePRDialog({ stackId: stack.id });
  };

  const handleResume = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await resumeStackWithContinuation(stack.id);
    } catch (err) {
      alert(`Failed to resume: ${err}`);
    }
  };

  const handlePrLink = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (stack.pr_url) {
      window.open(stack.pr_url, '_blank');
    }
  };

  return (
    <>
      <tr
        ref={rowRef}
        className="border-b border-sandstorm-border bg-sandstorm-bg hover:bg-sandstorm-surface-hover cursor-pointer transition-colors group"
        onClick={() => selectStack(stack.id)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <td
          className="px-3 py-2 whitespace-nowrap overflow-hidden"
          style={columnWidths?.status ? { width: `${columnWidths.status}px` } : undefined}
        >
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor} shrink-0`} />
            <span className="text-sandstorm-text-secondary">{statusLabel}</span>
          </div>
        </td>
        <td
          className="px-3 py-2 whitespace-nowrap overflow-hidden"
          style={columnWidths?.name ? { width: `${columnWidths.name}px` } : undefined}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {showProject && (
              <span className="text-sandstorm-muted truncate">{stack.project}/</span>
            )}
            <span className="font-medium text-sandstorm-text truncate">{stack.id}</span>
            {stack.pr_url && stack.pr_number && (
              <button
                onClick={handlePrLink}
                className="text-[10px] font-medium px-1.5 py-0.5 rounded text-violet-400 bg-violet-500/10 border border-violet-500/20 hover:bg-violet-500/20 transition-colors shrink-0"
                title={stack.pr_url}
                data-testid={`row-pr-link-${stack.id}`}
              >
                ↗ #{stack.pr_number}
              </button>
            )}
          </div>
        </td>
        <td
          className="px-3 py-2 whitespace-nowrap overflow-hidden"
          style={columnWidths?.model ? { width: `${columnWidths.model}px` } : undefined}
        >
          <span className="text-sandstorm-text-secondary">
            {stack.current_model
              ? stack.current_model.charAt(0).toUpperCase() + stack.current_model.slice(1)
              : <span className="text-sandstorm-muted">—</span>}
          </span>
        </td>
        <td
          className="px-3 py-2 whitespace-nowrap overflow-hidden"
          style={columnWidths?.services ? { width: `${columnWidths.services}px` } : undefined}
        >
          {totalCount > 0 ? (
            <span className="text-sandstorm-text-secondary tabular-nums">
              {runningCount}/{totalCount}
            </span>
          ) : (
            <span className="text-sandstorm-muted">—</span>
          )}
        </td>
        <td
          className="px-3 py-2 whitespace-nowrap text-sandstorm-muted tabular-nums overflow-hidden"
          style={columnWidths?.duration ? { width: `${columnWidths.duration}px` } : undefined}
        >
          {duration}
        </td>
        <td
          className="px-3 py-2 whitespace-nowrap text-right overflow-hidden sticky right-0 z-[1] bg-sandstorm-bg group-hover:bg-sandstorm-surface-hover border-l border-sandstorm-border"
          // Width is fixed by `actions.defaultWidth` in TABLE_COLUMNS — the
          // column has no resize handle (it's last in the row), so the
          // user can't drag it shrunk and lose the buttons (#316).
          style={columnWidths?.actions ? { width: `${columnWidths.actions}px` } : undefined}
          data-testid={`row-actions-${stack.id}`}
          onMouseEnter={handleActionsEnter}
        >
          <div className="flex items-center gap-1 justify-end">
            {/* Persistent primary action — always visible when applicable */}
            {stack.status === 'session_paused' && (
              <button
                onClick={handleResume}
                className="text-[10px] font-medium px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 transition-colors"
                data-testid={`row-resume-${stack.id}`}
                title="Resume this halted stack and continue the in-flight task"
              >
                ▶ Resume
              </button>
            )}
            {makePrEligible(stack) && (
              <button
                onClick={handleMakePr}
                className="text-[10px] font-medium px-2 py-0.5 rounded bg-sandstorm-accent/10 text-sandstorm-accent border border-sandstorm-accent/30 hover:bg-sandstorm-accent/20 transition-colors"
                data-testid={`row-make-pr-${stack.id}`}
                title="Draft and open a pull request for this stack"
              >
                🆕 Make PR
              </button>
            )}
            {/* Teardown — always visible (#316). Was opacity-0 group-hover
                but the user couldn't reach it without the popover blocking. */}
            {stack.status !== 'running' && (
              <button
                onClick={handleTeardown}
                className="text-[10px] px-1.5 py-0.5 rounded text-red-400 hover:bg-red-500/10 transition-colors"
                data-testid={`row-teardown-${stack.id}`}
              >
                Teardown
              </button>
            )}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-sandstorm-muted"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </div>
        </td>
      </tr>
      {popoverRect && (
        <tr aria-hidden>
          <td colSpan={6} className="p-0">
            <StackRowPopover stack={stack} metrics={metrics} anchorRect={popoverRect} />
          </td>
        </tr>
      )}
    </>
  );
}
