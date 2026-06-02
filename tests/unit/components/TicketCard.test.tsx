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

  // Capture real store implementations before any test can override them
  const realRetryRefinement = useAppStore.getState().retryRefinementForTicket;
  const realOpenRefineDialogFromCard = useAppStore.getState().openRefineDialogFromCard;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: PROJECT_DIR, added_at: '' }],
      activeProjectId: 1,
      stacks: [],
      refinementSessions: [],
      boardTickets: [],
      refineInFlight: {},
      refineStartErrors: {},
      showRefineTicketDialog: false,
      refineTicketPrefill: null,
      currentRefinementSessionId: null,
      // Restore real implementations that individual tests may override
      retryRefinementForTicket: realRetryRefinement,
      openRefineDialogFromCard: realOpenRefineDialogFromCard,
    } as any);
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

  it('backlog: clicking Refine moves ticket to refining, starts gate in background, does not open dialog', async () => {
    useAppStore.setState({ boardTickets: [makeTicket('backlog') as any] });
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-refine-42'));
    await waitFor(() => {
      expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('42', PROJECT_DIR);
    });
    expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
    expect(useAppStore.getState().refineTicketPrefill).toBeNull();
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'refining');
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('refining');
  });

  it('backlog: double-click on Refine starts gate only once', async () => {
    useAppStore.setState({ boardTickets: [makeTicket('backlog') as any] });

    let resolveFirst!: (v: { sessionId: string }) => void;
    const firstPromise = new Promise<{ sessionId: string }>((r) => { resolveFirst = r; });
    api.tickets.specCheckAsync.mockReturnValueOnce(firstPromise);

    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-refine-42');

    fireEvent.click(btn);
    fireEvent.click(btn);

    await act(async () => {
      resolveFirst({ sessionId: 'sess-1' });
      await Promise.resolve();
    });

    expect(api.tickets.specCheckAsync).toHaveBeenCalledTimes(1);
  });

  it('refining: no session — shows Start refinement button', () => {
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-start-refine-42')).toBeDefined();
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-retry-42')).toBeNull();
  });

  it('refining: no session — clicking Start refinement calls openRefineDialogFromCard (background, no dialog)', async () => {
    useAppStore.setState({ boardTickets: [makeTicket('refining') as any] });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-start-refine-42'));
    expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
    expect(useAppStore.getState().refineTicketPrefill).toBeNull();
    await waitFor(() => {
      expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('42', PROJECT_DIR);
    });
  });

  it('refining: status running — no action buttons shown', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-run',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'running',
        phase: 'check',
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-retry-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-start-refine-42')).toBeNull();
  });

  it('refining: status ready with questions — shows Answer button', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-ready',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'ready',
        phase: 'check',
        result: {
          passed: false,
          questions: [{ id: 'q1', question: 'Q?', options: [] }],
          gateSummary: '',
          ticketUrl: null,
          cached: false,
        },
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-answer-42')).toBeDefined();
    expect(screen.queryByTestId('ticket-card-retry-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-start-refine-42')).toBeNull();
  });

  it('refining: status ready passed=true, no questions — no button shown', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-pass',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'ready',
        phase: 'check',
        result: {
          passed: true,
          questions: [],
          gateSummary: '',
          ticketUrl: null,
          cached: false,
        },
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-retry-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-start-refine-42')).toBeNull();
  });

  it('refining: status errored — shows Retry button', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-err',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'errored',
        phase: 'check',
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-retry-42')).toBeDefined();
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-start-refine-42')).toBeNull();
  });

  it('refining: status errored — clicking Retry invokes retryRefinementForTicket', async () => {
    const retrySpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-err2',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'errored',
        phase: 'check',
        startedAt: 0,
      }],
      retryRefinementForTicket: retrySpy,
    } as any);
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-retry-42'));
    await waitFor(() => expect(retrySpy).toHaveBeenCalledWith('42', PROJECT_DIR));
  });

  it('refining: clicking Retry runs gate in background without opening dialog', async () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-err-bg',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'errored',
        phase: 'check',
        startedAt: 0,
      }],
      boardTickets: [makeTicket('refining') as any],
    });

    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('ticket-card-retry-42'));
    });

    await waitFor(() => {
      expect(api.tickets.retryRefinementAsync).toHaveBeenCalledWith('sess-err-bg', '42', PROJECT_DIR);
      expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
    });
  });

  it('refining: status interrupted — shows Retry button', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-int',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'interrupted',
        phase: 'check',
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-retry-42')).toBeDefined();
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
  });

  it('refining: status ready with result.error — shows Retry, not Answer', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-ready-err',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'ready',
        phase: 'check',
        result: {
          passed: false,
          questions: [{ id: 'q1', question: 'Q?', options: [] }],
          gateSummary: '',
          ticketUrl: null,
          cached: false,
          error: 'spec gate failed',
        },
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-retry-42')).toBeDefined();
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
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

  it('in_stack: clicking Create PR calls pr.createAuto and does NOT open the dialog on success', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    api.pr.createAuto.mockResolvedValue({ status: 'created', url: 'https://github.com/o/r/pull/1', number: 1 });
    useAppStore.setState({ boardTickets: [makeTicket('in_stack') as any] });
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => expect(api.pr.createAuto).toHaveBeenCalledWith('s1'));
    expect(useAppStore.getState().showCreatePRDialog).toBeNull();
  });

  it('in_stack: clicking Create PR moves ticket to pr_open immediately (optimistic)', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    let resolveAuto!: (v: any) => void;
    api.pr.createAuto.mockReturnValue(new Promise((r) => { resolveAuto = r; }));
    useAppStore.setState({ boardTickets: [makeTicket('in_stack') as any] });
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    // Optimistic move happens synchronously before createAuto resolves
    await waitFor(() => {
      const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
      expect(entry?.column).toBe('pr_open');
    });
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'pr_open');
    resolveAuto({ status: 'created', url: 'https://github.com/o/r/pull/1', number: 1 });
    await waitFor(() => expect(useAppStore.getState().prCreateInFlight['s1']).toBeFalsy());
  });

  it('in_stack: shows Creating PR... spinner while prCreateInFlight is set', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    let resolveAuto!: (v: any) => void;
    api.pr.createAuto.mockReturnValue(new Promise((r) => { resolveAuto = r; }));
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => {
      expect(screen.getByTestId('ticket-card-create-pr-42').textContent).toContain('Creating PR');
    });
    const btn = screen.getByTestId('ticket-card-create-pr-42');
    expect(btn.hasAttribute('disabled')).toBe(true);
    resolveAuto({ status: 'created', url: 'https://github.com/o/r/pull/1', number: 1 });
    await waitFor(() => {
      expect(screen.queryByText(/Creating PR/)).toBeNull();
    });
  });

  it('in_stack: double-click does not call createAuto twice', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    let resolveAuto!: (v: any) => void;
    api.pr.createAuto.mockReturnValue(new Promise((r) => { resolveAuto = r; }));
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    const btn = screen.getByTestId('ticket-card-create-pr-42');
    fireEvent.click(btn);
    fireEvent.click(btn);
    resolveAuto({ status: 'created', url: 'https://github.com/o/r/pull/1', number: 1 });
    await waitFor(() => expect(useAppStore.getState().prCreateInFlight['s1']).toBeFalsy());
    expect(api.pr.createAuto).toHaveBeenCalledTimes(1);
  });

  it('in_stack: opens dialog with no cache when draft fails (Q3 fallback)', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    api.pr.createAuto.mockResolvedValue({ status: 'draft_failed' });
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => {
      expect(useAppStore.getState().showCreatePRDialog).toEqual({ stackId: 's1', initialError: undefined });
    });
    expect(useAppStore.getState().prDraftCache['s1']).toBeUndefined();
  });

  it('in_stack: opens dialog pre-populated with draft and error when create fails (Q4 fallback)', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    api.pr.createAuto.mockResolvedValue({
      status: 'create_failed',
      draft: { title: 'pre-drafted', body: 'pre-body' },
      error: 'gh pr create failed after 5 attempts',
    });
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => {
      expect(useAppStore.getState().showCreatePRDialog?.stackId).toBe('s1');
      expect(useAppStore.getState().showCreatePRDialog?.initialError).toBe('gh pr create failed after 5 attempts');
    });
    expect(useAppStore.getState().prDraftCache['s1']).toEqual({ title: 'pre-drafted', body: 'pre-body' });
  });

  it('in_stack: spinner clears and dialog opens when createAuto rejects unexpectedly', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    api.pr.createAuto.mockRejectedValue(new Error('IPC crash'));
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => {
      expect(useAppStore.getState().showCreatePRDialog?.stackId).toBe('s1');
      expect(useAppStore.getState().prCreateInFlight['s1']).toBeFalsy();
    });
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

  it('in_stack: shows Resume button when linked stack has status=session_paused', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'session_paused', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.getByTestId('ticket-card-resume-42')).toBeDefined();
  });

  it('in_stack: does not show Resume button for non-paused statuses', () => {
    const nonPausedStatuses = ['running', 'idle', 'building', 'completed', 'failed', 'stopped'];
    nonPausedStatuses.forEach((status) => {
      const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status, pr_url: null, pr_number: null } as any;
      const { unmount } = render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
      expect(screen.queryByTestId('ticket-card-resume-42')).toBeNull();
      unmount();
    });
  });

  it('in_stack: does not show Resume button when no linked stack', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-resume-42')).toBeNull();
  });

  it('in_stack: clicking Resume calls resumeStackWithContinuation(stack.id, true)', async () => {
    const resumeFn = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ resumeStackWithContinuation: resumeFn } as any);
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'session_paused', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-resume-42'));
    await waitFor(() => expect(resumeFn).toHaveBeenCalledWith('s1', true));
  });

  it('in_stack: Resume button does not affect Create PR visibility for eligible statuses', () => {
    // session_paused is ineligible for PR — no Create PR shown, but Resume is shown
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'session_paused', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.getByTestId('ticket-card-resume-42')).toBeDefined();
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

  it('refining: in-flight initial refine — shows progress bar, hides Start refinement', () => {
    useAppStore.setState({
      refineInFlight: { [`42|${PROJECT_DIR}`]: true },
      refinementSessions: [],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-start-refine-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-retry-42')).toBeNull();
  });

  it('refining: refineStartError — shows error badge and Retry, hides Start refinement', () => {
    useAppStore.setState({
      refineStartErrors: { [`42|${PROJECT_DIR}`]: 'gate start failed' },
      refinementSessions: [],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-error-badge-42')).toBeDefined();
    expect(screen.getByTestId('ticket-card-retry-42')).toBeDefined();
    expect(screen.queryByTestId('ticket-card-start-refine-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
  });

  it('refining: errored session — shows error badge alongside Retry button', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-badge',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'errored',
        phase: 'check',
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-error-badge-42')).toBeDefined();
    expect(screen.getByTestId('ticket-card-retry-42')).toBeDefined();
  });

  it('refining: clicking Answer opens dialog with the existing session', () => {
    const session = {
      id: 'sess-answer',
      ticketId: '42',
      projectDir: PROJECT_DIR,
      status: 'ready' as const,
      phase: 'check' as const,
      result: {
        passed: false,
        questions: [{ id: 'q1', question: 'Q?', options: [] }],
        gateSummary: '',
        ticketUrl: null,
        cached: false,
      },
      startedAt: 0,
    };
    useAppStore.setState({ refinementSessions: [session] });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-answer-42'));
    expect(useAppStore.getState().showRefineTicketDialog).toBe(true);
    expect(useAppStore.getState().currentRefinementSessionId).toBe('sess-answer');
    // No new gate run
    expect(api.tickets.specCheckAsync).not.toHaveBeenCalled();
  });

  it('refining: inert state (ready + not-passed + no questions + no error) — shows Retry button', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-inert',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'ready',
        phase: 'check',
        result: {
          passed: false,
          questions: [],
          gateSummary: '',
          ticketUrl: null,
          cached: false,
        },
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-retry-42')).toBeDefined();
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-start-refine-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-error-badge-42')).toBeNull();
  });

  it('refining: inert state — clicking Retry invokes retryRefinementForTicket', async () => {
    const retrySpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-inert-click',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'ready',
        phase: 'refine',
        result: {
          passed: false,
          questions: [],
          gateSummary: '',
          ticketUrl: null,
          cached: false,
        },
        startedAt: 0,
      }],
      retryRefinementForTicket: retrySpy,
    } as any);
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-retry-42'));
    await waitFor(() => expect(retrySpy).toHaveBeenCalledWith('42', PROJECT_DIR));
  });

  it('refining: inert state regression — blank card before fix would have no actionable element', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-regression',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'ready',
        phase: 'check',
        result: {
          passed: false,
          questions: [],
          gateSummary: 'Gate=FAIL',
          ticketUrl: null,
          cached: false,
        },
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    // After fix: Retry button is present
    expect(screen.getByTestId('ticket-card-retry-42')).toBeDefined();
    // No other actionable buttons
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-start-refine-42')).toBeNull();
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
