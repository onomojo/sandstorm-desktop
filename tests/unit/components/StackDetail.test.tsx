/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StackDetail } from '../../../src/renderer/components/StackDetail';
import { useAppStore, Stack, WorkflowProgress } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeStack(overrides: Partial<Stack> = {}): Stack {
  return {
    id: 'detail-stack',
    project: 'proj',
    project_dir: '/proj',
    ticket: 'TICKET-1',
    branch: 'feature/x',
    description: 'A test stack',
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
    services: [
      { name: 'claude', status: 'running', containerId: 'c1' },
      { name: 'app', status: 'running', containerId: 'c2' },
    ],
    ...overrides,
  };
}

describe('StackDetail', () => {
  let api: ReturnType<typeof mockSandstormApi>;
  const onBack = vi.fn();

  beforeEach(() => {
    api = mockSandstormApi();
    onBack.mockReset();
    useAppStore.setState({
      stacks: [makeStack()],
      selectedStackId: 'detail-stack',
    });
  });

  it('renders stack header with name and status', () => {
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    expect(screen.getByText('detail-stack')).toBeDefined();
    expect(screen.getByText('Up')).toBeDefined();
  });

  it('shows ticket and branch', () => {
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    expect(screen.getByText('TICKET-1')).toBeDefined();
    expect(screen.getByText('feature/x')).toBeDefined();
  });

  it('renders tab navigation', () => {
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    expect(screen.getByText('Claude Output')).toBeDefined();
    expect(screen.getByText('Diff')).toBeDefined();
    // "Logs" appears in both service list and tabs, so use getAllByText
    expect(screen.getAllByText('Logs').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('History')).toBeDefined();
  });

  it('shows "Stack not found" for missing stack', () => {
    useAppStore.setState({ stacks: [] });
    render(<StackDetail stackId="nonexistent" onBack={onBack} />);
    expect(screen.getByText('Stack not found')).toBeDefined();
  });

  it('calls onBack when back button is clicked', () => {
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    // Click the back button (first button with the chevron SVG)
    const backButtons = screen.getAllByRole('button');
    fireEvent.click(backButtons[0]);
    expect(onBack).toHaveBeenCalled();
  });

  it('shows "Needs Review" for completed status', () => {
    useAppStore.setState({
      stacks: [makeStack({ status: 'completed' })],
    });
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    expect(screen.getByText('Needs Review')).toBeDefined();
  });

  it('shows error message for failed stack', () => {
    useAppStore.setState({
      stacks: [makeStack({ status: 'failed', error: 'container exited with code 1' })],
    });
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    expect(screen.getByText('container exited with code 1')).toBeDefined();
  });

  it('does not show error for non-failed stack', () => {
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    expect(screen.queryByText(/container exited/)).toBeNull();
  });

  it('has a dispatch textarea and button', () => {
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    expect(screen.getByPlaceholderText(/Describe a task/)).toBeDefined();
    expect(screen.getByText('Dispatch')).toBeDefined();
  });

  it('dispatch button is disabled when textarea is empty', () => {
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    const dispatchBtn = screen.getByText('Dispatch');
    expect(dispatchBtn.hasAttribute('disabled')).toBe(true);
  });

  it('renders model selector buttons for dispatch with sonnet default', () => {
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    expect(screen.getByTestId('dispatch-model-auto')).toBeDefined();
    expect(screen.getByTestId('dispatch-model-sonnet')).toBeDefined();
    expect(screen.getByTestId('dispatch-model-opus')).toBeDefined();
    // Sonnet should be selected by default
    const sonnetBtn = screen.getByTestId('dispatch-model-sonnet');
    expect(sonnetBtn.className).toContain('border-sandstorm-accent');
  });

  it('shows model badge in task history', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Complex refactor',
        model: 'opus',
        resolved_model: null,
        status: 'completed',
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
    ]);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('opus')).toBeDefined();
    });
  });

  it('shows loop iteration counts for completed tasks in History tab', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Add feature',
        model: null,
        status: 'completed',
        exit_code: 0,
        review_iterations: 3,
        verify_retries: 1,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
    ]);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('3 reviews, 1 retry')).toBeDefined();
    });
  });

  it('does not show loop iterations when both are zero', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Simple task',
        model: null,
        status: 'completed',
        exit_code: 0,
        review_iterations: 0,
        verify_retries: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
    ]);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('Simple task')).toBeDefined();
    });
    expect(screen.queryByText(/review/)).toBeNull();
  });

  it('pluralizes loop iteration labels correctly', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Single iteration task',
        model: null,
        status: 'completed',
        exit_code: 0,
        review_iterations: 1,
        verify_retries: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
    ]);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('1 review, 0 retries')).toBeDefined();
    });
  });

  it('shows "auto → model" badge when resolved_model is set with auto selection', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Auto task',
        model: null,
        resolved_model: 'claude-sonnet-4-20250514',
        status: 'completed',
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
    ]);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('auto \u2192 claude-sonnet-4-20250514')).toBeDefined();
    });
  });

  it('shows resolved_model directly when explicit model was selected', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Explicit model task',
        model: 'opus',
        resolved_model: 'claude-opus-4-20250514',
        status: 'completed',
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
    ]);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('claude-opus-4-20250514')).toBeDefined();
    });
  });

  it('shows task history in the History tab', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Fix the login page',
        status: 'completed',
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
    ]);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByText('Fix the login page')).toBeDefined();
    });
  });

  it('shows token breakdown toggle for tasks with tokens', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Add feature',
        model: 'sonnet',
        resolved_model: null,
        status: 'completed',
        exit_code: 0,
        session_id: null,
        input_tokens: 5000,
        output_tokens: 2000,
        execution_input_tokens: 3000,
        execution_output_tokens: 1200,
        review_input_tokens: 2000,
        review_output_tokens: 800,
        review_iterations: 1,
        verify_retries: 0,
        review_verdicts: null,
        verify_outputs: null,
        execution_summary: null,
        execution_started_at: null,
        execution_finished_at: null,
        review_started_at: null,
        review_finished_at: null,
        verify_started_at: null,
        verify_finished_at: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
    ]);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      const toggle = screen.getByTestId('token-breakdown-toggle');
      expect(toggle).toBeDefined();
      expect(toggle.textContent).toContain('7.0k tokens');
    });
  });

  it('expands token breakdown with per-iteration data', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Add feature',
        model: 'sonnet',
        resolved_model: null,
        status: 'completed',
        exit_code: 0,
        session_id: null,
        input_tokens: 5000,
        output_tokens: 2000,
        execution_input_tokens: 3000,
        execution_output_tokens: 1200,
        review_input_tokens: 2000,
        review_output_tokens: 800,
        review_iterations: 1,
        verify_retries: 0,
        review_verdicts: null,
        verify_outputs: null,
        execution_summary: null,
        execution_started_at: null,
        execution_finished_at: null,
        review_started_at: null,
        review_finished_at: null,
        verify_started_at: null,
        verify_finished_at: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
    ]);
    api.tasks.tokenSteps.mockResolvedValue([
      { id: 1, task_id: 1, iteration: 1, phase: 'execution', input_tokens: 3000, output_tokens: 1200 },
      { id: 2, task_id: 1, iteration: 1, phase: 'review', input_tokens: 2000, output_tokens: 800 },
    ]);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByTestId('token-breakdown-toggle')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('token-breakdown-toggle'));

    await waitFor(() => {
      const detail = screen.getByTestId('token-breakdown-detail');
      expect(detail).toBeDefined();
      expect(detail.textContent).toContain('Iteration 1');
      expect(detail.textContent).toContain('Execution');
      expect(detail.textContent).toContain('Review');
    });
  });

  it('shows workflow progress panel for running stack with progress data', async () => {
    const progressData: WorkflowProgress = {
      stackId: 'detail-stack',
      currentPhase: 'review',
      outerIteration: 1,
      innerIteration: 2,
      phases: [
        { phase: 'execution', status: 'passed' },
        { phase: 'review', status: 'running' },
        { phase: 'verify', status: 'pending' },
      ],
      steps: [
        { phase: 'execution', iteration: 1, input_tokens: 5000, output_tokens: 2000, live: false },
        { phase: 'review', iteration: 1, input_tokens: 3000, output_tokens: 1000, live: true },
      ],
      taskPrompt: 'Fix the login bug',
      startedAt: new Date().toISOString(),
      model: 'sonnet',
    };

    useAppStore.setState({
      stacks: [makeStack({ status: 'running' })],
    });
    api.tasks.workflowProgress.mockResolvedValue(progressData);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);

    await waitFor(() => {
      expect(screen.getByTestId('workflow-progress-panel')).toBeDefined();
    });
    expect(screen.getByTestId('outer-loop-counter').textContent).toBe('1 of 5');
    expect(screen.getByTestId('inner-loop-counter').textContent).toBe('2 of 5');
  });

  it('does not show workflow panel when stack is not running', () => {
    useAppStore.setState({
      stacks: [makeStack({ status: 'completed' })],
    });
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    expect(screen.queryByTestId('workflow-progress-panel')).toBeNull();
  });

  it('does not show workflow panel when no progress data available', async () => {
    useAppStore.setState({
      stacks: [makeStack({ status: 'running' })],
    });
    api.tasks.workflowProgress.mockResolvedValue(null);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);

    // Wait for async call to settle
    await waitFor(() => {
      expect(api.tasks.workflowProgress).toHaveBeenCalledWith('detail-stack');
    });
    expect(screen.queryByTestId('workflow-progress-panel')).toBeNull();
  });

  it('shows aggregate fallback when no per-step data exists', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Old task',
        model: 'sonnet',
        resolved_model: null,
        status: 'completed',
        exit_code: 0,
        session_id: null,
        input_tokens: 5000,
        output_tokens: 2000,
        execution_input_tokens: 3000,
        execution_output_tokens: 1200,
        review_input_tokens: 2000,
        review_output_tokens: 800,
        review_iterations: 1,
        verify_retries: 0,
        review_verdicts: null,
        verify_outputs: null,
        execution_summary: null,
        execution_started_at: null,
        execution_finished_at: null,
        review_started_at: null,
        review_finished_at: null,
        verify_started_at: null,
        verify_finished_at: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      },
    ]);
    // No per-step data — returns empty
    api.tasks.tokenSteps.mockResolvedValue([]);

    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    fireEvent.click(screen.getByText('History'));

    await waitFor(() => {
      expect(screen.getByTestId('token-breakdown-toggle')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('token-breakdown-toggle'));

    await waitFor(() => {
      const detail = screen.getByTestId('token-breakdown-detail');
      expect(detail).toBeDefined();
      // Shows aggregate phase breakdown
      expect(detail.textContent).toContain('Execution');
      expect(detail.textContent).toContain('Review');
      expect(detail.textContent).toContain('Total');
    });
  });
});
