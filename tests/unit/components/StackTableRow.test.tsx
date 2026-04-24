/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
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
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_execution_input_tokens: 0,
    total_execution_output_tokens: 0,
    total_review_input_tokens: 0,
    total_review_output_tokens: 0,
    rate_limit_reset_at: null,
    current_model: null,
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

describe('StackTableRow model column', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSandstormApi();
    useAppStore.setState({ stacks: [], selectedStackId: null, stackMetrics: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows capitalized model name when current_model is set', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ current_model: 'sonnet' }));
    expect(screen.getByText('Sonnet')).toBeDefined();
  });

  it('shows capitalized Opus when model is opus', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ current_model: 'opus' }));
    expect(screen.getByText('Opus')).toBeDefined();
  });

  it('shows dash when current_model is null', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ current_model: null }));
    // The dash is rendered as a span with text content "—"
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });
});

describe('StackTableRow primary-action chip (#315)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSandstormApi();
    useAppStore.setState({
      stacks: [], selectedStackId: null, stackMetrics: {},
      showCreatePRDialog: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows Make PR chip when status is completed and pr_url is null', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ id: 'foo', status: 'completed', pr_url: null }));
    expect(screen.getByTestId('row-make-pr-foo')).toBeDefined();
  });

  it('shows Make PR chip when status is pushed and pr_url is null', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ id: 'bar', status: 'pushed', pr_url: null }));
    expect(screen.getByTestId('row-make-pr-bar')).toBeDefined();
  });

  it('hides Make PR chip when pr_url already exists', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({
      id: 'baz',
      status: 'pushed',
      pr_url: 'https://github.com/o/r/pull/9',
      pr_number: 9,
    }));
    expect(screen.queryByTestId('row-make-pr-baz')).toBeNull();
  });

  it('hides Make PR chip when status is running (not ready to ship)', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ id: 'qux', status: 'running' }));
    expect(screen.queryByTestId('row-make-pr-qux')).toBeNull();
  });

  it('clicking Make PR opens the CreatePRDialog for that stack', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ id: 'foo', status: 'completed', pr_url: null }));
    screen.getByTestId('row-make-pr-foo').click();
    expect(useAppStore.getState().showCreatePRDialog).toEqual({ stackId: 'foo' });
  });

  it('shows ↗#N PR link when pr_url + pr_number are set', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({
      id: 'open',
      status: 'pr_created',
      pr_url: 'https://github.com/o/r/pull/312',
      pr_number: 312,
    }));
    const link = screen.getByTestId('row-pr-link-open');
    expect(link).toBeDefined();
    expect(link.textContent).toMatch(/#312/);
  });
});

describe('StackTableRow action button visibility (#316)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSandstormApi();
    useAppStore.setState({ stacks: [], selectedStackId: null, stackMetrics: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Teardown is visible without hovering the row (no opacity-0 wrapper)', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ id: 'foo', status: 'completed' }));
    const teardown = screen.getByTestId('row-teardown-foo');
    // Walk the parent chain — none should carry opacity-0 / group-hover.
    let el: HTMLElement | null = teardown;
    while (el) {
      expect(el.className).not.toMatch(/opacity-0/);
      expect(el.className).not.toMatch(/group-hover:opacity-100/);
      el = el.parentElement;
    }
  });

  it('Teardown is hidden while a task is running (destructive guard, unchanged)', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ id: 'busy', status: 'running' }));
    expect(screen.queryByTestId('row-teardown-busy')).toBeNull();
  });

  it('actions cell is sticky to the right edge so it stays visible during scroll', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ id: 'foo', status: 'completed' }));
    const cell = screen.getByTestId('row-actions-foo');
    // Tailwind's `sticky right-0` on a <td> — verify the classes survived.
    expect(cell.className).toMatch(/\bsticky\b/);
    expect(cell.className).toMatch(/right-0/);
  });
});

describe('StackTableRow popover suppression on actions hover (#316)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSandstormApi();
    useAppStore.setState({ stacks: [], selectedStackId: null, stackMetrics: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the pending popover when the cursor enters the actions cell', async () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ id: 'foo', status: 'completed' }));

    // Hover the row — popover would normally appear after the open delay.
    const row = screen.getByTestId('row-actions-foo').closest('tr')!;
    fireEvent.mouseEnter(row);

    // Cursor moves to the actions cell BEFORE the delay elapses.
    const actions = screen.getByTestId('row-actions-foo');
    fireEvent.mouseEnter(actions);

    // Run timers; popover should NOT have opened.
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByTestId(/stack-row-popover-/)).toBeNull();
  });

  it('hides an already-open popover when the cursor enters the actions cell', () => {
    vi.setSystemTime(new Date('2026-03-25T10:05:00Z'));
    renderRow(makeStack({ id: 'foo', status: 'completed' }));

    const row = screen.getByTestId('row-actions-foo').closest('tr')!;
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId('stack-row-popover-foo')).not.toBeNull();

    // Now move cursor to actions — popover should disappear.
    const actions = screen.getByTestId('row-actions-foo');
    fireEvent.mouseEnter(actions);
    expect(screen.queryByTestId('stack-row-popover-foo')).toBeNull();
  });
});
