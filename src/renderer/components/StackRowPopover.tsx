import React from 'react';
import { Stack, StackMetrics } from '../store';
import { formatBytes, formatTokenCount, buildTokenTooltip } from '../utils/format';

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

const SERVICE_DOT: Record<string, string> = {
  running: 'bg-emerald-400',
  exited: 'bg-red-400',
};

/**
 * Hover popover for trimmed table rows. Renders the details we dropped from
 * the row (description, services, resources, timestamps) anchored to the
 * cursor. Pure render — all data comes from props.
 */
export function StackRowPopover({
  stack,
  metrics,
  anchorRect,
}: {
  stack: Stack;
  metrics: StackMetrics | undefined;
  anchorRect: DOMRect;
}) {
  const totalCpu = metrics?.containers.reduce((s, c) => s + c.cpuPercent, 0) ?? 0;
  const totalTokens = stack.total_input_tokens + stack.total_output_tokens;
  const tokenTooltip = totalTokens > 0 ? buildTokenTooltip(stack) : '';

  // Anchor to the right edge of the row, vertically centered. Clamp so it
  // doesn't fall off the viewport.
  const popoverWidth = 360;
  const margin = 12;
  const left = Math.min(
    window.innerWidth - popoverWidth - margin,
    Math.max(margin, anchorRect.right + 8),
  );
  const top = Math.min(
    window.innerHeight - 200,
    Math.max(margin, anchorRect.top),
  );

  return (
    <div
      className="fixed z-40 pointer-events-none"
      style={{ left, top, width: popoverWidth }}
      data-testid={`stack-row-popover-${stack.id}`}
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-lg shadow-dialog p-4 space-y-3 animate-fade-in pointer-events-auto">
        <div>
          <div className="text-[13px] font-semibold text-sandstorm-text">{stack.id}</div>
          <div className="text-[11px] text-sandstorm-muted mt-0.5 flex items-center gap-1.5 flex-wrap">
            {stack.ticket && (
              <span className="bg-sandstorm-bg px-1.5 py-0.5 rounded font-mono border border-sandstorm-border">
                {stack.ticket}
              </span>
            )}
            {stack.branch && (
              <span className="bg-sandstorm-bg px-1.5 py-0.5 rounded font-mono border border-sandstorm-border">
                {stack.branch}
              </span>
            )}
          </div>
        </div>

        {stack.description && (
          <div className="text-xs text-sandstorm-text-secondary leading-relaxed">
            {stack.description}
          </div>
        )}

        {stack.services.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-sandstorm-muted mb-1.5">
              Services
            </div>
            <div className="space-y-1">
              {stack.services.map((svc) => (
                <div key={svc.name} className="flex items-center gap-2 text-xs text-sandstorm-text-secondary">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${SERVICE_DOT[svc.status] ?? 'bg-amber-400'}`} />
                  <span className="font-mono">{svc.name}</span>
                  <span className="text-sandstorm-muted ml-auto tabular-nums">
                    {svc.status}
                    {svc.exitCode !== undefined && svc.status === 'exited' && ` (code ${svc.exitCode})`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(metrics || totalTokens > 0) && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-sandstorm-muted mb-1.5">
              Resources
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {metrics && metrics.totalMemory > 0 && (
                <>
                  <span className="text-sandstorm-muted">Memory</span>
                  <span className="text-sandstorm-text-secondary tabular-nums text-right">
                    {formatBytes(metrics.totalMemory)}
                  </span>
                </>
              )}
              {metrics && metrics.containers.length > 0 && (
                <>
                  <span className="text-sandstorm-muted">CPU</span>
                  <span className="text-sandstorm-text-secondary tabular-nums text-right">
                    {totalCpu.toFixed(1)}%
                  </span>
                </>
              )}
              {totalTokens > 0 && (
                <>
                  <span className="text-sandstorm-muted">Tokens</span>
                  <span className="text-sandstorm-text-secondary tabular-nums text-right" title={tokenTooltip}>
                    {formatTokenCount(totalTokens)}
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        <div className="text-[10px] text-sandstorm-muted/70 border-t border-sandstorm-border pt-2">
          Started {timeAgo(stack.created_at)} · last update {timeAgo(stack.updated_at)}
        </div>
      </div>
    </div>
  );
}
