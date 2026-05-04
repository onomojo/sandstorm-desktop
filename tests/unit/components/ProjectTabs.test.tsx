/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectTabs } from '../../../src/renderer/components/ProjectTabs';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('ProjectTabs', () => {
  beforeEach(() => {
    mockSandstormApi();
    useAppStore.setState({
      projects: [],
      activeProjectId: null,
      showOpenProjectDialog: false,
    });
  });

  it('always shows the All tab', () => {
    render(<ProjectTabs />);
    expect(screen.getByText('All')).toBeDefined();
  });

  it('renders project tabs', () => {
    useAppStore.setState({
      projects: [
        { id: 1, name: 'project-a', directory: '/a', added_at: '' },
        { id: 2, name: 'project-b', directory: '/b', added_at: '' },
      ],
    });

    render(<ProjectTabs />);
    expect(screen.getByText('project-a')).toBeDefined();
    expect(screen.getByText('project-b')).toBeDefined();
  });

  it('switches active project when tab is clicked', () => {
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
    });

    render(<ProjectTabs />);
    fireEvent.click(screen.getByText('proj'));
    expect(useAppStore.getState().activeProjectId).toBe(1);
  });

  it('switches to All when All tab is clicked', () => {
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
    });

    render(<ProjectTabs />);
    fireEvent.click(screen.getByText('All'));
    expect(useAppStore.getState().activeProjectId).toBeNull();
  });

  it('opens the add project dialog when + is clicked', () => {
    render(<ProjectTabs />);
    const addBtn = screen.getByTitle('Open project');
    fireEvent.click(addBtn);
    expect(useAppStore.getState().showOpenProjectDialog).toBe(true);
  });

  it('shows close button for each project tab', () => {
    useAppStore.setState({
      projects: [
        { id: 1, name: 'project-a', directory: '/a', added_at: '' },
        { id: 2, name: 'project-b', directory: '/b', added_at: '' },
      ],
    });

    render(<ProjectTabs />);
    expect(screen.getByLabelText('Close project-a')).toBeDefined();
    expect(screen.getByLabelText('Close project-b')).toBeDefined();
  });

  it('shows confirmation dialog when close button is clicked', () => {
    useAppStore.setState({
      projects: [{ id: 1, name: 'my-project', directory: '/proj', added_at: '' }],
    });

    render(<ProjectTabs />);
    fireEvent.click(screen.getByLabelText('Close my-project'));

    expect(screen.getByText(/Close project "my-project"\?/)).toBeDefined();
    expect(screen.getByText(/won't affect running stacks/)).toBeDefined();
    expect(screen.getByText('Cancel')).toBeDefined();
    expect(screen.getByText('Close Project')).toBeDefined();
  });

  it('dismisses confirmation dialog when Cancel is clicked', () => {
    useAppStore.setState({
      projects: [{ id: 1, name: 'my-project', directory: '/proj', added_at: '' }],
    });

    render(<ProjectTabs />);
    fireEvent.click(screen.getByLabelText('Close my-project'));
    expect(screen.getByText(/Close project "my-project"\?/)).toBeDefined();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText(/Close project "my-project"\?/)).toBeNull();
  });

  it('removes project and switches to All tab when confirming close of active project', async () => {
    const api = mockSandstormApi();
    api.projects.list.mockResolvedValue([]);
    api.projects.remove.mockResolvedValue(undefined);

    useAppStore.setState({
      projects: [{ id: 1, name: 'my-project', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
    });

    render(<ProjectTabs />);
    fireEvent.click(screen.getByLabelText('Close my-project'));
    fireEvent.click(screen.getByText('Close Project'));

    await waitFor(() => {
      expect(api.projects.remove).toHaveBeenCalledWith(1);
    });
    await waitFor(() => {
      expect(useAppStore.getState().activeProjectId).toBeNull();
    });
  });

  it('removes project without changing active tab when closing non-active project', async () => {
    const api = mockSandstormApi();
    api.projects.list.mockResolvedValue([
      { id: 1, name: 'project-a', directory: '/a', added_at: '' },
    ]);
    api.projects.remove.mockResolvedValue(undefined);

    useAppStore.setState({
      projects: [
        { id: 1, name: 'project-a', directory: '/a', added_at: '' },
        { id: 2, name: 'project-b', directory: '/b', added_at: '' },
      ],
      activeProjectId: 1,
    });

    render(<ProjectTabs />);
    fireEvent.click(screen.getByLabelText('Close project-b'));
    fireEvent.click(screen.getByText('Close Project'));

    await waitFor(() => {
      expect(api.projects.remove).toHaveBeenCalledWith(2);
    });
    await waitFor(() => {
      expect(useAppStore.getState().activeProjectId).toBe(1);
    });
  });

  it('dismisses confirmation dialog when clicking overlay backdrop', () => {
    useAppStore.setState({
      projects: [{ id: 1, name: 'my-project', directory: '/proj', added_at: '' }],
    });

    render(<ProjectTabs />);
    fireEvent.click(screen.getByLabelText('Close my-project'));
    expect(screen.getByText(/Close project "my-project"\?/)).toBeDefined();

    // Click the backdrop overlay (the fixed div)
    const backdrop = screen.getByText(/Close project "my-project"\?/).closest('.bg-sandstorm-surface')!.parentElement!;
    fireEvent.click(backdrop);
    expect(screen.queryByText(/Close project "my-project"\?/)).toBeNull();
  });

  it('shows badge on non-active project tab when it has in-flight refinements', () => {
    useAppStore.setState({
      projects: [
        { id: 1, name: 'project-a', directory: '/a', added_at: '' },
        { id: 2, name: 'project-b', directory: '/b', added_at: '' },
      ],
      activeProjectId: 1,
      refinementSessions: [
        { id: 's1', ticketId: '1', projectDir: '/b', status: 'running', phase: 'check', startedAt: Date.now() },
        { id: 's2', ticketId: '2', projectDir: '/b', status: 'ready', phase: 'check', startedAt: Date.now() },
      ],
    });

    render(<ProjectTabs />);
    // project-b is not active and has 2 sessions → should show badge with count 2
    expect(screen.getByTestId('refinement-badge-2').textContent).toBe('2');
    // project-a is active → no badge
    expect(screen.queryByTestId('refinement-badge-1')).toBeNull();
  });

  it('hides badge on project tab when that project becomes active', () => {
    useAppStore.setState({
      projects: [
        { id: 1, name: 'project-a', directory: '/a', added_at: '' },
        { id: 2, name: 'project-b', directory: '/b', added_at: '' },
      ],
      activeProjectId: 2,
      refinementSessions: [
        { id: 's1', ticketId: '1', projectDir: '/b', status: 'running', phase: 'check', startedAt: Date.now() },
      ],
    });

    render(<ProjectTabs />);
    // project-b is active → no badge even though it has sessions
    expect(screen.queryByTestId('refinement-badge-2')).toBeNull();
    // project-a is not active but has no sessions → no badge
    expect(screen.queryByTestId('refinement-badge-1')).toBeNull();
  });
});
