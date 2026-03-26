/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { StackTableRow } from '../../../src/renderer/components/StackTableRow';
import { useAppStore, Stack } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeStack(overrides: Partial<Stack> = {}): Stack {
  return {
    id: 'test-stack',
    project: 'myproject',
    project_dir: '/proj',
    ticket: null,
    branch: null,
    description: null,
    status: 'running',
    error: null,
    pr_url: null,
    pr_number: null,
    runtime: 'docker',
    created_at: '2026-03-25 10:00:00',
    updated_at: '2026-03-25 10:05:00',
    services: [],
    ...overrides,
  };
}

function renderRow(stack: Stack) {
  return render(
    <table>
      <tbody>
        <StackTableRow stack={stack} />
      </tbody>
    </table>
  );
}

describe('StackTableRow duration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSandstormApi();
    useAppStore.setState({
      stacks: [],
      selectedStackId: null,
      stackMetrics: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows correct duration for a running stack using UTC parsing', () => {
    vi.setSystemTime(new Date('2026-03-25T10:30:00Z'));
    const stack = makeStack({ status: 'running', created_at: '2026-03-25 10:00:00' });
    renderRow(stack);
    expect(screen.getByText('30m')).toBeDefined();
  });

  it('shows frozen duration for completed stacks using updated_at', () => {
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
    const stack = makeStack({
      status: 'completed',
      created_at: '2026-03-25 10:00:00',
      updated_at: '2026-03-25 10:45:00',
    });
    renderRow(stack);
    // Should show 45m (created_at to updated_at), not 2h (created_at to now)
    expect(screen.getByText('45m')).toBeDefined();
  });

  it('shows frozen duration for failed stacks', () => {
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
    const stack = makeStack({
      status: 'failed',
      created_at: '2026-03-25 10:00:00',
      updated_at: '2026-03-25 10:20:00',
    });
    renderRow(stack);
    expect(screen.getByText('20m')).toBeDefined();
  });

  it('updates duration on interval for running stacks', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    const stack = makeStack({ status: 'running', created_at: '2026-03-25 10:00:00' });
    renderRow(stack);
    expect(screen.getByText('5m')).toBeDefined();

    // Advance 5 seconds (the update interval)
    act(() => {
      vi.advanceTimersByTime(5000);
      vi.setSystemTime(new Date('2026-03-25T10:06:00Z'));
    });

    // Need another tick to trigger the interval callback with new time
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByText('6m')).toBeDefined();
  });

  it('does not set up interval for completed stacks', () => {
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const stack = makeStack({
      status: 'completed',
      created_at: '2026-03-25 10:00:00',
      updated_at: '2026-03-25 10:45:00',
    });
    renderRow(stack);

    // setInterval may be called by React internals, but our effect should not
    // add one. We verify by checking the duration doesn't change when we advance time.
    act(() => {
      vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
      vi.advanceTimersByTime(60000);
    });

    // Duration should still be 45m, not 4h
    expect(screen.getByText('45m')).toBeDefined();
    setIntervalSpy.mockRestore();
  });
});
