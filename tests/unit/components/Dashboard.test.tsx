/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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
      projects: [],
      activeProjectId: null,
      selectedStackId: null,
      showNewStackDialog: false,
    });
  });

  it('renders empty state when no stacks', () => {
    render(<Dashboard />);
    expect(screen.getByText('No active stacks')).toBeDefined();
    expect(screen.getByText('Create a new stack to get started')).toBeDefined();
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
    api.projects.checkInit.mockResolvedValue(true);

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
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
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
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
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
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
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
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          services: [],
        },
        {
          id: 's2',
          project: 'p',
          project_dir: '/p',
          ticket: null, branch: null, description: null,
          status: 'up',
          error: null,
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          services: [],
        },
      ],
    });

    render(<Dashboard />);
    expect(screen.getByText('1 stopped')).toBeDefined();
    expect(screen.getByText('1 active')).toBeDefined();
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
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          services: [],
        },
        {
          id: 'b-stack',
          project: 'proj-b',
          project_dir: '/b',
          ticket: null, branch: null, description: null,
          status: 'up',
          runtime: 'docker' as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          services: [],
        },
      ],
    });
    api.projects.checkInit.mockResolvedValue(true);

    render(<Dashboard />);
    // Only a-stack should be visible since we filtered by project /a
    expect(screen.getByText('a-stack')).toBeDefined();
    expect(screen.queryByText('b-stack')).toBeNull();
  });
});
