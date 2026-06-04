/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LeftRail } from '../../../src/renderer/components/LeftRail';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('LeftRail', () => {
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
      lastTicketFetchAt: null,
      schedules: [],
      schedulesLoading: false,
    });
  });

  it('renders brand mark', () => {
    render(<LeftRail />);
    expect(screen.getByText('Sandstorm')).toBeDefined();
  });

  it('renders workspace pills for each project', () => {
    render(<LeftRail />);
    expect(screen.getByTestId('workspace-pill-1')).toBeDefined();
    expect(screen.getByTestId('workspace-pill-2')).toBeDefined();
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('beta')).toBeDefined();
  });

  it('highlights the active project pill', () => {
    render(<LeftRail />);
    const pill = screen.getByTestId('workspace-pill-1');
    expect(pill.className).toContain('bg-sandstorm-accent');
  });

  it('switches project on pill click', () => {
    render(<LeftRail />);
    fireEvent.click(screen.getByTestId('workspace-pill-2'));
    expect(useAppStore.getState().activeProjectId).toBe(2);
  });

  it('renders add project button', () => {
    render(<LeftRail />);
    expect(screen.getByTestId('add-project-btn')).toBeDefined();
  });

  it('opens open-project dialog when add project is clicked', () => {
    render(<LeftRail />);
    fireEvent.click(screen.getByTestId('add-project-btn'));
    expect(useAppStore.getState().showOpenProjectDialog).toBe(true);
  });

  it('renders New ticket button when a project is active', () => {
    render(<LeftRail />);
    expect(screen.getByTestId('new-ticket-btn')).toBeDefined();
  });

  it('opens create ticket dialog when New ticket is clicked', () => {
    render(<LeftRail />);
    fireEvent.click(screen.getByTestId('new-ticket-btn'));
    expect(useAppStore.getState().showCreateTicketDialog).toBe(true);
  });

  it('renders project stats section with correct counts', () => {
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '1', project_dir: '/alpha', column: 'backlog', title: 'T1', updated_at: '' },
        { ticket_id: '2', project_dir: '/alpha', column: 'spec_ready', title: 'T2', updated_at: '' },
      ],
      stacks: [
        { id: 's1', project_dir: '/alpha', status: 'running', pr_url: 'https://github.com/org/repo/pull/1', pr_number: 1 } as any,
      ],
    });
    render(<LeftRail />);
    const statTickets = screen.getByTestId('stat-tickets');
    expect(statTickets.textContent).toContain('2');
    const statLive = screen.getByTestId('stat-live');
    expect(statLive.textContent).toContain('1');
    const statPrs = screen.getByTestId('stat-prs');
    expect(statPrs.textContent).toContain('1');
  });

  it('shows count badge on active project pill', () => {
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '1', project_dir: '/alpha', column: 'backlog', title: 'T1', updated_at: '' },
      ],
    });
    render(<LeftRail />);
    const pill = screen.getByTestId('workspace-pill-1');
    expect(pill.textContent).toContain('1');
  });

  it('renders Ask Claude button', () => {
    render(<LeftRail />);
    expect(screen.getByTestId('ask-claude-btn')).toBeDefined();
  });

  it('shows ask claude modal when button is clicked', async () => {
    render(<LeftRail />);
    fireEvent.click(screen.getByTestId('ask-claude-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('ask-claude-modal')).toBeDefined();
    });
  });

  it('closes ask claude modal when close button is clicked', async () => {
    render(<LeftRail />);
    fireEvent.click(screen.getByTestId('ask-claude-btn'));
    await waitFor(() => screen.getByTestId('ask-claude-modal'));
    fireEvent.click(screen.getByTestId('ask-claude-modal-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('ask-claude-modal')).toBeNull();
    });
  });

  it('renders identity footer', () => {
    render(<LeftRail />);
    expect(screen.getByTestId('settings-cog-btn')).toBeDefined();
  });

  it('opens model settings when settings cog is clicked', () => {
    render(<LeftRail />);
    fireEvent.click(screen.getByTestId('settings-cog-btn'));
    expect(useAppStore.getState().showModelSettings).toBe(true);
  });

  it('shows email in footer when logged in', async () => {
    api.auth.status.mockResolvedValue({ loggedIn: true, email: 'user@example.com', expired: false });
    render(<LeftRail />);
    await waitFor(() => {
      expect(screen.getByText('user@example.com')).toBeDefined();
    });
  });

  it('renders automation section with enabled schedules', () => {
    useAppStore.setState({
      schedules: [
        {
          id: 'sch1',
          label: 'Daily fetch',
          cronExpression: '0 9 * * 1-5',
          action: { kind: 'run-script', scriptName: 'fetch-ticket.sh' },
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    render(<LeftRail />);
    expect(screen.getByTestId('schedule-row-sch1')).toBeDefined();
    expect(screen.getByText('Daily fetch')).toBeDefined();
  });

  it('shows gear icon on hover of active project pill', async () => {
    render(<LeftRail />);
    const pill = screen.getByTestId('workspace-pill-1');
    fireEvent.mouseEnter(pill);
    await waitFor(() => {
      expect(screen.getByTestId('workspace-gear-1')).toBeDefined();
    });
  });

  it('does not show gear icon when hovering an inactive project pill', async () => {
    render(<LeftRail />);
    const inactivePill = screen.getByTestId('workspace-pill-2');
    fireEvent.mouseEnter(inactivePill);
    await waitFor(() => {
      expect(screen.queryByTestId('workspace-gear-2')).toBeNull();
    });
  });

  it('opens model settings when gear icon is clicked', async () => {
    render(<LeftRail />);
    const pill = screen.getByTestId('workspace-pill-1');
    fireEvent.mouseEnter(pill);
    await waitFor(() => screen.getByTestId('workspace-gear-1'));
    fireEvent.click(screen.getByTestId('workspace-gear-1'));
    expect(useAppStore.getState().showModelSettings).toBe(true);
  });

  it('renders telemetry nav button when a project is active', () => {
    render(<LeftRail />);
    expect(screen.getByTestId('telemetry-nav-btn')).toBeDefined();
  });

  it('clicking telemetry nav button sets mainView to telemetry and calls selectStack(null)', () => {
    render(<LeftRail />);
    fireEvent.click(screen.getByTestId('telemetry-nav-btn'));
    const state = useAppStore.getState();
    expect(state.mainView).toBe('telemetry');
    expect(state.selectedStackId).toBeNull();
  });

  it('applies active styling to telemetry nav button when mainView is telemetry', () => {
    useAppStore.setState({ mainView: 'telemetry' });
    render(<LeftRail />);
    const btn = screen.getByTestId('telemetry-nav-btn');
    expect(btn.className).toContain('bg-sandstorm-accent/15');
  });

  it('shows month cost subline when telemetrySummary is set', () => {
    useAppStore.setState({
      telemetrySummary: {
        monthCost: 4.2,
        prevMonthCost: 3.1,
        tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
        cacheHitPct: 0,
        sessions: 0,
      },
    });
    render(<LeftRail />);
    expect(screen.getByText('$4.20 this month')).toBeDefined();
  });

  it('active project pill swaps count badge for gear on hover and restores badge on mouse-leave', async () => {
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '1', project_dir: '/alpha', column: 'backlog', title: 'T1', updated_at: '' },
      ],
    });
    render(<LeftRail />);
    const pill = screen.getByTestId('workspace-pill-1');

    // Before hover: badge visible, gear absent
    expect(screen.getByTestId('workspace-badge-1')).toBeDefined();
    expect(screen.queryByTestId('workspace-gear-1')).toBeNull();

    // Hover: gear replaces badge
    fireEvent.mouseEnter(pill);
    await waitFor(() => expect(screen.getByTestId('workspace-gear-1')).toBeDefined());
    expect(screen.queryByTestId('workspace-badge-1')).toBeNull();

    // Mouse-leave: badge restored, gear gone
    fireEvent.mouseLeave(pill);
    await waitFor(() => expect(screen.queryByTestId('workspace-gear-1')).toBeNull());
    expect(screen.getByTestId('workspace-badge-1')).toBeDefined();
  });
});
