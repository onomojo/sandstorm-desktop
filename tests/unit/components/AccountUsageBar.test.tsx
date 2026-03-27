/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AccountUsageBar } from '../../../src/renderer/components/AccountUsageBar';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('AccountUsageBar', () => {
  beforeEach(() => {
    mockSandstormApi();
    useAppStore.setState({
      globalTokenUsage: null,
      accountUsage: null,
    });
  });

  it('renders nothing when no usage data at all', () => {
    const { container } = render(<AccountUsageBar />);
    expect(container.innerHTML).toBe('');
  });

  it('renders token counter fallback when only stack usage exists (no account data)', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 300000,
        total_output_tokens: 200000,
        total_tokens: 500000,
        per_stack: [],
      },
    });
    render(<AccountUsageBar />);
    expect(screen.getByTestId('usage-counter')).toBeDefined();
    expect(screen.getByTestId('usage-counter').textContent).toBe('500.0k');
  });

  it('renders progress bar when account usage has a limit', () => {
    useAppStore.setState({
      accountUsage: {
        used_tokens: 500000,
        limit_tokens: 1000000,
        percent: 50,
        reset_at: null,
        reset_in: '2h 30m',
        subscription_type: 'max',
        rate_limit_tier: 'default_claude_max_5x',
      },
    });
    render(<AccountUsageBar />);
    expect(screen.getByTestId('usage-progress-fill')).toBeDefined();
    expect(screen.getByTestId('usage-percent').textContent).toBe('50%');
  });

  it('shows reset time when available', () => {
    useAppStore.setState({
      accountUsage: {
        used_tokens: 500000,
        limit_tokens: 1000000,
        percent: 50,
        reset_at: '2026-03-27T20:00:00.000Z',
        reset_in: '2h 43m',
        subscription_type: 'max',
        rate_limit_tier: 'default_claude_max_5x',
      },
    });
    render(<AccountUsageBar />);
    expect(screen.getByTestId('usage-reset-in').textContent).toBe('2h 43m');
  });

  it('caps progress at 100% when over limit', () => {
    useAppStore.setState({
      accountUsage: {
        used_tokens: 1500000,
        limit_tokens: 1000000,
        percent: 150,
        reset_at: null,
        reset_in: null,
        subscription_type: 'max',
        rate_limit_tier: null,
      },
    });
    render(<AccountUsageBar />);
    expect(screen.getByTestId('usage-percent').textContent).toBe('100%');
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.style.width).toBe('100%');
  });

  it('opens usage popover on click', () => {
    useAppStore.setState({
      accountUsage: {
        used_tokens: 500000,
        limit_tokens: 1000000,
        percent: 50,
        reset_at: null,
        reset_in: '2h 30m',
        subscription_type: 'max',
        rate_limit_tier: null,
      },
    });
    render(<AccountUsageBar />);
    expect(screen.queryByTestId('usage-popover')).toBeNull();
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    expect(screen.getByTestId('usage-popover')).toBeDefined();
  });

  it('shows account details in popover', () => {
    useAppStore.setState({
      accountUsage: {
        used_tokens: 500000,
        limit_tokens: 1000000,
        percent: 50,
        reset_at: '2026-03-27T20:00:00.000Z',
        reset_in: '2h 43m',
        subscription_type: 'max',
        rate_limit_tier: 'default_claude_max_5x',
      },
      globalTokenUsage: {
        total_input_tokens: 200000,
        total_output_tokens: 100000,
        total_tokens: 300000,
        per_stack: [],
      },
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));

    const popover = screen.getByTestId('usage-popover');
    expect(popover.textContent).toContain('Account Usage');
    expect(popover.textContent).toContain('500.0k');
    expect(popover.textContent).toContain('1.00M');
    expect(popover.textContent).toContain('Max');
    expect(popover.textContent).toContain('2h 43m');
    // Session tokens section
    expect(popover.textContent).toContain('Session Tokens');
    expect(popover.textContent).toContain('300.0k');
  });

  it('shows correct color for high usage (red at 90%+)', () => {
    useAppStore.setState({
      accountUsage: {
        used_tokens: 950000,
        limit_tokens: 1000000,
        percent: 95,
        reset_at: null,
        reset_in: null,
        subscription_type: 'max',
        rate_limit_tier: null,
      },
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-red-500');
    const percent = screen.getByTestId('usage-percent');
    expect(percent.className).toContain('text-red-400');
  });

  it('shows correct color for medium usage (yellow at 50-74%)', () => {
    useAppStore.setState({
      accountUsage: {
        used_tokens: 600000,
        limit_tokens: 1000000,
        percent: 60,
        reset_at: null,
        reset_in: null,
        subscription_type: 'max',
        rate_limit_tier: null,
      },
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-yellow-500');
  });

  it('shows correct color for low usage (green at <50%)', () => {
    useAppStore.setState({
      accountUsage: {
        used_tokens: 200000,
        limit_tokens: 1000000,
        percent: 20,
        reset_at: null,
        reset_in: null,
        subscription_type: 'max',
        rate_limit_tier: null,
      },
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-emerald-500');
  });

  it('shows correct color for orange usage (75-89%)', () => {
    useAppStore.setState({
      accountUsage: {
        used_tokens: 800000,
        limit_tokens: 1000000,
        percent: 80,
        reset_at: null,
        reset_in: null,
        subscription_type: 'max',
        rate_limit_tier: null,
      },
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-orange-500');
  });

  it('falls back to counter when account usage has no limit', () => {
    useAppStore.setState({
      accountUsage: {
        used_tokens: 0,
        limit_tokens: 0,
        percent: 0,
        reset_at: null,
        reset_in: null,
        subscription_type: 'max',
        rate_limit_tier: null,
      },
      globalTokenUsage: {
        total_input_tokens: 100000,
        total_output_tokens: 50000,
        total_tokens: 150000,
        per_stack: [],
      },
    });
    render(<AccountUsageBar />);
    // Should show counter since account usage has no limit
    expect(screen.getByTestId('usage-counter')).toBeDefined();
    expect(screen.getByTestId('usage-counter').textContent).toBe('150.0k');
  });
});
