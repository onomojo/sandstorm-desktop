import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../store';

function getBarColor(percent: number): string {
  if (percent > 100) return 'bg-red-500 animate-pulse';
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function getTextColor(percent: number): string {
  if (percent > 100) return 'text-red-400 animate-pulse';
  if (percent >= 90) return 'text-red-400';
  if (percent >= 70) return 'text-amber-400';
  return 'text-emerald-400';
}

export function AccountUsageBar() {
  const { globalTokenUsage, sessionMonitorState } = useAppStore();
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!showPopover) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setShowPopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPopover]);

  const usage = sessionMonitorState?.usage;
  const sessionBlock = usage?.session;
  const hasSessionData = sessionBlock !== null && sessionBlock !== undefined;
  const hasStackData = globalTokenUsage && globalTokenUsage.total_tokens > 0;

  // Nothing to show at all
  if (!hasSessionData && !hasStackData) return null;

  const rawPercent = hasSessionData ? sessionBlock.percent : 0;
  const percent = Math.min(rawPercent, 100);
  const resetsAt = hasSessionData ? sessionBlock.resetsAt : null;
  const isIdle = sessionMonitorState?.idle ?? false;
  const isRefreshing = !usage && !sessionMonitorState?.stale;

  return (
    <div className="titlebar-no-drag relative flex items-center" data-testid="account-usage-bar">
      <button
        ref={buttonRef}
        onClick={() => setShowPopover(!showPopover)}
        className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-sandstorm-surface-hover transition-colors group"
        title={hasSessionData
          ? `Session: ${Math.round(rawPercent)}% used${resetsAt ? `\nResets ${resetsAt}` : ''}${sessionMonitorState?.halted ? '\nStacks halted — session limit reached' : ''}`
          : `Stack tokens: ${(globalTokenUsage?.total_tokens ?? 0).toLocaleString()}`}
        data-testid="usage-bar-button"
      >
        {/* Token icon */}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sandstorm-muted opacity-60 shrink-0">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>

        {hasSessionData ? (
          /* Session usage progress bar */
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-sandstorm-border rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${getBarColor(rawPercent)}`}
                style={{ width: `${percent}%` }}
                data-testid="usage-progress-fill"
              />
            </div>
            <span className={`text-[10px] tabular-nums font-medium ${getTextColor(rawPercent)}`} data-testid="usage-percent">
              {isRefreshing ? '...' : `${Math.round(rawPercent)}%`}
            </span>
          </div>
        ) : (
          /* Fallback: show stack token counter */
          <span className="text-[10px] tabular-nums text-sandstorm-muted group-hover:text-sandstorm-text-secondary transition-colors" data-testid="usage-counter">
            {(globalTokenUsage?.total_tokens ?? 0).toLocaleString()}
          </span>
        )}
      </button>

      {/* Usage detail popover */}
      {showPopover && (
        <div
          ref={popoverRef}
          className="absolute top-full right-0 mt-1 w-60 bg-sandstorm-surface border border-sandstorm-border rounded-lg shadow-xl z-50 p-3"
          data-testid="usage-popover"
        >
          <div className="text-[11px] font-semibold text-sandstorm-text mb-2 flex items-center gap-2">
            Session Usage
            {sessionMonitorState?.halted && (
              <span className="text-[9px] font-bold text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded" data-testid="halted-badge">
                HALTED
              </span>
            )}
            {sessionMonitorState?.stale && (
              <span className="text-[9px] font-bold text-yellow-400 bg-yellow-500/10 px-1.5 py-0.5 rounded" data-testid="stale-badge">
                STALE
              </span>
            )}
            {isIdle && (
              <span className="text-[9px] font-bold text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded" data-testid="idle-badge">
                IDLE
              </span>
            )}
          </div>

          {/* Session usage */}
          {hasSessionData && (
            <div className="mb-3">
              <div className="text-[10px] text-sandstorm-muted mb-1">Current Session</div>
              <div className="w-full h-2 bg-sandstorm-border rounded-full overflow-hidden mb-1.5">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${getBarColor(rawPercent)}`}
                  style={{ width: `${percent}%` }}
                  data-testid="popover-progress-fill"
                />
              </div>
              <div className="flex justify-between text-[10px]">
                <span className={`tabular-nums font-medium ${getTextColor(rawPercent)}`}>
                  {Math.round(rawPercent)}% used
                </span>
                {resetsAt && (
                  <span className="text-sandstorm-muted tabular-nums">
                    Resets {resetsAt}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Week usage blocks */}
          {usage?.weekAll && (
            <div className="mb-2">
              <div className="flex justify-between text-[10px]">
                <span className="text-sandstorm-muted">Week (all models)</span>
                <span className="text-sandstorm-text-secondary tabular-nums">{usage.weekAll.percent}%</span>
              </div>
            </div>
          )}
          {usage?.weekSonnet && (
            <div className="mb-2">
              <div className="flex justify-between text-[10px]">
                <span className="text-sandstorm-muted">Week (Sonnet)</span>
                <span className="text-sandstorm-text-secondary tabular-nums">{usage.weekSonnet.percent}%</span>
              </div>
            </div>
          )}

          {/* Extra usage status */}
          {usage && (
            <div className="mb-2">
              <div className="flex justify-between text-[10px]">
                <span className="text-sandstorm-muted">Extra usage</span>
                <span className={usage.extraUsage.enabled ? 'text-amber-400' : 'text-sandstorm-text-secondary'}>
                  {usage.extraUsage.enabled ? 'Enabled' : 'Not enabled'}
                </span>
              </div>
            </div>
          )}

          {/* Last updated */}
          {sessionMonitorState?.lastPollAt && (
            <div className="text-[10px] text-sandstorm-muted mt-2 pt-2 border-t border-sandstorm-border">
              Last updated: {new Date(sessionMonitorState.lastPollAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {sessionMonitorState.pollMode === 'rate_limited' && (
                <span className="ml-1 text-amber-400">(rate limited)</span>
              )}
            </div>
          )}

          {/* claude CLI missing warning */}
          {sessionMonitorState?.claudeAvailable === false && (
            <div className="text-[10px] text-red-400 mt-2 pt-2 border-t border-sandstorm-border">
              Claude CLI not installed — session monitoring unavailable
            </div>
          )}

          {/* Stack usage section */}
          {globalTokenUsage && globalTokenUsage.total_tokens > 0 && (
            <div className="mt-3 pt-2 border-t border-sandstorm-border">
              <div className="text-[10px] text-sandstorm-muted mb-1 font-medium">Stack Tokens</div>
              <div className="text-[10px] text-sandstorm-muted space-y-0.5">
                <div className="flex justify-between">
                  <span>Total</span>
                  <span className="text-sandstorm-text-secondary tabular-nums">{globalTokenUsage.total_tokens.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Input</span>
                  <span className="tabular-nums">{globalTokenUsage.total_input_tokens.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Output</span>
                  <span className="tabular-nums">{globalTokenUsage.total_output_tokens.toLocaleString()}</span>
                </div>
              </div>

              {/* Per-project breakdown */}
              {globalTokenUsage.per_project && globalTokenUsage.per_project.length > 1 && (
                <div className="mt-2 pt-1.5 border-t border-sandstorm-border/50">
                  <div className="text-[10px] text-sandstorm-muted mb-0.5 font-medium">By Project</div>
                  <div className="space-y-0.5">
                    {globalTokenUsage.per_project.map((p) => (
                      <div key={p.project_dir} className="flex justify-between" data-testid="project-usage-row">
                        <span className="truncate mr-2">{p.project}</span>
                        <span className="text-sandstorm-text-secondary tabular-nums shrink-0">{p.total_tokens.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
