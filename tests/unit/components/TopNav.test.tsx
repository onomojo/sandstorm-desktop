/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TopNav } from '../../../src/renderer/components/TopNav';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

vi.mock('../../../src/renderer/tray-icon.png', () => ({ default: 'tray-icon.png' }));
vi.mock('../../../src/renderer/components/AskClaudeModal', () => ({
  AskClaudeModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="ask-claude-modal">
      <button data-testid="ask-claude-modal-close" onClick={onClose}>Close</button>
    </div>
  ),
}));

describe('TopNav', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      projects: [
        { id: 1, name: 'alpha', directory: '/alpha', added_at: '' },
        { id: 2, name: 'beta', directory: '/beta', added_at: '' },
      ],
      activeProjectId: 1,
      stacks: [],
      boardTickets: [],
      searchQuery: '',
      mainView: 'board',
      selectedStackId: null,
      showCreateTicketDialog: false,
      showModelSettings: false,
      showOpenProjectDialog: false,
    } as any);
  });

  // ── Three-zone structure ──────────────────────────────────────────────────

  it('renders the top-nav container', () => {
    render(<TopNav />);
    expect(screen.getByTestId('top-nav')).toBeDefined();
  });

  it('renders brand mark', () => {
    render(<TopNav />);
    expect(screen.getByText('Sandstorm')).toBeDefined();
  });

  it('renders workspace switcher button', () => {
    render(<TopNav />);
    expect(screen.getByTestId('workspace-switcher-btn')).toBeDefined();
  });

  it('renders view switcher button', () => {
    render(<TopNav />);
    expect(screen.getByTestId('view-switcher-btn')).toBeDefined();
  });

  it('renders search input', () => {
    render(<TopNav />);
    expect(screen.getByTestId('search-input')).toBeDefined();
  });

  it('renders Ask Claude button', () => {
    render(<TopNav />);
    expect(screen.getByTestId('ask-claude-btn')).toBeDefined();
  });

  it('renders New ticket button', () => {
    render(<TopNav />);
    expect(screen.getByTestId('new-ticket-btn')).toBeDefined();
  });

  it('renders settings gear button', () => {
    render(<TopNav />);
    expect(screen.getByTestId('settings-cog-btn')).toBeDefined();
  });

  it('renders identity section', () => {
    render(<TopNav />);
    expect(screen.getByTestId('nav-identity')).toBeDefined();
  });

  // ── Workspace switcher ────────────────────────────────────────────────────

  it('workspace dropdown is hidden initially', () => {
    render(<TopNav />);
    expect(screen.queryByTestId('workspace-dropdown')).toBeNull();
  });

  it('opens workspace dropdown on button click', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('workspace-switcher-btn'));
    expect(screen.getByTestId('workspace-dropdown')).toBeDefined();
  });

  it('workspace dropdown lists real projects', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('workspace-switcher-btn'));
    expect(screen.getByTestId('workspace-item-1')).toBeDefined();
    expect(screen.getByTestId('workspace-item-2')).toBeDefined();
    expect(screen.getByTestId('workspace-item-1').textContent).toContain('alpha');
    expect(screen.getByTestId('workspace-item-2').textContent).toContain('beta');
  });

  it('workspace dropdown does NOT contain an "All projects" entry', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('workspace-switcher-btn'));
    expect(screen.queryByText(/all projects/i)).toBeNull();
  });

  it('selecting a workspace item calls setActiveProjectId', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('workspace-switcher-btn'));
    fireEvent.click(screen.getByTestId('workspace-item-2'));
    expect(useAppStore.getState().activeProjectId).toBe(2);
  });

  it('selecting a workspace item closes the dropdown', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('workspace-switcher-btn'));
    fireEvent.click(screen.getByTestId('workspace-item-2'));
    expect(screen.queryByTestId('workspace-dropdown')).toBeNull();
  });

  it('selecting a workspace item resets searchQuery to empty string', () => {
    useAppStore.setState({ searchQuery: 'some query' } as any);
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('workspace-switcher-btn'));
    fireEvent.click(screen.getByTestId('workspace-item-2'));
    expect(useAppStore.getState().searchQuery).toBe('');
  });

  it('shows ticket count badge for project with tickets', () => {
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '1', project_dir: '/alpha', column: 'backlog', title: 'T1', updated_at: '' },
        { ticket_id: '2', project_dir: '/alpha', column: 'backlog', title: 'T2', updated_at: '' },
      ],
    });
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('workspace-switcher-btn'));
    expect(screen.getByTestId('workspace-badge-1')).toBeDefined();
    expect(screen.getByTestId('workspace-badge-1').textContent).toBe('2');
  });

  it('renders add-project-btn inside workspace dropdown', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('workspace-switcher-btn'));
    expect(screen.getByTestId('add-project-btn')).toBeDefined();
  });

  it('clicking add-project-btn opens open-project dialog', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('workspace-switcher-btn'));
    fireEvent.click(screen.getByTestId('add-project-btn'));
    expect(useAppStore.getState().showOpenProjectDialog).toBe(true);
  });

  it('clicking add-project-btn closes the workspace dropdown', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('workspace-switcher-btn'));
    fireEvent.click(screen.getByTestId('add-project-btn'));
    expect(screen.queryByTestId('workspace-dropdown')).toBeNull();
  });

  // ── View switcher ─────────────────────────────────────────────────────────

  it('view dropdown is hidden initially', () => {
    render(<TopNav />);
    expect(screen.queryByTestId('view-dropdown')).toBeNull();
  });

  it('opens view dropdown on button click', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('view-switcher-btn'));
    expect(screen.getByTestId('view-dropdown')).toBeDefined();
  });

  it('view dropdown has exactly Board and Telemetry entries', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('view-switcher-btn'));
    expect(screen.getByTestId('view-item-board')).toBeDefined();
    expect(screen.getByTestId('view-item-telemetry')).toBeDefined();
  });

  it('selecting Board calls setMainView with board', () => {
    useAppStore.setState({ mainView: 'telemetry' });
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('view-switcher-btn'));
    fireEvent.click(screen.getByTestId('view-item-board'));
    expect(useAppStore.getState().mainView).toBe('board');
  });

  it('selecting Telemetry calls setMainView with telemetry and selectStack(null)', () => {
    useAppStore.setState({ mainView: 'board', selectedStackId: 'stack-1' });
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('view-switcher-btn'));
    fireEvent.click(screen.getByTestId('view-item-telemetry'));
    const state = useAppStore.getState();
    expect(state.mainView).toBe('telemetry');
    expect(state.selectedStackId).toBeNull();
  });

  it('view switcher button shows current view name', () => {
    useAppStore.setState({ mainView: 'telemetry' });
    render(<TopNav />);
    const btn = screen.getByTestId('view-switcher-btn');
    expect(btn.textContent).toContain('Telemetry');
  });

  // ── View icons ────────────────────────────────────────────────────────────

  it('view-switcher button shows grid icon when mainView is board', () => {
    useAppStore.setState({ mainView: 'board' });
    render(<TopNav />);
    expect(screen.getByTestId('view-icon')).toBeDefined();
    const icon = screen.getByTestId('view-icon');
    expect(icon.querySelector('rect')).not.toBeNull();
  });

  it('view-switcher button shows chart icon when mainView is telemetry', () => {
    useAppStore.setState({ mainView: 'telemetry' });
    render(<TopNav />);
    expect(screen.getByTestId('view-icon')).toBeDefined();
    const icon = screen.getByTestId('view-icon');
    expect(icon.querySelector('path')).not.toBeNull();
    expect(icon.querySelector('rect')).toBeNull();
  });

  it('view dropdown shows grid icon in board row', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('view-switcher-btn'));
    expect(screen.getByTestId('view-item-board-icon')).toBeDefined();
  });

  it('view dropdown shows chart icon in telemetry row', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('view-switcher-btn'));
    expect(screen.getByTestId('view-item-telemetry-icon')).toBeDefined();
  });

  it('search icon renders adjacent to search input', () => {
    render(<TopNav />);
    expect(screen.getByTestId('search-icon')).toBeDefined();
    expect(screen.getByTestId('search-input')).toBeDefined();
  });

  it('search icon does not block input interaction', () => {
    render(<TopNav />);
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(useAppStore.getState().searchQuery).toBe('hello');
  });

  // ── Action buttons ────────────────────────────────────────────────────────

  it('clicking Ask Claude button opens the modal', async () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('ask-claude-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('ask-claude-modal')).toBeDefined();
    });
  });

  it('closing ask-claude modal removes it from the DOM', async () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('ask-claude-btn'));
    await waitFor(() => screen.getByTestId('ask-claude-modal'));
    fireEvent.click(screen.getByTestId('ask-claude-modal-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('ask-claude-modal')).toBeNull();
    });
  });

  it('clicking New ticket button calls setShowCreateTicketDialog(true)', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('new-ticket-btn'));
    expect(useAppStore.getState().showCreateTicketDialog).toBe(true);
  });

  it('clicking settings gear calls setShowModelSettings(true)', () => {
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('settings-cog-btn'));
    expect(useAppStore.getState().showModelSettings).toBe(true);
  });

  // ── Search ────────────────────────────────────────────────────────────────

  it('search input is bound to store searchQuery', () => {
    useAppStore.setState({ searchQuery: 'initial' } as any);
    render(<TopNav />);
    const input = screen.getByTestId('search-input') as HTMLInputElement;
    expect(input.value).toBe('initial');
  });

  it('typing in search input updates store searchQuery', () => {
    render(<TopNav />);
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'fix bug' } });
    expect(useAppStore.getState().searchQuery).toBe('fix bug');
  });

  it('clear button is not rendered when searchQuery is empty', () => {
    useAppStore.setState({ searchQuery: '' } as any);
    render(<TopNav />);
    expect(screen.queryByTestId('search-clear-btn')).toBeNull();
  });

  it('clear button is rendered when searchQuery is non-empty', () => {
    useAppStore.setState({ searchQuery: 'abc' } as any);
    render(<TopNav />);
    expect(screen.getByTestId('search-clear-btn')).toBeDefined();
  });

  it('clicking clear button sets searchQuery to empty string', () => {
    useAppStore.setState({ searchQuery: 'abc' } as any);
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('search-clear-btn'));
    expect(useAppStore.getState().searchQuery).toBe('');
  });

  it('clicking clear button returns focus to search input', () => {
    useAppStore.setState({ searchQuery: 'abc' } as any);
    render(<TopNav />);
    fireEvent.click(screen.getByTestId('search-clear-btn'));
    expect(document.activeElement).toBe(screen.getByTestId('search-input'));
  });

  // ── Identity ──────────────────────────────────────────────────────────────

  it('shows Login button when not logged in', async () => {
    api.auth.status.mockResolvedValue({ loggedIn: false, expired: false });
    render(<TopNav />);
    await waitFor(() => {
      expect(screen.getByText('Login')).toBeDefined();
    });
  });

  it('shows email when logged in', async () => {
    api.auth.status.mockResolvedValue({ loggedIn: true, email: 'user@example.com', expired: false });
    render(<TopNav />);
    await waitFor(() => {
      expect(screen.getByText('user@example.com')).toBeDefined();
    });
  });

  // ── Regression: removed sections ─────────────────────────────────────────

  it('does not render project stats (Tickets/Live/PRs)', () => {
    render(<TopNav />);
    expect(screen.queryByTestId('stat-tickets')).toBeNull();
    expect(screen.queryByTestId('stat-live')).toBeNull();
    expect(screen.queryByTestId('stat-prs')).toBeNull();
  });

  it('does not render automation section', () => {
    render(<TopNav />);
    expect(screen.queryByTestId('rail-automation')).toBeNull();
  });

  it('does not render telemetry nav button (replaced by view switcher)', () => {
    render(<TopNav />);
    expect(screen.queryByTestId('telemetry-nav-btn')).toBeNull();
  });
});
