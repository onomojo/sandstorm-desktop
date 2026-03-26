/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StackDetail } from '../../../src/renderer/components/StackDetail';
import { useAppStore, Stack } from '../../../src/renderer/store';
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

  it('renders model selector buttons for dispatch', () => {
    render(<StackDetail stackId="detail-stack" onBack={onBack} />);
    expect(screen.getByTestId('dispatch-model-sonnet')).toBeDefined();
    expect(screen.getByTestId('dispatch-model-opus')).toBeDefined();
  });

  it('shows model badge in task history', async () => {
    api.tasks.list.mockResolvedValue([
      {
        id: 1,
        stack_id: 'detail-stack',
        prompt: 'Complex refactor',
        model: 'opus',
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
});
