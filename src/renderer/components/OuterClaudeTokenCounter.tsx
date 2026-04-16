import React from 'react';
import {
  useAppStore,
  OuterClaudeSessionTokens,
  outerClaudeTotal,
  outerClaudeTier,
  OuterClaudeTokenTier,
} from '../store';
import { formatTokenCount } from '../utils/format';

interface OuterClaudeTokenCounterProps {
  tabId: string;
}

const TIER_CLASSES: Record<OuterClaudeTokenTier, string> = {
  normal: 'text-sandstorm-muted',
  warning: 'text-yellow-400',
  danger: 'text-red-400',
  critical: 'text-red-500 animate-pulse',
  blocked: 'text-red-500 animate-pulse',
};

const TIER_LABELS: Record<OuterClaudeTokenTier, string> = {
  normal: 'Orchestrator session tokens',
  warning: 'Orchestrator session approaching size limits',
  danger: 'Orchestrator session is large — consider starting a new one',
  critical: 'Orchestrator session is critically large — start a new one soon',
  blocked: 'Orchestrator session too large — new stack creation blocked',
};

/**
 * Displays the CURRENT orchestrator session's token total for the given
 * agent tab. Reads from the Zustand store (populated by agent:token-usage
 * IPC events). Shows zero when no session exists yet. Color tier shifts
 * at 100K / 150K / 200K thresholds; ≥200K blinks; ≥250K also blocks new
 * stack creation (blocking is enforced elsewhere).
 */
export function OuterClaudeTokenCounter({ tabId }: OuterClaudeTokenCounterProps) {
  const tokens = useAppStore((s) => s.outerClaudeTokens[tabId]) as
    | OuterClaudeSessionTokens
    | undefined;
  const total = outerClaudeTotal(tokens);
  const tier = outerClaudeTier(total);

  const tooltip = [
    TIER_LABELS[tier],
    `Input: ${(tokens?.input_tokens ?? 0).toLocaleString()}`,
    `Output: ${(tokens?.output_tokens ?? 0).toLocaleString()}`,
    `Cache write: ${(tokens?.cache_creation_input_tokens ?? 0).toLocaleString()}`,
    `Cache read: ${(tokens?.cache_read_input_tokens ?? 0).toLocaleString()}`,
    `Total: ${total.toLocaleString()}`,
  ].join('\n');

  return (
    <span
      data-testid="outer-claude-token-counter"
      data-tier={tier}
      title={tooltip}
      className={`text-[10px] tabular-nums font-medium ${TIER_CLASSES[tier]}`}
    >
      {formatTokenCount(total)} tok
    </span>
  );
}
