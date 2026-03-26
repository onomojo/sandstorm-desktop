import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../store';
import { formatTokenCount } from '../utils/format';

const BUDGET_PRESETS = [500_000, 1_000_000, 5_000_000, 10_000_000, 50_000_000];

function getBarColor(percent: number): string {
  if (percent < 50) return 'bg-emerald-500';
  if (percent < 75) return 'bg-yellow-500';
  if (percent < 90) return 'bg-orange-500';
  return 'bg-red-500';
}

function getTextColor(percent: number): string {
  if (percent < 50) return 'text-emerald-400';
  if (percent < 75) return 'text-yellow-400';
  if (percent < 90) return 'text-orange-400';
  return 'text-red-400';
}

export function AccountUsageBar() {
  const { globalTokenUsage, tokenBudget, setTokenBudget } = useAppStore();
  const [showPopover, setShowPopover] = useState(false);
  const [customBudget, setCustomBudget] = useState('');
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

  const totalTokens = globalTokenUsage?.total_tokens ?? 0;
  const hasBudget = tokenBudget > 0;
  const percent = hasBudget ? Math.min((totalTokens / tokenBudget) * 100, 100) : 0;

  const handleSetBudget = (value: number) => {
    setTokenBudget(value);
    setShowPopover(false);
    setCustomBudget('');
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(customBudget);
    if (!isNaN(parsed) && parsed > 0) {
      // Support shorthand: "1M", "500k", or raw numbers
      let value = parsed;
      const lower = customBudget.toLowerCase().trim();
      if (lower.endsWith('m')) {
        value = parseFloat(lower) * 1_000_000;
      } else if (lower.endsWith('k')) {
        value = parseFloat(lower) * 1_000;
      }
      if (value > 0) {
        handleSetBudget(Math.round(value));
      }
    }
  };

  // Don't render anything if no usage data yet
  if (!globalTokenUsage) return null;

  return (
    <div className="titlebar-no-drag relative flex items-center" data-testid="account-usage-bar">
      <button
        ref={buttonRef}
        onClick={() => setShowPopover(!showPopover)}
        className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-sandstorm-surface-hover transition-colors group"
        title={`Total tokens: ${totalTokens.toLocaleString()}${hasBudget ? ` / ${tokenBudget.toLocaleString()} budget` : ''}\nInput: ${(globalTokenUsage.total_input_tokens ?? 0).toLocaleString()}\nOutput: ${(globalTokenUsage.total_output_tokens ?? 0).toLocaleString()}\nClick to set budget`}
        data-testid="usage-bar-button"
      >
        {/* Token icon */}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sandstorm-muted opacity-60 shrink-0">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>

        {hasBudget ? (
          /* Progress bar mode */
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-sandstorm-border rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${getBarColor(percent)}`}
                style={{ width: `${percent}%` }}
                data-testid="usage-progress-fill"
              />
            </div>
            <span className={`text-[10px] tabular-nums font-medium ${getTextColor(percent)}`} data-testid="usage-percent">
              {Math.round(percent)}%
            </span>
          </div>
        ) : (
          /* Counter mode (no budget set) */
          <span className="text-[10px] tabular-nums text-sandstorm-muted group-hover:text-sandstorm-text-secondary transition-colors" data-testid="usage-counter">
            {formatTokenCount(totalTokens)}
          </span>
        )}
      </button>

      {/* Budget popover */}
      {showPopover && (
        <div
          ref={popoverRef}
          className="absolute top-full right-0 mt-1 w-56 bg-sandstorm-surface border border-sandstorm-border rounded-lg shadow-xl z-50 p-3"
          data-testid="budget-popover"
        >
          <div className="text-[11px] font-semibold text-sandstorm-text mb-2">Token Budget</div>

          {/* Current usage summary */}
          <div className="text-[10px] text-sandstorm-muted mb-3 space-y-0.5">
            <div className="flex justify-between">
              <span>Total used</span>
              <span className="text-sandstorm-text-secondary tabular-nums">{formatTokenCount(totalTokens)}</span>
            </div>
            <div className="flex justify-between">
              <span>Input</span>
              <span className="tabular-nums">{formatTokenCount(globalTokenUsage.total_input_tokens)}</span>
            </div>
            <div className="flex justify-between">
              <span>Output</span>
              <span className="tabular-nums">{formatTokenCount(globalTokenUsage.total_output_tokens)}</span>
            </div>
            {hasBudget && (
              <div className="flex justify-between pt-1 border-t border-sandstorm-border">
                <span>Budget</span>
                <span className="text-sandstorm-text-secondary tabular-nums">{formatTokenCount(tokenBudget)}</span>
              </div>
            )}
          </div>

          {/* Preset buttons */}
          <div className="text-[10px] text-sandstorm-muted mb-1.5">Set budget</div>
          <div className="flex flex-wrap gap-1 mb-2">
            {BUDGET_PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => handleSetBudget(preset)}
                className={`px-2 py-0.5 text-[10px] rounded-md border transition-colors ${
                  tokenBudget === preset
                    ? 'bg-sandstorm-accent/15 border-sandstorm-accent/30 text-sandstorm-accent'
                    : 'bg-sandstorm-bg border-sandstorm-border text-sandstorm-muted hover:text-sandstorm-text-secondary hover:border-sandstorm-border-light'
                }`}
                data-testid={`budget-preset-${preset}`}
              >
                {formatTokenCount(preset)}
              </button>
            ))}
          </div>

          {/* Custom input */}
          <form onSubmit={handleCustomSubmit} className="flex gap-1">
            <input
              type="text"
              value={customBudget}
              onChange={(e) => setCustomBudget(e.target.value)}
              placeholder="e.g. 2M, 500k"
              className="flex-1 bg-sandstorm-bg border border-sandstorm-border rounded-md px-2 py-1 text-[10px] text-sandstorm-text placeholder:text-sandstorm-muted/50 focus:outline-none focus:border-sandstorm-accent/50"
              data-testid="custom-budget-input"
            />
            <button
              type="submit"
              className="px-2 py-1 text-[10px] bg-sandstorm-accent/15 text-sandstorm-accent rounded-md hover:bg-sandstorm-accent/25 transition-colors"
            >
              Set
            </button>
          </form>

          {/* Clear budget */}
          {hasBudget && (
            <button
              onClick={() => handleSetBudget(0)}
              className="mt-2 w-full text-[10px] text-sandstorm-muted hover:text-red-400 transition-colors text-center"
              data-testid="clear-budget"
            >
              Clear budget
            </button>
          )}
        </div>
      )}
    </div>
  );
}
