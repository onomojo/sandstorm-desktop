/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AccountUsageBar } from '../../../src/renderer/components/AccountUsageBar';
import { useAppStore } from '../../../src/renderer/store';
import type { SessionMonitorState, UsageSnapshot } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    session: { percent: 50, resetsAt: '6pm (America/New_York)' },
    weekAll: null,
    weekSonnet: null,
    extraUsage: { enabled: false },
    capturedAt: new Date().toISOString(),
    status: 'ok',
    ...overrides,
  };
}

function makeMonitorState(overrides: Partial<SessionMonitorState> = {}): SessionMonitorState {
  return {
    usage: null,
    level: 'normal',
    stale: false,
    halted: false,
    lastPollAt: null,
    consecutiveFailures: 0,
    pollMode: 'normal',
    nextPollAt: null,
    idle: false,
    claudeAvailable: true,
    ...overrides,
  };
}

describe('AccountUsageBar', () => {
  beforeEach(() => {
    mockSandstormApi();
    useAppStore.setState({
      globalTokenUsage: null,
      sessionMonitorState: null,
    });
  });

  it('renders nothing when no usage data at all', () => {
    const { container } = render(<AccountUsageBar />);
    expect(container.innerHTML).toBe('');
  });

  it('renders token counter fallback when only stack usage exists (no session data)', () => {
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
  });

  it('renders progress bar when session usage data exists', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot({ session: { percent: 50, resetsAt: '6pm (America/New_York)' } }),
      }),
    });
    render(<AccountUsageBar />);
    expect(screen.getByTestId('usage-progress-fill')).toBeDefined();
    expect(screen.getByTestId('usage-percent').textContent).toBe('50%');
  });

  it('caps progress bar width at 100% when over limit but shows raw percent', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot({ session: { percent: 150, resetsAt: '6pm (America/New_York)' } }),
      }),
    });
    render(<AccountUsageBar />);
    expect(screen.getByTestId('usage-percent').textContent).toBe('150%');
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.style.width).toBe('100%');
  });

  it('opens usage popover on click', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot(),
      }),
    });
    render(<AccountUsageBar />);
    expect(screen.queryByTestId('usage-popover')).toBeNull();
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    expect(screen.getByTestId('usage-popover')).toBeDefined();
  });

  it('shows session details in popover', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot({
          session: { percent: 47, resetsAt: '6pm (America/New_York)' },
          weekAll: { percent: 14, resetsAt: 'Apr 10, 10am (America/New_York)' },
        }),
        lastPollAt: new Date().toISOString(),
      }),
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
    expect(popover.textContent).toContain('Session Usage');
    expect(popover.textContent).toContain('47% used');
    expect(popover.textContent).toContain('Week (all models)');
    expect(popover.textContent).toContain('14%');
    expect(popover.textContent).toContain('Stack Tokens');
  });

  it('shows correct color for high usage (red at 90%+)', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot({ session: { percent: 95, resetsAt: '6pm' } }),
      }),
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-red-500');
    const percent = screen.getByTestId('usage-percent');
    expect(percent.className).toContain('text-red-400');
  });

  it('shows correct color for medium usage (emerald at <70%)', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot({ session: { percent: 60, resetsAt: '6pm' } }),
      }),
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-emerald-500');
  });

  it('shows correct color for amber usage (70-89%)', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot({ session: { percent: 80, resetsAt: '6pm' } }),
      }),
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-amber-500');
  });

  it('shows flashing red bar when over 100%', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot({ session: { percent: 120, resetsAt: '6pm' } }),
      }),
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-red-500');
    expect(fill.className).toContain('animate-pulse');
  });

  it('shows per-project breakdown when multiple projects exist', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 500000,
        total_output_tokens: 300000,
        total_tokens: 800000,
        per_stack: [],
        per_project: [
          { project: 'alpha', project_dir: '/alpha', input_tokens: 300000, output_tokens: 200000, total_tokens: 500000 },
          { project: 'beta', project_dir: '/beta', input_tokens: 200000, output_tokens: 100000, total_tokens: 300000 },
        ],
      },
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));

    const rows = screen.getAllByTestId('project-usage-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('alpha');
    expect(rows[1].textContent).toContain('beta');
  });

  it('shows HALTED badge in popover when session is halted', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot({ session: { percent: 95, resetsAt: '6pm' } }),
        level: 'limit',
        halted: true,
      }),
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    expect(screen.getByTestId('halted-badge')).toBeDefined();
    expect(screen.getByTestId('halted-badge').textContent).toBe('HALTED');
  });

  it('shows STALE badge in popover when session data is stale', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot(),
        stale: true,
        consecutiveFailures: 3,
      }),
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    expect(screen.getByTestId('stale-badge')).toBeDefined();
    expect(screen.getByTestId('stale-badge').textContent).toBe('STALE');
  });

  it('shows IDLE badge in popover when monitor is idle', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot(),
        idle: true,
      }),
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    expect(screen.getByTestId('idle-badge')).toBeDefined();
    expect(screen.getByTestId('idle-badge').textContent).toBe('IDLE');
  });

  it('shows claude CLI missing warning in popover', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        claudeAvailable: false,
      }),
      globalTokenUsage: {
        total_input_tokens: 100,
        total_output_tokens: 50,
        total_tokens: 150,
        per_stack: [],
      },
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    const popover = screen.getByTestId('usage-popover');
    expect(popover.textContent).toContain('Claude CLI not installed');
  });

  it('shows extra usage status', () => {
    useAppStore.setState({
      sessionMonitorState: makeMonitorState({
        usage: makeSnapshot({ extraUsage: { enabled: true } }),
      }),
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    const popover = screen.getByTestId('usage-popover');
    expect(popover.textContent).toContain('Enabled');
  });
});
