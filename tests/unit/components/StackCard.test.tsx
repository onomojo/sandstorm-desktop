/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
