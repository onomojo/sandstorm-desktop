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

  it('shows persistent Continue callout for failed stacks without hover', () => {
    render(<StackCard stack={makeStack({ id: 'fail-callout', status: 'failed' })} />);
    expect(screen.getByTestId('card-continue-fail-callout')).toBeDefined();
  });

  it('does not show Continue callout for non-failed stacks', () => {
    const { unmount } = render(<StackCard stack={makeStack({ id: 'up-callout', status: 'up' })} />);
    expect(screen.queryByTestId('card-continue-up-callout')).toBeNull();
    unmount();
    render(<StackCard stack={makeStack({ id: 'running-callout', status: 'running' })} />);
    expect(screen.queryByTestId('card-continue-running-callout')).toBeNull();
  });

  it('does not render ResolveFailureModal or hover-gated Resolve Failure button for failed stacks', () => {
    render(<StackCard stack={makeStack({ id: 'no-modal', status: 'failed' })} />);
    expect(screen.queryByTestId('resolve-failure-modal')).toBeNull();
    expect(screen.queryByTestId('resolve-failure-btn')).toBeNull();
  });

  it('Continue button is enabled and calls selfHealContinue directly when clicked', async () => {
    const api = mockSandstormApi();
    api.stacks.selfHealContinue.mockResolvedValue(undefined);

    render(<StackCard stack={makeStack({ id: 'continue-test', status: 'failed' })} />);

    const btn = screen.getByTestId('card-continue-continue-test') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);

    await waitFor(() => {
      expect(api.stacks.selfHealContinue).toHaveBeenCalledWith('continue-test');
    });
  });

  it('ticket-522 fixture: failed stack with selfheal_continue_used=0, session_id present renders enabled Continue button', () => {
    render(
      <StackCard
        stack={makeStack({
          id: 'ticket-522',
          status: 'failed',
          selfheal_continue_used: 0,
        })}
      />
    );
    const btn = screen.getByTestId('card-continue-ticket-522') as HTMLButtonElement;
    expect(btn).toBeDefined();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Continue');
  });

  it('Continue button does not call getFailureDiagnosis (regression: no LLM gate in click path)', async () => {
    const api = mockSandstormApi();
    api.stacks.selfHealContinue.mockResolvedValue(undefined);

    render(<StackCard stack={makeStack({ id: 'no-llm-gate', status: 'failed' })} />);
    fireEvent.click(screen.getByTestId('card-continue-no-llm-gate'));

    await waitFor(() => {
      expect(api.stacks.selfHealContinue).toHaveBeenCalledWith('no-llm-gate');
    });
    // getFailureDiagnosis must never be called — it no longer exists on the api mock
    expect('getFailureDiagnosis' in api.stacks).toBe(false);
  });
});
