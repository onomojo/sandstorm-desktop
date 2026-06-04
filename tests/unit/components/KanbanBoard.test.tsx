/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

  // #502: All/Recent toggle in Merged column header
  it('renders merged-mode-toggle in merged column with Recent as default (#502)', () => {
    render(<KanbanBoard />);
    const mergedCol = screen.getByTestId('kanban-column-merged');
    const toggle = mergedCol.querySelector('[data-testid="merged-mode-toggle"]');
    expect(toggle).not.toBeNull();
    expect(screen.getByTestId('merged-mode-recent')).toBeDefined();
    expect(screen.getByTestId('merged-mode-all')).toBeDefined();
  });

  it('renders exactly 10 cards in Recent mode when >10 merged tickets (#502)', () => {
    useAppStore.setState({
      boardTickets: Array.from({ length: 12 }, (_, i) => ({
        ticket_id: `m${i + 1}`,
        project_dir: '/proj',
        column: 'merged' as const,
        title: `Merged ${i + 1}`,
        updated_at: `2023-01-${String(i + 1).padStart(2, '0')}`,
      })),
    });
    render(<KanbanBoard />);
    const mergedCol = screen.getByTestId('kanban-column-merged');
    const cards = mergedCol.querySelectorAll('[data-testid^="ticket-card-"]');
    expect(cards.length).toBe(10);
  });

  it('renders the 10 highest updated_at tickets in Recent mode, not the oldest (#502)', () => {
    useAppStore.setState({
      boardTickets: Array.from({ length: 12 }, (_, i) => ({
        ticket_id: `m${i + 1}`,
        project_dir: '/proj',
        column: 'merged' as const,
        title: `Merged ${i + 1}`,
        updated_at: `2023-01-${String(i + 1).padStart(2, '0')}`,
      })),
    });
    render(<KanbanBoard />);
    // Tickets 3–12 have the 10 highest updated_at values and should render
    for (let i = 3; i <= 12; i++) {
      expect(screen.getByTestId(`ticket-card-m${i}`)).toBeDefined();
    }
    // Tickets 1 and 2 are the oldest and must NOT render
    expect(screen.queryByTestId('ticket-card-m1')).toBeNull();
    expect(screen.queryByTestId('ticket-card-m2')).toBeNull();
  });

  it('renders all merged tickets when switching to All mode (#502)', () => {
    useAppStore.setState({
      boardTickets: Array.from({ length: 12 }, (_, i) => ({
        ticket_id: `m${i + 1}`,
        project_dir: '/proj',
        column: 'merged' as const,
        title: `Merged ${i + 1}`,
        updated_at: `2023-01-${String(i + 1).padStart(2, '0')}`,
      })),
    });
    render(<KanbanBoard />);
    fireEvent.click(screen.getByTestId('merged-mode-all'));
    const mergedCol = screen.getByTestId('kanban-column-merged');
    const cards = mergedCol.querySelectorAll('[data-testid^="ticket-card-"]');
    expect(cards.length).toBe(12);
  });

  it('count badge shows total merged count even when Recent mode shows fewer (#502)', () => {
    useAppStore.setState({
      boardTickets: Array.from({ length: 12 }, (_, i) => ({
        ticket_id: `m${i + 1}`,
        project_dir: '/proj',
        column: 'merged' as const,
        title: `Merged ${i + 1}`,
        updated_at: `2023-01-${String(i + 1).padStart(2, '0')}`,
      })),
    });
    render(<KanbanBoard />);
    const mergedCol = screen.getByTestId('kanban-column-merged');
    expect(mergedCol.textContent).toContain('12');
  });

  it('toggle renders and both modes show same cards when ≤10 merged tickets (#502)', () => {
    useAppStore.setState({
      boardTickets: Array.from({ length: 5 }, (_, i) => ({
        ticket_id: `m${i + 1}`,
        project_dir: '/proj',
        column: 'merged' as const,
        title: `Merged ${i + 1}`,
        updated_at: `2023-01-${String(i + 1).padStart(2, '0')}`,
      })),
    });
    render(<KanbanBoard />);
    expect(screen.getByTestId('merged-mode-toggle')).toBeDefined();
    const mergedCol = screen.getByTestId('kanban-column-merged');
    expect(mergedCol.querySelectorAll('[data-testid^="ticket-card-"]').length).toBe(5);
    fireEvent.click(screen.getByTestId('merged-mode-all'));
    expect(mergedCol.querySelectorAll('[data-testid^="ticket-card-"]').length).toBe(5);
  });

  it('merged-mode-toggle does not appear in non-merged columns (#502)', () => {
    render(<KanbanBoard />);
    const nonMergedCols = ['backlog', 'refining', 'spec_ready', 'in_stack', 'pr_open'];
    for (const colId of nonMergedCols) {
      const col = screen.getByTestId(`kanban-column-${colId}`);
      expect(col.querySelector('[data-testid="merged-mode-toggle"]')).toBeNull();
    }
  });

  it('sort is deterministic for equal updated_at, tie-breaking by ticket_id ascending (#502)', () => {
    useAppStore.setState({
      boardTickets: Array.from({ length: 12 }, (_, i) => ({
        ticket_id: `t${String(i + 1).padStart(2, '0')}`,
        project_dir: '/proj',
        column: 'merged' as const,
        title: `Ticket ${i + 1}`,
        updated_at: '2023-06-01',
      })),
    });
    render(<KanbanBoard />);
    const mergedCol = screen.getByTestId('kanban-column-merged');
    expect(mergedCol.querySelectorAll('[data-testid^="ticket-card-"]').length).toBe(10);
    // Tie-break is ticket_id ascending: t01–t10 render, t11 and t12 do not
    for (let i = 1; i <= 10; i++) {
      expect(screen.getByTestId(`ticket-card-t${String(i).padStart(2, '0')}`)).toBeDefined();
    }
    expect(screen.queryByTestId('ticket-card-t11')).toBeNull();
    expect(screen.queryByTestId('ticket-card-t12')).toBeNull();
  });
});
