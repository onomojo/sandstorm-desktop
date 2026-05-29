/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TicketCard } from '../../../src/renderer/components/TicketCard';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

const PROJECT_DIR = '/proj';

const makeTicket = (column: string, overrides = {}) => ({
  ticket_id: '42',
  project_dir: PROJECT_DIR,
  column,
  title: 'Test ticket',
  updated_at: '',
  ...overrides,
});

describe('TicketCard', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: PROJECT_DIR, added_at: '' }],
      activeProjectId: 1,
      stacks: [],
      refinementSessions: [],
      boardTickets: [],
    });
  });

  it('renders ticket id and title', () => {
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-id-42').textContent).toContain('42');
    expect(screen.getByText('Test ticket')).toBeDefined();
  });

  it('backlog: shows Refine button', () => {
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-refine-42')).toBeDefined();
  });

  it('backlog: clicking Refine opens refine dialog and moves column to refining', async () => {
    useAppStore.setState({ boardTickets: [makeTicket('backlog') as any] });
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-refine-42'));
    await waitFor(() => {
      expect(useAppStore.getState().showRefineTicketDialog).toBe(true);
      expect(useAppStore.getState().refineTicketPrefill).toBe('42');
    });
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'refining');
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('refining');
  });

  it('refining: shows Answer button', () => {
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-answer-42')).toBeDefined();
  });

  it('spec_ready: shows Start stack button', () => {
    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-start-stack-42')).toBeDefined();
  });

  it('spec_ready: clicking Start stack opens new stack dialog and moves column to in_stack', async () => {
    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-start-stack-42'));
    await waitFor(() => {
      expect(useAppStore.getState().showNewStackDialog).toBe(true);
    });
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'in_stack');
  });

  it('in_stack: shows Create PR button', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'running', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.getByTestId('ticket-card-create-pr-42')).toBeDefined();
  });

  it('in_stack: clicking Create PR with a stack opens PR dialog and moves column to pr_open', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'running', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => {
      expect(useAppStore.getState().showCreatePRDialog).toEqual({ stackId: 's1' });
    });
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'pr_open');
  });

  it('in_stack: Create PR disabled when no matching stack', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-create-pr-42');
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('pr_open: shows Merge button', () => {
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-merge-42')).toBeDefined();
  });

  it('pr_open: clicking Merge moves column to merged — no real GitHub merge call', async () => {
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-merge-42'));
    await waitFor(() => {
      expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'merged');
    });
    // Verify no PR merge IPC was called
    expect(api.pr.create).not.toHaveBeenCalled();
  });

  it('pr_open: shows PR number with link when stack has pr_number', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    expect(screen.getByTestId('ticket-card-pr-link-42').textContent).toContain('99');
  });

  it('merged: card is dimmed', () => {
    render(<TicketCard ticket={makeTicket('merged') as any} stacks={[]} />);
    const card = screen.getByTestId('ticket-card-42');
    expect(card.className).toContain('opacity-40');
  });

  it('merged: shows Merged label', () => {
    render(<TicketCard ticket={makeTicket('merged') as any} stacks={[]} />);
    expect(screen.getByText('Merged')).toBeDefined();
  });

  it('refining: shows questions awaiting count when session has questions', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess1',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'ready',
        phase: 'check',
        result: {
          passed: false,
          questions: [{ id: 'q1', question: 'Q?', options: [] }, { id: 'q2', question: 'Q2?', options: [] }],
          gateSummary: '',
          ticketUrl: null,
          cached: false,
        },
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByText('2 questions awaiting')).toBeDefined();
  });
});
