/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { StaleWorkspaces } from '../../../src/renderer/components/StaleWorkspaces';
import { useAppStore, StaleWorkspace } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeStaleWorkspace(overrides: Partial<StaleWorkspace> = {}): StaleWorkspace {
  return {
    stackId: 'stale-stack',
    project: 'test-project',
    projectDir: '/test/project',
    workspacePath: '/test/project/.sandstorm/workspaces/stale-stack',
    sizeBytes: 1024 * 1024 * 100, // 100 MB
    hasUnpushedChanges: false,
    reason: 'orphaned',
    lastModified: new Date().toISOString(),
    ...overrides,
  };
}

describe('StaleWorkspaces', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      staleWorkspaces: [],
      staleWorkspacesLoading: false,
    });
  });

  it('renders nothing when there are no stale workspaces', async () => {
    api.stacks.detectStale.mockResolvedValue([]);
    const { container } = render(<StaleWorkspaces />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="stale-workspaces"]')).toBeNull();
    });
  });

  it('renders stale workspaces when detected', async () => {
    const staleWs = makeStaleWorkspace();
    api.stacks.detectStale.mockResolvedValue([staleWs]);

    // Pre-set state to avoid waiting for async
    useAppStore.setState({ staleWorkspaces: [staleWs] });

    render(<StaleWorkspaces />);

    expect(screen.getByTestId('stale-workspaces')).toBeDefined();
    expect(screen.getByText('1 Stale Workspace')).toBeDefined();
    expect(screen.getByText('stale-stack')).toBeDefined();
    expect(screen.getByText('orphaned')).toBeDefined();
  });

  it('shows plural label for multiple stale workspaces', () => {
    const workspaces = [
      makeStaleWorkspace({ stackId: 'stack-1', workspacePath: '/ws/1' }),
      makeStaleWorkspace({ stackId: 'stack-2', workspacePath: '/ws/2' }),
    ];
    useAppStore.setState({ staleWorkspaces: workspaces });

    render(<StaleWorkspaces />);
    expect(screen.getByText('2 Stale Workspaces')).toBeDefined();
  });

  it('shows unpushed changes warning badge', () => {
    const ws = makeStaleWorkspace({ hasUnpushedChanges: true });
    useAppStore.setState({ staleWorkspaces: [ws] });

    render(<StaleWorkspaces />);
    expect(screen.getByText('Unpushed changes')).toBeDefined();
  });

  it('shows completed reason badge', () => {
    const ws = makeStaleWorkspace({ reason: 'completed' });
    useAppStore.setState({ staleWorkspaces: [ws] });

    render(<StaleWorkspaces />);
    expect(screen.getByText('completed')).toBeDefined();
  });

  it('disables cleanup button when nothing is selected', () => {
    useAppStore.setState({ staleWorkspaces: [makeStaleWorkspace()] });

    render(<StaleWorkspaces />);
    const btn = screen.getByTestId('stale-cleanup-btn');
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('enables cleanup button when workspaces are selected', () => {
    useAppStore.setState({ staleWorkspaces: [makeStaleWorkspace()] });

    render(<StaleWorkspaces />);

    // Click the row to select it
    const row = screen.getByTestId('stale-workspace-row');
    fireEvent.click(row);

    const btn = screen.getByTestId('stale-cleanup-btn');
    expect(btn.hasAttribute('disabled')).toBe(false);
  });

  it('hides component when dismissed', () => {
    useAppStore.setState({ staleWorkspaces: [makeStaleWorkspace()] });

    const { container } = render(<StaleWorkspaces />);
    expect(screen.getByTestId('stale-workspaces')).toBeDefined();

    // Click dismiss button
    fireEvent.click(screen.getByTestId('stale-dismiss-btn'));

    expect(container.querySelector('[data-testid="stale-workspaces"]')).toBeNull();
  });

  it('calls detectStale on mount', () => {
    api.stacks.detectStale.mockResolvedValue([]);
    render(<StaleWorkspaces />);
    expect(api.stacks.detectStale).toHaveBeenCalled();
  });

  it('calls refresh on refresh button click', async () => {
    useAppStore.setState({ staleWorkspaces: [makeStaleWorkspace()] });
    api.stacks.detectStale.mockResolvedValue([makeStaleWorkspace()]);

    render(<StaleWorkspaces />);

    const refreshBtn = screen.getByTestId('stale-refresh-btn');
    fireEvent.click(refreshBtn);

    expect(api.stacks.detectStale).toHaveBeenCalled();
  });

  it('select all toggles all workspaces', () => {
    const workspaces = [
      makeStaleWorkspace({ stackId: 'stack-1', workspacePath: '/ws/1' }),
      makeStaleWorkspace({ stackId: 'stack-2', workspacePath: '/ws/2' }),
    ];
    useAppStore.setState({ staleWorkspaces: workspaces });

    render(<StaleWorkspaces />);

    const selectAll = screen.getByTestId('stale-select-all');
    fireEvent.click(selectAll);

    // Should show "2 selected" in the UI
    expect(screen.getByText(/2 selected/)).toBeDefined();
  });
});
