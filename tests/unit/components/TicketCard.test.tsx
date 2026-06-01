/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

  it('spec_ready: clicking Start stack calls stacks.create with verified defaults and moves to in_stack', async () => {
    useAppStore.setState({ boardTickets: [makeTicket('spec_ready') as any] });
    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-start-stack-42'));

    // Card moves optimistically to in_stack before fetch+create resolve
    await waitFor(() => {
      const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
      expect(entry?.column).toBe('in_stack');
    });

    // stacks.create called with verified defaults
    await waitFor(() => {
      expect(api.stacks.create).toHaveBeenCalledWith({
        name: 'ticket-42',
        projectDir: PROJECT_DIR,
        ticket: '42',
        branch: 'feat/42-ticket-42',
        description: 'Issue: test',
        runtime: 'docker',
        task: '# Issue: test\n\nbody',
        gateApproved: true,
      });
    });

    // Dialog must NOT be opened
    expect(useAppStore.getState().showNewStackDialog).toBe(false);
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'in_stack');
  });

  it('spec_ready: clicking Start stack does not open NewStackDialog', async () => {
    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-start-stack-42'));
    // Give the action a chance to run
    await act(async () => {});
    expect(useAppStore.getState().showNewStackDialog).toBe(false);
  });

  it('spec_ready: on tickets.fetch failure, card stays in in_stack and shows error indicator', async () => {
    api.tickets.fetch.mockRejectedValueOnce(new Error('network error'));
    useAppStore.setState({ boardTickets: [makeTicket('spec_ready') as any] });
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);

    await act(async () => {
      await useAppStore.getState().startStackForTicket('42', PROJECT_DIR);
    });

    // Card stays in in_stack
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('in_stack');

    // Re-render as in_stack card to see the error
    const { container } = render(<TicketCard ticket={{ ...makeTicket('in_stack'), ticket_id: '42' } as any} stacks={[]} />);
    expect(container.querySelector('[data-testid="ticket-card-create-error-42"]')).not.toBeNull();
  });

  it('spec_ready: on stacks.create failure, card stays in in_stack and shows error indicator', async () => {
    api.stacks.create.mockRejectedValueOnce(new Error('docker unavailable'));
    useAppStore.setState({ boardTickets: [makeTicket('spec_ready') as any] });

    await act(async () => {
      await useAppStore.getState().startStackForTicket('42', PROJECT_DIR);
    });

    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('in_stack');

    const { container } = render(<TicketCard ticket={{ ...makeTicket('in_stack'), ticket_id: '42' } as any} stacks={[]} />);
    const errorEl = container.querySelector('[data-testid="ticket-card-create-error-42"]');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain('docker unavailable');
  });

  it('spec_ready: double-click does not call stacks.create twice', async () => {
    useAppStore.setState({ boardTickets: [makeTicket('spec_ready') as any] });

    // Delay fetch so the in-flight flag is still set on the second call
    let resolveFetch!: (v: { body: string; url: string }) => void;
    const fetchPromise = new Promise<{ body: string; url: string }>((r) => { resolveFetch = r; });
    api.tickets.fetch.mockReturnValueOnce(fetchPromise);

    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-start-stack-42');

    fireEvent.click(btn);
    fireEvent.click(btn);

    // Resolve the fetch so the action settles
    await act(async () => {
      resolveFetch({ body: '# Issue\nbody', url: null as unknown as string });
      await Promise.resolve();
    });

    await waitFor(() => expect(useAppStore.getState().stackCreateInFlight['42|/proj']).toBeFalsy());

    expect(api.stacks.create).toHaveBeenCalledTimes(1);
  });

  it('in_stack: shows Create PR button for eligible status (completed)', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.getByTestId('ticket-card-create-pr-42')).toBeDefined();
  });

  it('in_stack: clicking Create PR with an eligible stack opens PR dialog and moves column to pr_open', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => {
      expect(useAppStore.getState().showCreatePRDialog).toEqual({ stackId: 's1' });
    });
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'pr_open');
  });

  it('in_stack: Create PR button absent when no matching stack', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-create-pr-42')).toBeNull();
  });

  // All 14 StackStatus values — PR button visibility map
  const ELIGIBLE_STATUSES = ['completed', 'failed', 'pushed', 'needs_human', 'verify_blocked_environmental'];
  const INELIGIBLE_STATUSES = ['building', 'rebuilding', 'up', 'running', 'idle', 'stopped', 'pr_created', 'rate_limited', 'session_paused'];

  ELIGIBLE_STATUSES.forEach((status) => {
    it(`in_stack: Create PR button is present for status="${status}"`, () => {
      const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status, pr_url: null, pr_number: null } as any;
      render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
      expect(screen.queryByTestId('ticket-card-create-pr-42')).not.toBeNull();
    });
  });

  INELIGIBLE_STATUSES.forEach((status) => {
    it(`in_stack: Create PR button is absent for status="${status}"`, () => {
      const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status, pr_url: null, pr_number: null } as any;
      render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
      expect(screen.queryByTestId('ticket-card-create-pr-42')).toBeNull();
    });
  });

  it('in_stack: Create PR button is absent when pr_url is set on an eligible status', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: 'https://github.com/o/r/pull/1', pr_number: 1 } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.queryByTestId('ticket-card-create-pr-42')).toBeNull();
  });

  it('pr_open: shows Merge button', () => {
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-merge-42')).toBeDefined();
  });

  it('pr_open: clicking Merge with no stack calls ticketBoard.setColumn without teardown or GitHub merge', async () => {
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [] });
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-merge-42'));
    await waitFor(() => {
      expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'merged');
    });
    expect(api.pr.merge).not.toHaveBeenCalled();
    expect(api.stacks.teardown).not.toHaveBeenCalled();
  });

  it('pr_open: clicking Merge with a stack calls pr.merge → teardown → setColumn in order', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [stack] });
    const callOrder: string[] = [];
    api.pr.merge.mockImplementation(async () => { callOrder.push('merge'); });
    api.stacks.teardown.mockImplementation(async () => { callOrder.push('teardown'); });
    api.ticketBoard.setColumn.mockImplementation(async () => { callOrder.push('setColumn'); });

    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-merge-42'));
    await waitFor(() => {
      expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'merged');
    });
    expect(api.pr.merge).toHaveBeenCalledWith('s1', 99);
    expect(api.stacks.teardown).toHaveBeenCalledWith('s1');
    expect(callOrder).toEqual(['merge', 'teardown', 'setColumn']);
  });

  it('pr_open: GitHub merge failure aborts teardown and column move, surfaces error', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [stack] });
    api.pr.merge.mockRejectedValueOnce(new Error('branch protection'));

    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-merge-42'));
    await waitFor(() => {
      expect(useAppStore.getState().moveTicketColumnError).toContain('branch protection');
    });
    expect(api.stacks.teardown).not.toHaveBeenCalled();
    expect(api.ticketBoard.setColumn).not.toHaveBeenCalled();
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('pr_open');
  });

  it('pr_open: teardown failure after successful merge surfaces error and keeps card in pr_open', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [stack] });
    api.stacks.teardown.mockRejectedValueOnce(new Error('docker gone'));

    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-merge-42'));
    await waitFor(() => {
      expect(useAppStore.getState().moveTicketColumnError).toContain('docker gone');
    });
    expect(api.pr.merge).toHaveBeenCalled();
    expect(api.ticketBoard.setColumn).not.toHaveBeenCalled();
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('pr_open');
  });

  it('pr_open: Stack-not-found from pr.merge is non-fatal — column still moves to merged', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [stack] });
    api.pr.merge.mockRejectedValueOnce(new Error('Stack "s1" not found'));
    api.stacks.teardown.mockRejectedValueOnce(new Error('Stack "s1" not found'));

    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-merge-42'));
    await waitFor(() => {
      expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'merged');
    });
    expect(useAppStore.getState().moveTicketColumnError).toBeNull();
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('merged');
  });

  it('pr_open: Stack-not-found from teardown (after successful pr.merge) is non-fatal — column still moves to merged', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [stack] });
    api.stacks.teardown.mockRejectedValueOnce(new Error('Stack "s1" not found'));

    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-merge-42'));
    await waitFor(() => {
      expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'merged');
    });
    expect(api.pr.merge).toHaveBeenCalled();
    expect(useAppStore.getState().moveTicketColumnError).toBeNull();
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('merged');
  });

  it('pr_open: double-click on Merge is a no-op — only one merge runs', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [stack] });

    let resolveMerge!: () => void;
    const mergePromise = new Promise<void>((r) => { resolveMerge = r; });
    api.pr.merge.mockReturnValueOnce(mergePromise);

    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    const btn = screen.getByTestId('ticket-card-merge-42');
    fireEvent.click(btn);
    fireEvent.click(btn);

    await act(async () => {
      resolveMerge();
      await Promise.resolve();
    });

    await waitFor(() => expect(useAppStore.getState().mergeInFlight['42|/proj']).toBeFalsy());
    expect(api.pr.merge).toHaveBeenCalledTimes(1);
  });

  it('pr_open: Merge button is disabled while merge is in flight', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ mergeInFlight: { '42|/proj': true } });
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    const btn = screen.getByTestId('ticket-card-merge-42');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.textContent).toBe('Merging…');
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
