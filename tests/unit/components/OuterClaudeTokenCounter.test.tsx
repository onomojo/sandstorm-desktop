/**
 * @vitest-environment jsdom
 *
 * Unit + integration coverage for the orchestrator token counter (issue #238).
 *
 * These tests verify:
 *   - Color tier boundaries (100K / 150K / 200K / 250K) are exact (off-by-one safe).
 *   - The counter reads from the CURRENT orchestrator session — not a cumulative
 *     cross-session aggregate.
 *   - Cache creation/read tokens are included in the displayed total.
 *   - IPC/store boundary: `agent:token-usage:<tabId>` events flow through the
 *     stream service into the Zustand store and then into the rendered counter.
 *   - New Session clears the counter (belt-and-suspenders — backend also emits zero).
 *   - No stale aggregate is shown for fresh sessions (regression for the 339K bug).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { OuterClaudeTokenCounter } from '../../../src/renderer/components/OuterClaudeTokenCounter';
import { AgentSession } from '../../../src/renderer/components/AgentSession';
import {
  useAppStore,
  outerClaudeTier,
  outerClaudeTotal,
  OUTER_CLAUDE_WARNING_THRESHOLD,
  OUTER_CLAUDE_DANGER_THRESHOLD,
  OUTER_CLAUDE_CRITICAL_THRESHOLD,
  OUTER_CLAUDE_BLOCK_THRESHOLD,
  zeroOuterClaudeSessionTokens,
} from '../../../src/renderer/store';
import { registerAgentStreamListeners, _resetForTesting } from '../../../src/renderer/agentStreamService';
import { mockSandstormApi } from './setup';

function setTokens(tabId: string, partial: Partial<ReturnType<typeof zeroOuterClaudeSessionTokens>>) {
  useAppStore.getState().setOuterClaudeTokens(tabId, {
    ...zeroOuterClaudeSessionTokens(),
    ...partial,
  });
}

describe('outerClaudeTier — color tier boundaries', () => {
  it('returns normal below the warning threshold', () => {
    expect(outerClaudeTier(0)).toBe('normal');
    expect(outerClaudeTier(OUTER_CLAUDE_WARNING_THRESHOLD - 1)).toBe('normal');
  });

  it('returns warning at exactly 100K', () => {
    expect(outerClaudeTier(OUTER_CLAUDE_WARNING_THRESHOLD)).toBe('warning');
  });

  it('returns warning between 100K and 150K', () => {
    expect(outerClaudeTier(OUTER_CLAUDE_DANGER_THRESHOLD - 1)).toBe('warning');
  });

  it('returns danger at exactly 150K', () => {
    expect(outerClaudeTier(OUTER_CLAUDE_DANGER_THRESHOLD)).toBe('danger');
  });

  it('returns danger between 150K and 200K', () => {
    expect(outerClaudeTier(OUTER_CLAUDE_CRITICAL_THRESHOLD - 1)).toBe('danger');
  });

  it('returns critical at exactly 200K', () => {
    expect(outerClaudeTier(OUTER_CLAUDE_CRITICAL_THRESHOLD)).toBe('critical');
  });

  it('returns critical between 200K and 250K', () => {
    expect(outerClaudeTier(OUTER_CLAUDE_BLOCK_THRESHOLD - 1)).toBe('critical');
  });

  it('returns blocked at exactly 250K', () => {
    expect(outerClaudeTier(OUTER_CLAUDE_BLOCK_THRESHOLD)).toBe('blocked');
  });

  it('returns blocked above 250K', () => {
    expect(outerClaudeTier(OUTER_CLAUDE_BLOCK_THRESHOLD + 1)).toBe('blocked');
    expect(outerClaudeTier(1_000_000)).toBe('blocked');
  });
});

describe('outerClaudeTotal — token accounting', () => {
  it('returns 0 for null/undefined', () => {
    expect(outerClaudeTotal(null)).toBe(0);
    expect(outerClaudeTotal(undefined)).toBe(0);
  });

  it('includes all four fields — input, output, cache creation, cache read', () => {
    expect(
      outerClaudeTotal({
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 400,
      })
    ).toBe(1000);
  });
});

describe('OuterClaudeTokenCounter — rendering and tiers', () => {
  beforeEach(() => {
    mockSandstormApi();
    useAppStore.setState({ outerClaudeTokens: {} });
  });

  it('shows 0 tok when no session exists for the tab', () => {
    render(<OuterClaudeTokenCounter tabId="tab1" />);
    const el = screen.getByTestId('outer-claude-token-counter');
    expect(el.textContent).toBe('0 tok');
    expect(el.getAttribute('data-tier')).toBe('normal');
  });

  it('renders the sum of all four token types (regression — cache tokens not dropped)', () => {
    setTokens('tab1', {
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_creation_input_tokens: 3_000,
      cache_read_input_tokens: 4_000,
    });
    render(<OuterClaudeTokenCounter tabId="tab1" />);
    const el = screen.getByTestId('outer-claude-token-counter');
    // formatTokenCount renders 10000 as "10.0k"
    expect(el.textContent).toContain('10.0k');
  });

  it('applies the warning tier at 100K (yellow)', () => {
    setTokens('tab1', { input_tokens: OUTER_CLAUDE_WARNING_THRESHOLD });
    render(<OuterClaudeTokenCounter tabId="tab1" />);
    const el = screen.getByTestId('outer-claude-token-counter');
    expect(el.getAttribute('data-tier')).toBe('warning');
    expect(el.className).toContain('yellow');
  });

  it('applies the danger tier at 150K (red)', () => {
    setTokens('tab1', { input_tokens: OUTER_CLAUDE_DANGER_THRESHOLD });
    render(<OuterClaudeTokenCounter tabId="tab1" />);
    const el = screen.getByTestId('outer-claude-token-counter');
    expect(el.getAttribute('data-tier')).toBe('danger');
    expect(el.className).toContain('red-400');
  });

  it('applies the critical tier at 200K (red + animate-pulse)', () => {
    setTokens('tab1', { input_tokens: OUTER_CLAUDE_CRITICAL_THRESHOLD });
    render(<OuterClaudeTokenCounter tabId="tab1" />);
    const el = screen.getByTestId('outer-claude-token-counter');
    expect(el.getAttribute('data-tier')).toBe('critical');
    expect(el.className).toContain('animate-pulse');
  });

  it('applies the blocked tier at 250K (red + animate-pulse)', () => {
    setTokens('tab1', { input_tokens: OUTER_CLAUDE_BLOCK_THRESHOLD });
    render(<OuterClaudeTokenCounter tabId="tab1" />);
    const el = screen.getByTestId('outer-claude-token-counter');
    expect(el.getAttribute('data-tier')).toBe('blocked');
    expect(el.className).toContain('animate-pulse');
  });

  it('isolates sessions by tabId (tab A counter unaffected by tab B tokens)', () => {
    setTokens('tab-A', { input_tokens: 50 });
    setTokens('tab-B', { input_tokens: OUTER_CLAUDE_BLOCK_THRESHOLD });
    render(<OuterClaudeTokenCounter tabId="tab-A" />);
    const el = screen.getByTestId('outer-claude-token-counter');
    expect(el.getAttribute('data-tier')).toBe('normal');
  });
});

describe('IPC/store integration — agent:token-usage listener', () => {
  let api: ReturnType<typeof mockSandstormApi>;
  let eventHandlers: Record<string, (...args: unknown[]) => void>;

  beforeEach(() => {
    _resetForTesting();
    useAppStore.setState({ outerClaudeTokens: {}, agentSessions: {} });
    api = mockSandstormApi();
    eventHandlers = {};
    api.on.mockImplementation((channel: string, cb: (...args: unknown[]) => void) => {
      eventHandlers[channel] = cb;
      return () => {
        delete eventHandlers[channel];
      };
    });
  });

  it('writes incoming token usage into the store under the correct tabId', () => {
    registerAgentStreamListeners('tab1');
    const handler = eventHandlers['agent:token-usage:tab1'];
    expect(handler).toBeDefined();

    act(() => {
      handler({
        input_tokens: 1_000,
        output_tokens: 2_000,
        cache_creation_input_tokens: 3_000,
        cache_read_input_tokens: 4_000,
      });
    });

    expect(useAppStore.getState().outerClaudeTokens['tab1']).toEqual({
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_creation_input_tokens: 3_000,
      cache_read_input_tokens: 4_000,
    });
  });

  it('updates the rendered counter live as new token-usage events arrive', () => {
    registerAgentStreamListeners('tab1');
    render(<OuterClaudeTokenCounter tabId="tab1" />);
    const el = screen.getByTestId('outer-claude-token-counter');
    expect(el.textContent).toBe('0 tok');

    act(() => {
      eventHandlers['agent:token-usage:tab1']({
        input_tokens: OUTER_CLAUDE_WARNING_THRESHOLD,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
    });
    expect(el.getAttribute('data-tier')).toBe('warning');
  });

  it('zero payload from backend resets the store slice (reset via IPC push)', () => {
    registerAgentStreamListeners('tab1');
    const handler = eventHandlers['agent:token-usage:tab1'];

    act(() => handler({ input_tokens: 50_000, output_tokens: 50_000, cache_creation_input_tokens: 50_000, cache_read_input_tokens: 50_000 }));
    expect(outerClaudeTotal(useAppStore.getState().outerClaudeTokens['tab1'])).toBe(200_000);

    // Backend emits zero when resetSession runs
    act(() => handler(zeroOuterClaudeSessionTokens()));
    expect(outerClaudeTotal(useAppStore.getState().outerClaudeTokens['tab1'])).toBe(0);
  });
});

describe('AgentSession — token counter placement and reset behavior', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    _resetForTesting();
    useAppStore.setState({ outerClaudeTokens: {}, agentSessions: {} });
    api = mockSandstormApi();
    api.agent.history.mockResolvedValue({ messages: [], processing: false });
  });

  it('renders the counter immediately to the left of the New Session button', async () => {
    await act(async () => {
      render(<AgentSession tabId="tab1" projectDir="/test" />);
    });

    const counter = screen.getByTestId('outer-claude-token-counter');
    const newSessionBtn = screen.getByText('New Session');

    // Both siblings of the same flex row in the header — counter must come
    // BEFORE the New Session button in DOM order.
    const pos = counter.compareDocumentPosition(newSessionBtn);
    // DOCUMENT_POSITION_FOLLOWING === 0x04 — newSessionBtn follows counter
    // eslint-disable-next-line no-bitwise
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('fetches initial token state from the backend on mount (no stale aggregate)', async () => {
    api.agent.tokenUsage.mockResolvedValue({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    await act(async () => {
      render(<AgentSession tabId="tab1" projectDir="/test" />);
    });

    // Regression: ensures the counter does NOT display a cross-session
    // aggregate (like the 339K bug). A fresh backend reports zero, counter
    // shows zero.
    expect(api.agent.tokenUsage).toHaveBeenCalledWith('tab1');
    const counter = screen.getByTestId('outer-claude-token-counter');
    expect(counter.textContent).toBe('0 tok');
  });

  it('clears token counter locally when New Session is clicked', async () => {
    // Pre-populate the store as if the user had accumulated tokens
    setTokens('tab1', {
      input_tokens: 150_000,
      output_tokens: 50_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    api.agent.tokenUsage.mockResolvedValue({
      input_tokens: 150_000,
      output_tokens: 50_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    await act(async () => {
      render(<AgentSession tabId="tab1" projectDir="/test" />);
    });

    // Click "New Session"
    await act(async () => {
      screen.getByText('New Session').click();
      await Promise.resolve();
    });

    // Store should have been cleared locally (the backend ALSO emits zero via
    // agent:token-usage on reset, but this is the belt-and-suspenders guard
    // so the UI never shows a stale total even for a moment).
    expect(useAppStore.getState().outerClaudeTokens['tab1']).toBeUndefined();
    expect(api.agent.reset).toHaveBeenCalledWith('tab1');
  });
});
