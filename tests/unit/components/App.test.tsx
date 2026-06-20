/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from '../../../src/renderer/App';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';
import { buildConfigPanes } from '../../../src/renderer/components/config/panes';

// Mock child components to isolate App logic
vi.mock('../../../src/renderer/components/KanbanBoard', () => ({
  KanbanBoard: () => <div data-testid="kanban-board" />,
}));
vi.mock('../../../src/renderer/components/TopNav', () => ({
  TopNav: () => <div data-testid="top-nav" />,
}));
vi.mock('../../../src/renderer/components/StackDetail', () => ({
  StackDetail: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="stack-detail">
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock('../../../src/renderer/components/OpenProjectDialog', () => ({
  OpenProjectDialog: () => <div data-testid="open-project-dialog" />,
}));
vi.mock('../../../src/renderer/tray-icon.png', () => ({ default: 'tray-icon.png' }));
vi.mock('../../../src/renderer/components/ProjectConfigModal', () => ({
  ProjectConfigModal: ({ open, title, panes, onClose, onSave }: {
    open: boolean;
    title: string;
    panes: Array<{ id: string; label: string }>;
    onClose: () => void;
    onSave: () => void;
  }) =>
    open ? (
      <div data-testid="project-config-modal">
        {title}
        {panes?.map((p) => (
          <span key={p.id} data-testid={`pane-tab-${p.id}`}>{p.label}</span>
        ))}
        <button data-testid="modal-close" onClick={onClose}>Close</button>
        <button data-testid="modal-save" onClick={onSave}>Save</button>
      </div>
    ) : null,
}));
vi.mock('../../../src/renderer/components/config/panes', () => ({
  buildConfigPanes: vi.fn().mockResolvedValue([]),
}));

describe('App', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      stacks: [],
      stackMetrics: {},
      projects: [],
      activeProjectId: null,
      selectedStackId: null,
      showOpenProjectDialog: false,
      dockerConnected: true,
      error: null,
    });
  });

  it('renders the app shell with top nav and kanban board', () => {
    render(<App />);
    expect(screen.getByTestId('top-nav')).toBeDefined();
    expect(screen.getByTestId('kanban-board')).toBeDefined();
  });

  it('calls docker.status on mount using the shared mock', async () => {
    render(<App />);
    await waitFor(() => {
      expect(api.docker.status).toHaveBeenCalled();
    });
  });

  it('sets dockerConnected based on docker.status response', async () => {
    api.docker.status.mockResolvedValue({ connected: false });
    render(<App />);
    await waitFor(() => {
      expect(useAppStore.getState().dockerConnected).toBe(false);
    });
  });

  it('shows Docker disconnected banner when dockerConnected is false', () => {
    useAppStore.setState({ dockerConnected: false });
    render(<App />);
    expect(screen.getByText(/Docker is unavailable/)).toBeDefined();
  });

  it('hides Docker disconnected banner when dockerConnected is true', () => {
    useAppStore.setState({ dockerConnected: true });
    render(<App />);
    expect(screen.queryByText(/Docker is unavailable/)).toBeNull();
  });

  it('shows error banner when error is set', () => {
    useAppStore.setState({ error: 'Something went wrong' });
    render(<App />);
    expect(screen.getByText('Something went wrong')).toBeDefined();
  });

  it('renders StackDetail when a stack is selected', () => {
    useAppStore.setState({ selectedStackId: 'stack-1' });
    render(<App />);
    expect(screen.getByTestId('stack-detail')).toBeDefined();
    expect(screen.queryByTestId('kanban-board')).toBeNull();
  });

  it('renders OpenProjectDialog when showOpenProjectDialog is true', () => {
    useAppStore.setState({ showOpenProjectDialog: true });
    render(<App />);
    expect(screen.getByTestId('open-project-dialog')).toBeDefined();
  });

  it('subscribes to docker:connected and docker:disconnected events on mount', () => {
    render(<App />);
    expect(api.on).toHaveBeenCalledWith('docker:connected', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('docker:disconnected', expect.any(Function));
  });

  it('does not call stacks.history on mount', async () => {
    render(<App />);
    await waitFor(() => {
      expect(api.docker.status).toHaveBeenCalled();
    });
    expect(api.stacks.history).not.toHaveBeenCalled();
  });

  it('renders ProjectConfigModal when showModelSettings is true and a project is active', async () => {
    useAppStore.setState({
      showModelSettings: true,
      projects: [{ id: 1, name: 'My Project', directory: '/myproject', added_at: '' }],
      activeProjectId: 1,
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('project-config-modal')).toBeDefined();
    });
  });

  it('does not render ProjectConfigModal when showModelSettings is true but no project is active', () => {
    useAppStore.setState({ showModelSettings: true, activeProjectId: null });
    render(<App />);
    expect(screen.queryByTestId('project-config-modal')).toBeNull();
  });

  it('ProjectConfigModal onClose clears showModelSettings', async () => {
    const testProject = { id: 1, name: 'My Project', directory: '/myproject', added_at: '' };
    api.projects.list.mockResolvedValue([testProject]);
    useAppStore.setState({
      showModelSettings: true,
      projects: [testProject],
      activeProjectId: 1,
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('project-config-modal')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('modal-close'));
    await waitFor(() => {
      expect(useAppStore.getState().showModelSettings).toBe(false);
    });
  });

  it('onSave invokes pane-registered save and calls window.sandstorm.modelRouting.setProject', async () => {
    const testProject = { id: 1, name: 'My Project', directory: '/myproject', added_at: '' };
    api.projects.list.mockResolvedValue([testProject]);
    vi.mocked(buildConfigPanes).mockImplementationOnce(async (ctx) => {
      ctx.registerSave(async () => {
        await window.sandstorm.modelRouting.setProject('/myproject', {});
      });
      return [{ id: 'models', label: 'Models', icon: null, render: () => null }] as any;
    });

    useAppStore.setState({
      showModelSettings: true,
      projects: [testProject],
      activeProjectId: 1,
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('project-config-modal')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('modal-save'));

    await waitFor(() => {
      expect(api.modelRouting.setProject).toHaveBeenCalledWith('/myproject', {});
    });
  });

  it('passes Models, Providers, Automation, Ticketing panes to ProjectConfigModal', async () => {
    const testProject = { id: 1, name: 'My Project', directory: '/myproject', added_at: '' };
    api.projects.list.mockResolvedValue([testProject]);
    vi.mocked(buildConfigPanes).mockResolvedValueOnce([
      { id: 'models', label: 'Models', icon: null, render: () => null },
      { id: 'providers', label: 'Providers', icon: null, render: () => null },
      { id: 'automation', label: 'Automation', icon: null, render: () => null },
      { id: 'ticketing', label: 'Ticketing', icon: null, render: () => null },
    ] as any);

    useAppStore.setState({
      showModelSettings: true,
      projects: [testProject],
      activeProjectId: 1,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('pane-tab-models')).toBeDefined();
      expect(screen.getByTestId('pane-tab-providers')).toBeDefined();
      expect(screen.getByTestId('pane-tab-automation')).toBeDefined();
      expect(screen.getByTestId('pane-tab-ticketing')).toBeDefined();
    });
  });
});
