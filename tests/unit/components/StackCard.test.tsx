/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StackCard } from '../../../src/renderer/components/StackCard';
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
    status: 'up',
    error: null,
    pr_url: null,
    pr_number: null,
    runtime: 'docker',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_execution_input_tokens: 0,
    total_execution_output_tokens: 0,
    total_review_input_tokens: 0,
    total_review_output_tokens: 0,
    rate_limit_reset_at: null,
    current_model: null,
    selfheal_continue_used: 0,
    latest_task_token_limited: false,
    services: [],
    ...overrides,
  };
}

describe('StackCard', () => {
  beforeEach(() => {
    mockSandstormApi();
    useAppStore.setState({
      stacks: [],
      selectedStackId: null,
    });
  });

  it('renders stack name and status', () => {
    render(<StackCard stack={makeStack({ id: 'my-stack', status: 'running' })} />);
    expect(screen.getByText('my-stack')).toBeDefined();
    expect(screen.getByTestId('stack-status-my-stack').textContent).toBe('Running');
  });

  it('shows ticket and branch when present', () => {
    render(
      <StackCard
        stack={makeStack({ ticket: 'EXP-123', branch: 'feature/auth' })}
      />
    );
    expect(screen.getByText('EXP-123')).toBeDefined();
    expect(screen.getByText('feature/auth')).toBeDefined();
  });

  it('hides ticket and branch when null', () => {
    render(<StackCard stack={makeStack()} />);
    expect(screen.queryByText('EXP-123')).toBeNull();
  });

  it('shows description when present', () => {
    render(<StackCard stack={makeStack({ description: 'Fix the login bug' })} />);
    expect(screen.getByText('Fix the login bug')).toBeDefined();
  });

  it('shows project name when showProject is true', () => {
    render(<StackCard stack={makeStack({ project: 'cool-project' })} showProject />);
    expect(screen.getByText(/cool-project/)).toBeDefined();
  });

  it('selects stack when clicked', () => {
    render(<StackCard stack={makeStack({ id: 'click-test' })} />);
    fireEvent.click(screen.getByTestId('stack-card-click-test'));
    expect(useAppStore.getState().selectedStackId).toBe('click-test');
  });

  it('renders correct status labels', () => {
    const statuses: [string, string][] = [
      ['building', 'Building'],
      ['rebuilding', 'Rebuilding Image'],
      ['up', 'Up'],
      ['running', 'Running'],
      ['completed', 'Needs Review'],
      ['failed', 'Failed'],
      ['idle', 'Idle'],
      ['stopped', 'Stopped'],
      ['pushed', 'Pushed'],
      ['pr_created', 'PR Open'],
      ['session_paused', 'Halted'],
    ];

    for (const [status, label] of statuses) {
      const { unmount } = render(
        <StackCard stack={makeStack({ id: `s-${status}`, status })} />
      );
      expect(screen.getByTestId(`stack-status-s-${status}`).textContent).toBe(label);
      unmount();
    }
  });

  it('shows error message for failed stacks', () => {
    render(
      <StackCard
        stack={makeStack({
          id: 'fail-stack',
          status: 'failed',
          error: 'compose failed: image not found',
        })}
      />
    );
    expect(screen.getByText('compose failed: image not found')).toBeDefined();
  });

  it('does not show error for non-failed stacks', () => {
    render(
      <StackCard
        stack={makeStack({
          id: 'ok-stack',
          status: 'up',
          error: null,
        })}
      />
    );
    expect(screen.queryByText(/compose failed/)).toBeNull();
  });

  it('does not show error when failed stack has no error message', () => {
    render(
      <StackCard
        stack={makeStack({
          id: 'fail-no-msg',
          status: 'failed',
          error: null,
        })}
      />
    );
    // Should show Failed status but no error text content
    expect(screen.getByTestId('stack-status-fail-no-msg').textContent).toBe('Failed');
    // No error message text should be present beyond the status badge
    expect(screen.queryByText(/compose failed/)).toBeNull();
  });

  it('shows PR link for pr_created stacks', () => {
    render(
      <StackCard
        stack={makeStack({
          id: 'pr-stack',
          status: 'pr_created',
          pr_url: 'https://github.com/org/repo/pull/42',
          pr_number: 42,
        })}
      />
    );
    const prLink = screen.getByTestId('pr-link-pr-stack');
    expect(prLink).toBeDefined();
    expect(prLink.textContent).toContain('PR #42');
    expect(prLink.getAttribute('href')).toBe('https://github.com/org/repo/pull/42');
  });

  it('does not show PR link for non-pr_created stacks', () => {
    render(
      <StackCard stack={makeStack({ id: 'no-pr', status: 'pushed' })} />
    );
    expect(screen.queryByTestId('pr-link-no-pr')).toBeNull();
  });

  it('shows service health dots', () => {
    render(
      <StackCard
        stack={makeStack({
          services: [
            { name: 'app', status: 'running', containerId: 'c1' },
            { name: 'db', status: 'running', containerId: 'c2' },
            { name: 'worker', status: 'exited', containerId: 'c3' },
          ],
        })}
      />
    );
    expect(screen.getByText('2/3 up')).toBeDefined();
  });

  it('shows model label when current_model is set', () => {
    render(
      <StackCard stack={makeStack({ id: 'model-stack', current_model: 'sonnet' })} />
    );
    expect(screen.getByTestId('stack-model-model-stack').textContent).toBe('Sonnet');
  });

  it('shows Opus when model is opus', () => {
    render(
      <StackCard stack={makeStack({ id: 'opus-stack', current_model: 'opus' })} />
    );
    expect(screen.getByTestId('stack-model-opus-stack').textContent).toBe('Opus');
  });

  it('does not show model label when current_model is null', () => {
    render(<StackCard stack={makeStack({ id: 'no-model', current_model: null })} />);
    expect(screen.queryByTestId('stack-model-no-model')).toBeNull();
  });

  it('shows Resume button only for session_paused stacks', () => {
    const { unmount } = render(
      <StackCard stack={makeStack({ id: 'paused', status: 'session_paused' })} />
    );
    expect(screen.getByTestId('card-resume-paused')).toBeDefined();
    unmount();

    render(<StackCard stack={makeStack({ id: 'running', status: 'running' })} />);
    expect(screen.queryByTestId('card-resume-running')).toBeNull();
  });

  it('calls resumeStackWithContinuation with manual=true when Resume button is clicked', () => {
    const resumeFn = vi.fn().mockResolvedValue({ halted: false, outcome: 'resuming_with_session' });
    useAppStore.setState({ resumeStackWithContinuation: resumeFn } as any);

    render(<StackCard stack={makeStack({ id: 'paused2', status: 'session_paused' })} />);
    fireEvent.click(screen.getByTestId('card-resume-paused2'));

    expect(resumeFn).toHaveBeenCalledWith('paused2', true);
  });

  it('shows Resume button for completed stacks when latest_task_token_limited is true', () => {
    render(
      <StackCard
        stack={makeStack({ id: 'token-limited', status: 'completed', latest_task_token_limited: true })}
      />
    );
    expect(screen.getByTestId('card-resume-completed-token-limited')).toBeDefined();
  });

  it('does not show Resume button for completed stacks when latest_task_token_limited is false', () => {
    render(
      <StackCard
        stack={makeStack({ id: 'normal-complete', status: 'completed', latest_task_token_limited: false })}
      />
    );
    expect(screen.queryByTestId('card-resume-completed-normal-complete')).toBeNull();
  });

  it('does not show Resume button for non-completed stacks even when latest_task_token_limited is true', () => {
    render(
      <StackCard
        stack={makeStack({ id: 'running-tl', status: 'running', latest_task_token_limited: true })}
      />
    );
    expect(screen.queryByTestId('card-resume-completed-running-tl')).toBeNull();
  });

  it('calls recheckCompletedStack when completed Resume button is clicked', async () => {
    const recheckFn = vi.fn().mockResolvedValue({ outcome: 'resuming_with_session' });
    useAppStore.setState({ recheckCompletedStack: recheckFn } as any);

    render(
      <StackCard
        stack={makeStack({ id: 'recheck-click', status: 'completed', latest_task_token_limited: true })}
      />
    );
    fireEvent.click(screen.getByTestId('card-resume-completed-recheck-click'));

    expect(recheckFn).toHaveBeenCalledWith('recheck-click');
  });

  it('shows not_token_limited feedback message when outcome is not_token_limited', async () => {
    const recheckFn = vi.fn().mockResolvedValue({ outcome: 'not_token_limited' });
    useAppStore.setState({ recheckCompletedStack: recheckFn } as any);

    render(
      <StackCard
        stack={makeStack({ id: 'ntl-msg', status: 'completed', latest_task_token_limited: true })}
      />
    );
    fireEvent.click(screen.getByTestId('card-resume-completed-ntl-msg'));

    await waitFor(() => {
      expect(screen.getByText('No interrupted work found — stack completed normally.')).toBeDefined();
    });
  });

  it('shows container_gone feedback message when outcome is container_gone', async () => {
    const recheckFn = vi.fn().mockResolvedValue({ outcome: 'container_gone' });
    useAppStore.setState({ recheckCompletedStack: recheckFn } as any);

    render(
      <StackCard
        stack={makeStack({ id: 'gone-msg', status: 'completed', latest_task_token_limited: true })}
      />
    );
    fireEvent.click(screen.getByTestId('card-resume-completed-gone-msg'));

    await waitFor(() => {
      expect(screen.getByText('Container not running — cannot verify log.')).toBeDefined();
    });
  });

  it('shows persistent Resolve Failure callout for failed stacks without hover', () => {
    render(<StackCard stack={makeStack({ id: 'fail-callout', status: 'failed' })} />);
    expect(screen.getByTestId('card-resolve-failure-fail-callout')).toBeDefined();
  });

  it('does not show persistent Resolve Failure callout for non-failed stacks', () => {
    const { unmount } = render(<StackCard stack={makeStack({ id: 'up-callout', status: 'up' })} />);
    expect(screen.queryByTestId('card-resolve-failure-up-callout')).toBeNull();
    unmount();
    render(<StackCard stack={makeStack({ id: 'running-callout', status: 'running' })} />);
    expect(screen.queryByTestId('card-resolve-failure-running-callout')).toBeNull();
  });

  it('shows Resolve Failure button only for failed stacks', () => {
    const { unmount } = render(
      <StackCard stack={makeStack({ id: 'resolve-failed', status: 'failed' })} />
    );
    expect(screen.getByTestId('resolve-failure-btn')).toBeDefined();
    unmount();

    render(<StackCard stack={makeStack({ id: 'resolve-up', status: 'up' })} />);
    expect(screen.queryByTestId('resolve-failure-btn')).toBeNull();
  });

  it('does not show Resolve Failure button for running stacks', () => {
    render(<StackCard stack={makeStack({ id: 'resolve-running', status: 'running' })} />);
    expect(screen.queryByTestId('resolve-failure-btn')).toBeNull();
  });

  it('opens ResolveFailureModal when Resolve Failure button is clicked', async () => {
    render(
      <StackCard stack={makeStack({ id: 'resolve-modal', status: 'failed' })} />
    );
    expect(screen.queryByTestId('resolve-failure-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('resolve-failure-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('resolve-failure-modal')).toBeDefined();
    });
  });
});
