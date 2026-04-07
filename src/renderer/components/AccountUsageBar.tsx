import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../store';
import { formatTokenCount } from '../utils/format';

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

function formatTierLabel(tier: string | null, sub: string | null): string {
  if (sub === 'max') return 'Max';
  if (sub === 'pro') return 'Pro';
  if (tier) {
    // e.g. "default_claude_max_5x" -> "Max 5x"
    const match = tier.match(/(\w+)_(\d+x)$/);
    if (match) return `${match[1].charAt(0).toUpperCase() + match[1].slice(1)} ${match[2]}`;
  }
  return sub ?? 'Unknown';
}

export function AccountUsageBar() {
  const { accountUsage, globalTokenUsage, sessionMonitorState } = useAppStore();
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

  // If we have account usage from the API with a real limit, use that.
  // Otherwise fall back to showing aggregated stack token usage.
  const hasAccountData = accountUsage && accountUsage.limit_tokens > 0;
  const hasStackData = globalTokenUsage && globalTokenUsage.total_tokens > 0;

  // Nothing to show at all
  if (!hasAccountData && !hasStackData && !accountUsage) return null;

  const rawPercent = hasAccountData ? accountUsage.percent : 0;
  const percent = Math.min(rawPercent, 100); // cap bar width at 100%
  const usedTokens = hasAccountData ? accountUsage.used_tokens : (globalTokenUsage?.total_tokens ?? 0);
  const limitTokens = hasAccountData ? accountUsage.limit_tokens : 0;
  const resetIn = hasAccountData ? accountUsage.reset_in : null;
  const tierLabel = formatTierLabel(
    accountUsage?.rate_limit_tier ?? null,
    accountUsage?.subscription_type ?? null
  );

  return (
    <div className="titlebar-no-drag relative flex items-center" data-testid="account-usage-bar">
      <button
        ref={buttonRef}
        onClick={() => setShowPopover(!showPopover)}
        className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-sandstorm-surface-hover transition-colors group"
        title={hasAccountData
          ? `Usage: ${formatTokenCount(usedTokens)} / ${formatTokenCount(limitTokens)} (${Math.round(rawPercent)}%)${resetIn ? `\nResets in ${resetIn}` : ''}${sessionMonitorState?.halted ? '\nStacks halted — session limit reached' : ''}`
          : `Stack tokens: ${(globalTokenUsage?.total_tokens ?? 0).toLocaleString()}`}
        data-testid="usage-bar-button"
      >
        {/* Token icon */}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sandstorm-muted opacity-60 shrink-0">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>

        {hasAccountData ? (
          /* Account rate limit progress bar */
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-sandstorm-border rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${getBarColor(rawPercent)}`}
                style={{ width: `${percent}%` }}
                data-testid="usage-progress-fill"
              />
            </div>
            <span className={`text-[10px] tabular-nums font-medium ${getTextColor(rawPercent)}`} data-testid="usage-percent">
              {Math.round(rawPercent)}%
            </span>
            {resetIn && (
              <span className="text-[10px] tabular-nums text-sandstorm-muted" data-testid="usage-reset-in">
                {resetIn}
              </span>
            )}
          </div>
        ) : (
          /* Fallback: show stack token counter */
          <span className="text-[10px] tabular-nums text-sandstorm-muted group-hover:text-sandstorm-text-secondary transition-colors" data-testid="usage-counter">
            {formatTokenCount(globalTokenUsage?.total_tokens ?? 0)}
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
            Account Usage
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
          </div>

          {/* Account rate limit info */}
          {hasAccountData && (
            <div className="mb-3">
              {/* Large progress bar */}
              <div className="w-full h-2 bg-sandstorm-border rounded-full overflow-hidden mb-1.5">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${getBarColor(rawPercent)}`}
                  style={{ width: `${percent}%` }}
                  data-testid="popover-progress-fill"
                />
              </div>
              <div className="flex justify-between text-[10px]">
                <span className={`tabular-nums font-medium ${getTextColor(rawPercent)}`}>
                  {formatTokenCount(usedTokens)} / {formatTokenCount(limitTokens)}
                </span>
                <span className="text-sandstorm-muted tabular-nums">
                  {Math.round(rawPercent)}%
                </span>
              </div>
            </div>
          )}

          {/* Details */}
          <div className="text-[10px] text-sandstorm-muted space-y-0.5">
            {accountUsage?.subscription_type && (
              <div className="flex justify-between">
                <span>Plan</span>
                <span className="text-sandstorm-text-secondary">{tierLabel}</span>
              </div>
            )}
            {hasAccountData && (
              <>
                <div className="flex justify-between">
                  <span>Used</span>
                  <span className="text-sandstorm-text-secondary tabular-nums">{formatTokenCount(usedTokens)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Limit</span>
                  <span className="text-sandstorm-text-secondary tabular-nums">{formatTokenCount(limitTokens)}</span>
                </div>
              </>
            )}
            {resetIn && (
              <div className="flex justify-between">
                <span>Resets in</span>
                <span className="text-sandstorm-text-secondary" data-testid="popover-reset-in">{resetIn}</span>
              </div>
            )}
            {accountUsage?.reset_at && (
              <div className="flex justify-between">
                <span>Resets at</span>
                <span className="text-sandstorm-text-secondary tabular-nums">
                  {new Date(accountUsage.reset_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            )}
          </div>

          {/* Stack usage section */}
          {globalTokenUsage && globalTokenUsage.total_tokens > 0 && (
            <div className="mt-3 pt-2 border-t border-sandstorm-border">
              <div className="text-[10px] text-sandstorm-muted mb-1 font-medium">Session Tokens</div>
              <div className="text-[10px] text-sandstorm-muted space-y-0.5">
                <div className="flex justify-between">
                  <span>Total</span>
                  <span className="text-sandstorm-text-secondary tabular-nums">{formatTokenCount(globalTokenUsage.total_tokens)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Input</span>
                  <span className="tabular-nums">{formatTokenCount(globalTokenUsage.total_input_tokens)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Output</span>
                  <span className="tabular-nums">{formatTokenCount(globalTokenUsage.total_output_tokens)}</span>
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
                        <span className="text-sandstorm-text-secondary tabular-nums shrink-0">{formatTokenCount(p.total_tokens)}</span>
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
