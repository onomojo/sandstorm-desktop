/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Dashboard } from '../../../src/renderer/components/Dashboard';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('Dashboard', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    // Reset store
    useAppStore.setState({
      stacks: [],
      stackHistory: [],
      stackMetrics: {},
      projects: [],
      activeProjectId: null,
      selectedStackId: null,
      showNewStackDialog: false,
    });
  });

  it('renders empty state when no stacks', () => {
    render(<Dashboard />);
    expect(screen.getByText('No stacks yet')).toBeDefined();
    expect(screen.getByText('Create your first stack to get started')).toBeDefined();
  });

  it('shows "All Stacks" title when no project is selected', () => {
    render(<Dashboard />);
    expect(screen.getByText('All Stacks')).toBeDefined();
  });

  it('shows project name as title when a project is selected', () => {
    useAppStore.setState({
      projects: [{ id: 1, name: 'myproject', directory: '/my/project', added_at: '' }],
      activeProjectId: 1,
    });
    api.projects.checkInit.mockResolvedValue({ state: 'full' });

    render(<Dashboard />);
    expect(screen.getByText('myproject')).toBeDefined();
  });

  it('renders stack cards when stacks exist', () => {
    useAppStore.setState({
      stacks: [
        {
          id: 'stack-1',
          project: 'proj',
          project_dir: '/proj',
          ticket: 'EXP-1',
          branch: 'main',
          description: 'test',
          status: 'running',
          error: null,
          pr_url: null,
          pr_number: null,
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_execution_input_tokens: 0,
          total_execution_output_tokens: 0,
          total_review_input_tokens: 0,
          total_review_output_tokens: 0,
          rate_limit_reset_at: null,
          services: [],
        },
      ],
    });

    render(<Dashboard />);
    expect(screen.getByText('stack-1')).toBeDefined();
  });

  it('shows active count when stacks are running', () => {
    useAppStore.setState({
      stacks: [
        {
          id: 's1',
          project: 'p',
          project_dir: '/p',
          ticket: null,
          branch: null,
          description: null,
          status: 'running',
          error: null,
          pr_url: null,
          pr_number: null,
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_execution_input_tokens: 0,
          total_execution_output_tokens: 0,
          total_review_input_tokens: 0,
          total_review_output_tokens: 0,
          rate_limit_reset_at: null,
          services: [],
        },
        {
          id: 's2',
          project: 'p',
          project_dir: '/p',
          ticket: null,
          branch: null,
          description: null,
          status: 'up',
          error: null,
          pr_url: null,
          pr_number: null,
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_execution_input_tokens: 0,
          total_execution_output_tokens: 0,
          total_review_input_tokens: 0,
          total_review_output_tokens: 0,
          rate_limit_reset_at: null,
          services: [],
        },
      ],
    });

    render(<Dashboard />);
    expect(screen.getByText('2 active')).toBeDefined();
  });

  it('opens new stack dialog when button is clicked', () => {
    render(<Dashboard />);
    const btn = screen.getByTestId('new-stack-btn');
    fireEvent.click(btn);
    expect(useAppStore.getState().showNewStackDialog).toBe(true);
  });

  it('shows Active and History tabs', () => {
    render(<Dashboard />);
    expect(screen.getByTestId('tab-active')).toBeDefined();
    expect(screen.getByTestId('tab-history')).toBeDefined();
  });

  it('shows history records when History tab is clicked', () => {
    useAppStore.setState({
      stackHistory: [
        {
          id: 1,
          stack_id: 'old-stack',
          project: 'proj',
          project_dir: '/proj',
          ticket: null,
          branch: 'feat/old',
          description: 'Old work',
          final_status: 'completed' as const,
          error: null,
          runtime: 'docker' as const,
          task_prompt: 'Fix the bug',
          created_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_seconds: 300,
        },
      ],
    });

    render(<Dashboard />);
    fireEvent.click(screen.getByTestId('tab-history'));
    expect(screen.getByText('old-stack')).toBeDefined();
    expect(screen.getByText('Old work')).toBeDefined();
  });

  it('shows empty history state', () => {
    render(<Dashboard />);
    fireEvent.click(screen.getByTestId('tab-history'));
    expect(screen.getByText('No history yet')).toBeDefined();
  });

  it('shows workflow phases in history card for completed stack', () => {
    const completedTask = {
      id: 1, stack_id: 'old-stack', prompt: 'Fix bug', model: 'sonnet',
      resolved_model: null, status: 'completed', exit_code: 0,
      session_id: null, input_tokens: 5000, output_tokens: 2000,
      execution_input_tokens: 3000, execution_output_tokens: 1200,
      review_input_tokens: 2000, review_output_tokens: 800,
      review_iterations: 1, verify_retries: 0,
      review_verdicts: null, verify_outputs: null, execution_summary: null,
      execution_started_at: '2026-01-01T00:00:00Z',
      execution_finished_at: '2026-01-01T00:05:00Z',
      review_started_at: '2026-01-01T00:05:00Z',
      review_finished_at: '2026-01-01T00:07:00Z',
      verify_started_at: '2026-01-01T00:07:00Z',
      verify_finished_at: '2026-01-01T00:08:00Z',
      started_at: '2026-01-01T00:00:00Z',
      finished_at: '2026-01-01T00:08:00Z',
    };

    useAppStore.setState({
      stackHistory: [
        {
          id: 1, stack_id: 'old-stack', project: 'proj', project_dir: '/proj',
          ticket: null, branch: null, description: null,
          final_status: 'completed' as const, error: null,
          runtime: 'docker' as const, task_prompt: 'Fix bug',
          task_history: JSON.stringify([completedTask]),
          created_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_seconds: 480,
        },
      ],
    });

    render(<Dashboard />);
    fireEvent.click(screen.getByTestId('tab-history'));
    expect(screen.getByTestId('history-workflow-phases')).toBeDefined();
    // All three phases should have checkmarks for completed task
    const phasesEl = screen.getByTestId('history-workflow-phases');
    expect(phasesEl.textContent).toContain('Exec');
    expect(phasesEl.textContent).toContain('Review');
    expect(phasesEl.textContent).toContain('Verify');
    expect(phasesEl.textContent).toContain('\u2713');
  });

  it('shows failed phase in history card for failed stack', () => {
    const failedTask = {
      id: 1, stack_id: 'fail-stack', prompt: 'Fix bug', model: 'sonnet',
      resolved_model: null, status: 'failed', exit_code: 1,
      session_id: null, input_tokens: 5000, output_tokens: 2000,
      execution_input_tokens: 3000, execution_output_tokens: 1200,
      review_input_tokens: 2000, review_output_tokens: 800,
      review_iterations: 1, verify_retries: 0,
      review_verdicts: null, verify_outputs: null, execution_summary: null,
      execution_started_at: '2026-01-01T00:00:00Z',
      execution_finished_at: '2026-01-01T00:05:00Z',
      review_started_at: '2026-01-01T00:05:00Z',
      review_finished_at: '2026-01-01T00:07:00Z',
      verify_started_at: '2026-01-01T00:07:00Z',
      verify_finished_at: null,
      started_at: '2026-01-01T00:00:00Z',
      finished_at: '2026-01-01T00:08:00Z',
    };

    useAppStore.setState({
      stackHistory: [
        {
          id: 1, stack_id: 'fail-stack', project: 'proj', project_dir: '/proj',
          ticket: null, branch: null, description: null,
          final_status: 'failed' as const, error: 'verify failed',
          runtime: 'docker' as const, task_prompt: 'Fix bug',
          task_history: JSON.stringify([failedTask]),
          created_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_seconds: 480,
        },
      ],
    });

    render(<Dashboard />);
    fireEvent.click(screen.getByTestId('tab-history'));
    const phasesEl = screen.getByTestId('history-workflow-phases');
    // Verify phase should show X mark for failed
    expect(phasesEl.textContent).toContain('\u2717');
  });

  it('shows stopped count when stacks are stopped', () => {
    useAppStore.setState({
      stacks: [
        {
          id: 's1',
          project: 'p',
          project_dir: '/p',
          ticket: null, branch: null, description: null,
          status: 'stopped',
          error: null,
          pr_url: null,
          pr_number: null,
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_execution_input_tokens: 0,
          total_execution_output_tokens: 0,
          total_review_input_tokens: 0,
          total_review_output_tokens: 0,
          rate_limit_reset_at: null,
          services: [],
        },
        {
          id: 's2',
          project: 'p',
          project_dir: '/p',
          ticket: null, branch: null, description: null,
          status: 'up',
          error: null,
          pr_url: null,
          pr_number: null,
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_execution_input_tokens: 0,
          total_execution_output_tokens: 0,
          total_review_input_tokens: 0,
          total_review_output_tokens: 0,
          rate_limit_reset_at: null,
          services: [],
        },
      ],
    });

    render(<Dashboard />);
    // Only active (running/up) count is displayed in the UI
    expect(screen.getByText('1 active')).toBeDefined();
  });

  it('cleans up body styles when unmounting mid-drag (fixes #28)', () => {
    const { container, unmount } = render(<Dashboard />);

    // Find the drag divider (the element with cursor-col-resize class)
    const divider = container.querySelector('.cursor-col-resize');
    expect(divider).not.toBeNull();

    // Start a drag via mousedown on the divider
    fireEvent.mouseDown(divider!);

    // Body styles should now be set by the drag handler
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    // Unmount the component WITHOUT mouseup (simulates navigating to StackDetail mid-drag)
    unmount();

    // Body styles should be cleaned up by the effect cleanup
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  describe('New Stack block at >=250K orchestrator tokens (issue #238)', () => {
    it('opens the New Stack dialog normally when under 250K', () => {
      useAppStore.setState({
        outerClaudeTokens: {
          all: { input_tokens: 100_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });

      render(<Dashboard />);
      fireEvent.click(screen.getByTestId('new-stack-btn'));

      expect(useAppStore.getState().showNewStackDialog).toBe(true);
      expect(screen.queryByTestId('orchestrator-over-limit-modal')).toBeNull();
    });

    it('blocks the New Stack dialog and shows the over-limit modal at exactly 250K', () => {
      useAppStore.setState({
        outerClaudeTokens: {
          all: { input_tokens: 250_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });

      render(<Dashboard />);
      fireEvent.click(screen.getByTestId('new-stack-btn'));

      expect(useAppStore.getState().showNewStackDialog).toBe(false);
      expect(screen.getByTestId('orchestrator-over-limit-modal')).toBeDefined();
    });

    it('keeps block in place after dismissing the modal (dismiss does NOT unblock)', () => {
      useAppStore.setState({
        outerClaudeTokens: {
          all: { input_tokens: 300_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });

      render(<Dashboard />);
      fireEvent.click(screen.getByTestId('new-stack-btn'));
      expect(screen.getByTestId('orchestrator-over-limit-modal')).toBeDefined();

      fireEvent.click(screen.getByTestId('orchestrator-over-limit-dismiss'));
      expect(screen.queryByTestId('orchestrator-over-limit-modal')).toBeNull();
      // Stack dialog is still blocked after dismiss
      expect(useAppStore.getState().showNewStackDialog).toBe(false);

      // And trying again still blocks
      fireEvent.click(screen.getByTestId('new-stack-btn'));
      expect(screen.getByTestId('orchestrator-over-limit-modal')).toBeDefined();
      expect(useAppStore.getState().showNewStackDialog).toBe(false);
    });

    it('reads tokens for the active project tab (not the "all" tab) when a project is selected', () => {
      api.projects.checkInit.mockResolvedValue({ state: 'full' });
      useAppStore.setState({
        projects: [{ id: 7, name: 'proj', directory: '/p', added_at: '' }],
        activeProjectId: 7,
        outerClaudeTokens: {
          'project-7': { input_tokens: 250_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          // "all" tab is well under the limit — it must NOT leak into a project view.
          all: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });

      render(<Dashboard />);
      fireEvent.click(screen.getByTestId('new-stack-btn'));
      expect(screen.getByTestId('orchestrator-over-limit-modal')).toBeDefined();
      expect(useAppStore.getState().showNewStackDialog).toBe(false);
    });
  });

  it('filters stacks by active project', () => {
    useAppStore.setState({
      projects: [
        { id: 1, name: 'proj-a', directory: '/a', added_at: '' },
        { id: 2, name: 'proj-b', directory: '/b', added_at: '' },
      ],
      activeProjectId: 1,
      stacks: [
        {
          id: 'a-stack',
          project: 'proj-a',
          project_dir: '/a',
          ticket: null, branch: null, description: null,
          status: 'up',
          error: null,
          pr_url: null,
          pr_number: null,
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_execution_input_tokens: 0,
          total_execution_output_tokens: 0,
          total_review_input_tokens: 0,
          total_review_output_tokens: 0,
          rate_limit_reset_at: null,
          services: [],
        },
        {
          id: 'b-stack',
          project: 'proj-b',
          project_dir: '/b',
          ticket: null, branch: null, description: null,
          status: 'up',
          error: null,
          pr_url: null,
          pr_number: null,
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_execution_input_tokens: 0,
          total_execution_output_tokens: 0,
          total_review_input_tokens: 0,
          total_review_output_tokens: 0,
          rate_limit_reset_at: null,
          services: [],
        },
      ],
    });
    api.projects.checkInit.mockResolvedValue({ state: 'full' });

    render(<Dashboard />);
    // Only a-stack should be visible since we filtered by project /a
    expect(screen.getByText('a-stack')).toBeDefined();
    expect(screen.queryByText('b-stack')).toBeNull();
  });
});
