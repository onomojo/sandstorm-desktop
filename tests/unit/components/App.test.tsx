/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../../../src/renderer/App';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

// Mock child components to isolate App logic
vi.mock('../../../src/renderer/components/Dashboard', () => ({
  Dashboard: () => <div data-testid="dashboard" />,
}));
vi.mock('../../../src/renderer/components/StackDetail', () => ({
  StackDetail: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="stack-detail">
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock('../../../src/renderer/components/NewStackDialog', () => ({
  NewStackDialog: () => <div data-testid="new-stack-dialog" />,
}));
vi.mock('../../../src/renderer/components/ProjectTabs', () => ({
  ProjectTabs: () => <div data-testid="project-tabs" />,
}));
vi.mock('../../../src/renderer/components/OpenProjectDialog', () => ({
  OpenProjectDialog: () => <div data-testid="open-project-dialog" />,
}));
vi.mock('../../../src/renderer/components/ReauthModal', () => ({
  ReauthModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="reauth-modal">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));
vi.mock('../../../src/renderer/tray-icon.png', () => ({ default: 'tray-icon.png' }));

describe('App', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      stacks: [],
      stackHistory: [],
      stackMetrics: {},
      projects: [],
      activeProjectId: null,
      selectedStackId: null,
      showNewStackDialog: false,
      showOpenProjectDialog: false,
      showReauthModal: false,
      dockerConnected: true,
      error: null,
    });
  });

  it('renders the app shell with project tabs and dashboard', () => {
    render(<App />);
    expect(screen.getByTestId('project-tabs')).toBeDefined();
    expect(screen.getByTestId('dashboard')).toBeDefined();
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
    expect(screen.queryByTestId('dashboard')).toBeNull();
  });

  it('renders NewStackDialog when showNewStackDialog is true', () => {
    useAppStore.setState({ showNewStackDialog: true });
    render(<App />);
    expect(screen.getByTestId('new-stack-dialog')).toBeDefined();
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
});
