/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { KanbanBoard } from '../../../src/renderer/components/KanbanBoard';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('KanbanBoard', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
      stacks: [],
      boardTickets: [],
      boardTicketsLoading: false,
    });
  });

  it('renders all 6 kanban columns', () => {
    render(<KanbanBoard />);
    expect(screen.getByTestId('kanban-column-backlog')).toBeDefined();
    expect(screen.getByTestId('kanban-column-refining')).toBeDefined();
    expect(screen.getByTestId('kanban-column-spec_ready')).toBeDefined();
    expect(screen.getByTestId('kanban-column-in_stack')).toBeDefined();
    expect(screen.getByTestId('kanban-column-pr_open')).toBeDefined();
    expect(screen.getByTestId('kanban-column-merged')).toBeDefined();
  });

  it('shows project name in board header', () => {
    render(<KanbanBoard />);
    expect(screen.getByText('proj')).toBeDefined();
  });

  it('shows "No cards" placeholder in empty columns', () => {
    render(<KanbanBoard />);
    const noCells = screen.getAllByText('No cards');
    expect(noCells.length).toBe(6);
  });

  it('renders tickets in their correct column', () => {
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '1', project_dir: '/proj', column: 'backlog', title: 'Fix bug', updated_at: '' },
        { ticket_id: '2', project_dir: '/proj', column: 'spec_ready', title: 'Add feature', updated_at: '' },
      ],
    });
    render(<KanbanBoard />);
    expect(screen.getByTestId('ticket-card-1')).toBeDefined();
    expect(screen.getByTestId('ticket-card-2')).toBeDefined();

    const backlogCol = screen.getByTestId('kanban-column-backlog');
    expect(backlogCol.textContent).toContain('Fix bug');

    const specReadyCol = screen.getByTestId('kanban-column-spec_ready');
    expect(specReadyCol.textContent).toContain('Add feature');
  });

  it('only shows tickets for the active project', () => {
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '1', project_dir: '/proj', column: 'backlog', title: 'Alpha ticket', updated_at: '' },
        { ticket_id: '2', project_dir: '/other', column: 'backlog', title: 'Beta ticket', updated_at: '' },
      ],
    });
    render(<KanbanBoard />);
    expect(screen.getByText('Alpha ticket')).toBeDefined();
    expect(screen.queryByText('Beta ticket')).toBeNull();
  });

  it('shows column card count badge when column has cards', () => {
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '1', project_dir: '/proj', column: 'backlog', title: 'T1', updated_at: '' },
        { ticket_id: '2', project_dir: '/proj', column: 'backlog', title: 'T2', updated_at: '' },
      ],
    });
    render(<KanbanBoard />);
    const backlogCol = screen.getByTestId('kanban-column-backlog');
    expect(backlogCol.textContent).toContain('2');
  });

  it('shows loading indicator when boardTicketsLoading', () => {
    useAppStore.setState({ boardTicketsLoading: true });
    render(<KanbanBoard />);
    expect(screen.getByText('Refreshing…')).toBeDefined();
  });

  it('shows prompt when no project is selected', () => {
    useAppStore.setState({ activeProjectId: null });
    render(<KanbanBoard />);
    expect(screen.getByTestId('kanban-board-no-project')).toBeDefined();
  });

  // #388: when a column-move IPC fails, the optimistic update reverts. Before
  // the fix, that revert was silent and the user assumed the click did nothing.
  // The error banner now makes the failure visible and clearable.
  it('shows move-ticket-column error banner when moveTicketColumnError is set (#388)', () => {
    useAppStore.setState({ moveTicketColumnError: 'Failed to move ticket #42 to spec_ready: IPC boom' });
    render(<KanbanBoard />);
    const banner = screen.getByTestId('move-ticket-column-error');
    expect(banner).toBeDefined();
    expect(banner.getAttribute('title')).toMatch(/IPC boom/);
  });

  it('does not render the move-error banner when no error is set (#388)', () => {
    useAppStore.setState({ moveTicketColumnError: null });
    render(<KanbanBoard />);
    expect(screen.queryByTestId('move-ticket-column-error')).toBeNull();
  });

  it('shows the boardTicketsError message (not hardcoded string) when error is set (#435)', async () => {
    const errorMsg = 'JIRA credentials missing — configure them in Project Settings';
    api.tickets.list.mockResolvedValue({ tickets: [], error: { reason: 'missing-creds' } });
    render(<KanbanBoard />);
    // Wait for refreshBoardTickets to complete and set the error
    await waitFor(() => {
      expect(screen.getByTestId('board-tickets-error')).toBeDefined();
    });
    expect(screen.getByTestId('board-tickets-error').textContent).toBe(errorMsg);
  });

  it('shows http-status error message in the banner when boardTicketsError is set', async () => {
    api.tickets.list.mockResolvedValue({ tickets: [], error: { reason: 'http-status', status: 401, body: 'Unauthorized' } });
    render(<KanbanBoard />);
    await waitFor(() => {
      expect(screen.getByTestId('board-tickets-error')).toBeDefined();
    });
    expect(screen.getByTestId('board-tickets-error').textContent).toContain('401');
  });

  it('does not show error banner when boardTicketsError is null (empty tickets is valid state)', async () => {
    api.tickets.list.mockResolvedValue({ tickets: [], error: null });
    render(<KanbanBoard />);
    // Wait for the component to settle after mount fetch
    await waitFor(() => {
      expect(screen.queryByTestId('board-tickets-error')).toBeNull();
    });
  });
});
