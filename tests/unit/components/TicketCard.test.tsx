/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TicketCard } from '../../../src/renderer/components/TicketCard';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

// Mock AnswerQuestionsModal to avoid IPC calls in tests
vi.mock('../../../src/renderer/components/AnswerQuestionsModal', () => ({
  AnswerQuestionsModal: ({ onClose, onResumed }: { stackId: string; onClose: () => void; onResumed: () => void }) => (
    <div data-testid="answer-questions-modal">
      <button data-testid="answer-modal-close" onClick={onClose}>Close</button>
      <button data-testid="answer-modal-resumed" onClick={onResumed}>Resumed</button>
    </div>
  ),
}));

// Mock DiscardStackDialog to avoid full dialog rendering in all tests
vi.mock('../../../src/renderer/components/DiscardStackDialog', () => ({
  DiscardStackDialog: ({ onBackToBacklog, onCloseTicket, onCancel, 'data-testid': testId }: {
    onBackToBacklog: () => void;
    onCloseTicket: () => void;
    onCancel: () => void;
    'data-testid'?: string;
  }) => (
    <div data-testid={testId ?? 'discard-stack-dialog'} role="dialog">
      <button data-testid="discard-dialog-back-to-backlog" onClick={onBackToBacklog}>Back to backlog</button>
      <button data-testid="discard-dialog-close-ticket" onClick={onCloseTicket}>Close ticket</button>
      <button data-testid="discard-dialog-cancel" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

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
      discardInFlight: {},
      discardErrors: {},
      mergeInFlight: {},
      autoResolveInFlight: {},
      autoResolveErrors: {},
      mergeConflicts: {},
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

  it('backlog: shows Edit button', () => {
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-edit-42')).toBeDefined();
  });

  it('backlog: clicking Edit opens EditTicketDialog via store', () => {
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-edit-42'));
    expect(useAppStore.getState().showEditTicketDialog).toBe(true);
    expect(useAppStore.getState().editTicketTarget).toEqual({ ticketId: '42', projectDir: PROJECT_DIR });
  });

  it('refining: Edit button NOT shown', () => {
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-edit-42')).toBeNull();
  });

  it('spec_ready: Edit button NOT shown', () => {
    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-edit-42')).toBeNull();
  });

  it('in_stack: Edit button NOT shown', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-edit-42')).toBeNull();
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

    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'in_stack');
  });

  it('spec_ready: clicking Start stack calls startStackForTicket without opening a dialog', async () => {
    useAppStore.setState({ boardTickets: [makeTicket('spec_ready') as any] });
    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-start-stack-42'));
    await act(async () => {});
    // Stack creation path fires without any dialog being shown
    expect(api.stacks.create).toHaveBeenCalled();
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

  it('in_stack: clicking Create PR moves ticket to pr_open only after confirmed success', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    let resolveAuto!: (v: any) => void;
    api.pr.createAuto.mockReturnValue(new Promise((r) => { resolveAuto = r; }));
    useAppStore.setState({ boardTickets: [makeTicket('in_stack') as any] });
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    // Card must NOT move to pr_open before createAuto resolves
    await act(async () => { await Promise.resolve(); });
    const entryBefore = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entryBefore?.column).toBe('in_stack');
    // Now resolve with success — card should advance
    await act(async () => {
      resolveAuto({ status: 'created', url: 'https://github.com/o/r/pull/1', number: 1 });
      await Promise.resolve();
    });
    await waitFor(() => {
      const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
      expect(entry?.column).toBe('pr_open');
    });
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'pr_open');
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

  it('in_stack: shows inline error and keeps card in in_stack when draft fails', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    api.pr.createAuto.mockResolvedValue({ status: 'draft_failed' });
    useAppStore.setState({ boardTickets: [makeTicket('in_stack') as any] });
    const { container } = render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => {
      expect(useAppStore.getState().prCreateErrors['s1']).toBeTruthy();
    });
    expect(useAppStore.getState().showCreatePRDialog).toBeNull();
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('in_stack');
    expect(container.querySelector('[data-testid="ticket-card-pr-create-error-42"]')).not.toBeNull();
  });

  it('in_stack: shows inline error with draft saved and keeps card in in_stack when create fails', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    api.pr.createAuto.mockResolvedValue({
      status: 'create_failed',
      draft: { title: 'pre-drafted', body: 'pre-body' },
      error: 'gh pr create failed after 5 attempts',
    });
    useAppStore.setState({ boardTickets: [makeTicket('in_stack') as any] });
    const { container } = render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => {
      expect(useAppStore.getState().prCreateErrors['s1']).toBe('gh pr create failed after 5 attempts');
    });
    expect(useAppStore.getState().showCreatePRDialog).toBeNull();
    expect(useAppStore.getState().prDraftCache['s1']).toEqual({ title: 'pre-drafted', body: 'pre-body' });
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('in_stack');
    expect(container.querySelector('[data-testid="ticket-card-pr-create-error-42"]')).not.toBeNull();
  });

  it('in_stack: shows inline error and keeps card in in_stack when createAuto rejects unexpectedly', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    api.pr.createAuto.mockRejectedValue(new Error('IPC crash'));
    useAppStore.setState({ boardTickets: [makeTicket('in_stack') as any] });
    const { container } = render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => {
      expect(useAppStore.getState().prCreateErrors['s1']).toBe('IPC crash');
      expect(useAppStore.getState().prCreateInFlight['s1']).toBeFalsy();
    });
    expect(useAppStore.getState().showCreatePRDialog).toBeNull();
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('in_stack');
    expect(container.querySelector('[data-testid="ticket-card-pr-create-error-42"]')).not.toBeNull();
  });

  it('in_stack: Create PR button stays available after a failure (pr_url not set)', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    api.pr.createAuto.mockResolvedValue({ status: 'draft_failed' });
    useAppStore.setState({ boardTickets: [makeTicket('in_stack') as any] });
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-create-pr-42'));
    await waitFor(() => expect(useAppStore.getState().prCreateErrors['s1']).toBeTruthy());
    expect(screen.queryByTestId('ticket-card-create-pr-42')).not.toBeNull();
  });

  it('in_stack: Create PR button absent when no matching stack', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-create-pr-42')).toBeNull();
  });

  // All 14 StackStatus values — PR button visibility map
  const ELIGIBLE_STATUSES = ['completed', 'failed', 'pushed', 'verify_blocked_environmental'];
  const INELIGIBLE_STATUSES = ['building', 'rebuilding', 'up', 'running', 'idle', 'stopped', 'pr_created', 'rate_limited', 'session_paused', 'needs_human'];

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

  it('in_stack: shows Answer button when stack.status === needs_human', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'needs_human', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.getByTestId('ticket-card-in-stack-answer-42')).toBeDefined();
  });

  it('in_stack: does not show Answer button when no linked stack', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-in-stack-answer-42')).toBeNull();
  });

  it('in_stack: does not show Answer button for non-needs_human statuses', () => {
    const nonAnswerStatuses = ['running', 'building', 'completed', 'failed', 'session_paused'];
    nonAnswerStatuses.forEach((status) => {
      const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status, pr_url: null, pr_number: null } as any;
      const { unmount } = render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
      expect(screen.queryByTestId('ticket-card-in-stack-answer-42')).toBeNull();
      unmount();
    });
  });

  it('in_stack: needs_human does not show Create PR button (regression: was missing Answer affordance)', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'needs_human', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.getByTestId('ticket-card-in-stack-answer-42')).toBeDefined();
    expect(screen.queryByTestId('ticket-card-create-pr-42')).toBeNull();
  });

  it('in_stack: clicking Answer button mounts AnswerQuestionsModal', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'needs_human', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.queryByTestId('answer-questions-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('ticket-card-in-stack-answer-42'));
    expect(screen.getByTestId('answer-questions-modal')).toBeDefined();
  });

  it('in_stack: closing AnswerQuestionsModal hides it', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'needs_human', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-in-stack-answer-42'));
    expect(screen.getByTestId('answer-questions-modal')).toBeDefined();
    fireEvent.click(screen.getByTestId('answer-modal-close'));
    expect(screen.queryByTestId('answer-questions-modal')).toBeNull();
  });

  it('in_stack: onResumed closes modal and calls refreshStacks', async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ refreshStacks: refreshSpy } as any);
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'needs_human', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-in-stack-answer-42'));
    fireEvent.click(screen.getByTestId('answer-modal-resumed'));
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    expect(screen.queryByTestId('answer-questions-modal')).toBeNull();
  });

  it('in_stack: session_paused still shows Resume button (regression guard)', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'session_paused', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.getByTestId('ticket-card-resume-42')).toBeDefined();
    expect(screen.queryByTestId('ticket-card-in-stack-answer-42')).toBeNull();
  });

  it('pr_open: shows Merge button when stack has pr_number set', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    expect(screen.getByTestId('ticket-card-merge-42')).toBeDefined();
  });

  it('pr_open: Merge button is absent when stack has pr_number == null (stuck card fix)', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    expect(screen.queryByTestId('ticket-card-merge-42')).toBeNull();
  });

  it('pr_open: Merge button is absent when there is no linked stack', () => {
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-merge-42')).toBeNull();
  });

  it('pr_open: clicking Merge with a stack calls pr.merge → teardown → setColumn in order', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [stack] });
    const callOrder: string[] = [];
    api.pr.merge.mockImplementation(async () => { callOrder.push('merge'); return { status: 'merged' }; });
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

  it('pr_open: GitHub merge failure (non-conflict) aborts teardown and column move, surfaces error', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [stack] });
    api.pr.merge.mockResolvedValueOnce({ status: 'failed', error: 'branch protection' });

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

  it('pr_open: GitHub merge failure (non-conflict) does not set conflict flag or show auto-resolve button', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [stack] });
    api.pr.merge.mockResolvedValueOnce({ status: 'failed', error: 'branch protection' });

    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-merge-42'));
    await waitFor(() => {
      expect(useAppStore.getState().moveTicketColumnError).toContain('branch protection');
    });
    expect(useAppStore.getState().mergeConflicts['42|/proj']).toBeFalsy();
    expect(screen.queryByTestId('ticket-card-auto-resolve-42')).toBeNull();
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

    let resolveMerge!: (v: { status: string }) => void;
    const mergePromise = new Promise<{ status: string }>((r) => { resolveMerge = r; });
    api.pr.merge.mockReturnValueOnce(mergePromise);

    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    const btn = screen.getByTestId('ticket-card-merge-42');
    fireEvent.click(btn);
    fireEvent.click(btn);

    await act(async () => {
      resolveMerge({ status: 'merged' });
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

  it('pr_open: Auto-resolve conflicts button is absent when there is no conflict (regression)', () => {
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-auto-resolve-42')).toBeNull();
  });

  it('pr_open: Auto-resolve conflicts button is absent when stack has no pr_number and no conflict flag', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    expect(screen.queryByTestId('ticket-card-auto-resolve-42')).toBeNull();
  });

  it('pr_open: conflict flag set → Merge button absent, auto-resolve button present', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ mergeConflicts: { [`42|${PROJECT_DIR}`]: true } } as any);
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    expect(screen.queryByTestId('ticket-card-merge-42')).toBeNull();
    expect(screen.getByTestId('ticket-card-auto-resolve-42')).toBeDefined();
  });

  it('pr_open: conflict flag set → conflict message visible in error area', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({
      mergeConflicts: { [`42|${PROJECT_DIR}`]: true },
      autoResolveErrors: { [`42|${PROJECT_DIR}`]: 'Merge failed — conflicts must be resolved' },
    } as any);
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    const badge = screen.getByTestId('ticket-card-auto-resolve-error-42');
    expect(badge.textContent).toContain('Merge failed — conflicts must be resolved');
  });

  it('pr_open: merge returns conflict → conflict flag set, auto-resolve button shown, merge button hidden', async () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'pr_created', pr_url: 'https://github.com/o/r/pull/99', pr_number: 99 } as any;
    useAppStore.setState({ boardTickets: [makeTicket('pr_open') as any], stacks: [stack] });
    api.pr.merge.mockResolvedValueOnce({ status: 'conflict' });

    const { rerender } = render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-merge-42'));
    await waitFor(() => {
      expect(useAppStore.getState().mergeConflicts['42|/proj']).toBe(true);
    });
    rerender(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[stack]} />);
    expect(screen.queryByTestId('ticket-card-merge-42')).toBeNull();
    expect(screen.getByTestId('ticket-card-auto-resolve-42')).toBeDefined();
    expect(api.stacks.teardown).not.toHaveBeenCalled();
    expect(api.ticketBoard.setColumn).not.toHaveBeenCalled();
  });

  it('pr_open: clicking Auto-resolve calls pr.autoResolve with ticketId and projectDir', async () => {
    useAppStore.setState({ mergeConflicts: { [`42|${PROJECT_DIR}`]: true } } as any);
    api.pr.autoResolve.mockResolvedValue({ status: 'resolved' });
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-auto-resolve-42'));
    await waitFor(() => expect(api.pr.autoResolve).toHaveBeenCalledWith('42', PROJECT_DIR));
  });

  it('pr_open: Auto-resolve button shows spinner while in-flight', () => {
    useAppStore.setState({
      autoResolveInFlight: { [`42|${PROJECT_DIR}`]: true },
      mergeConflicts: { [`42|${PROJECT_DIR}`]: true },
    } as any);
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-auto-resolve-42');
    expect(btn.textContent).toContain('Resolving');
    expect(btn).toHaveProperty('disabled', true);
  });

  it('pr_open: Auto-resolve button is disabled while in-flight', () => {
    useAppStore.setState({
      autoResolveInFlight: { [`42|${PROJECT_DIR}`]: true },
      mergeConflicts: { [`42|${PROJECT_DIR}`]: true },
    } as any);
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-auto-resolve-42');
    expect(btn).toHaveProperty('disabled', true);
  });

  it('pr_open: shows auto-resolve error badge when autoResolveErrors is set', () => {
    useAppStore.setState({ autoResolveErrors: { [`42|${PROJECT_DIR}`]: 'Auto-resolve failed' } } as any);
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    const badge = screen.getByTestId('ticket-card-auto-resolve-error-42');
    expect(badge.textContent).toContain('Auto-resolve failed');
  });

  it('pr_open: double-click on Auto-resolve does not call pr.autoResolve twice', async () => {
    useAppStore.setState({ mergeConflicts: { [`42|${PROJECT_DIR}`]: true } } as any);
    let resolveFirst!: () => void;
    const firstPromise = new Promise<{ status: string }>((r) => { resolveFirst = r as () => void; });
    api.pr.autoResolve.mockReturnValueOnce(firstPromise);
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-auto-resolve-42');
    fireEvent.click(btn);
    fireEvent.click(btn);
    resolveFirst({ status: 'resolved' } as any);
    await waitFor(() => expect(useAppStore.getState().autoResolveInFlight[`42|${PROJECT_DIR}`]).toBeFalsy());
    expect(api.pr.autoResolve).toHaveBeenCalledTimes(1);
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

  // =========================================================================
  // Discard (trash) icon — #446
  // =========================================================================

  it('in_stack: shows Discard button', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-discard-42')).toBeDefined();
  });

  it('pr_open: shows Discard button', () => {
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-discard-42')).toBeDefined();
  });

  it('backlog: shows Discard button', () => {
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-discard-42')).toBeDefined();
  });

  it('refining: shows Discard button', () => {
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-discard-42')).toBeDefined();
  });

  it('spec_ready: shows Discard button', () => {
    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-discard-42')).toBeDefined();
  });

  it('merged: does NOT show Discard button', () => {
    render(<TicketCard ticket={makeTicket('merged') as any} stacks={[]} />);
    expect(screen.queryByTestId('ticket-card-discard-42')).toBeNull();
  });

  it('in_stack: clicking Discard opens the discard dialog', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    expect(screen.queryByTestId('discard-stack-dialog-42')).toBeNull();
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    expect(screen.getByTestId('discard-stack-dialog-42')).toBeDefined();
  });

  it('pr_open: clicking Discard opens the discard dialog', () => {
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    expect(screen.queryByTestId('discard-stack-dialog-42')).toBeNull();
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    expect(screen.getByTestId('discard-stack-dialog-42')).toBeDefined();
  });

  it('in_stack: clicking Cancel in discard dialog closes the dialog', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    expect(screen.getByTestId('discard-stack-dialog-42')).toBeDefined();
    fireEvent.click(screen.getByTestId('discard-dialog-cancel'));
    expect(screen.queryByTestId('discard-stack-dialog-42')).toBeNull();
  });

  it('in_stack: clicking Back to backlog calls discardStack with backlog disposition', async () => {
    const discardSpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ discardStack: discardSpy } as any);
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    fireEvent.click(screen.getByTestId('discard-dialog-back-to-backlog'));
    await waitFor(() => expect(discardSpy).toHaveBeenCalledWith('42', PROJECT_DIR, 'backlog'));
  });

  it('in_stack: clicking Close ticket calls discardStack with close disposition', async () => {
    const discardSpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ discardStack: discardSpy } as any);
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    fireEvent.click(screen.getByTestId('discard-dialog-close-ticket'));
    await waitFor(() => expect(discardSpy).toHaveBeenCalledWith('42', PROJECT_DIR, 'close'));
  });

  it('in_stack: Discard button is disabled while discardInFlight is set', () => {
    useAppStore.setState({ discardInFlight: { '42|/proj': true } } as any);
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-discard-42') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // =========================================================================
  // Early-column discard (backlog / refining / spec_ready) — #462
  // =========================================================================

  it('backlog: clicking Discard opens ConfirmDialog (not DiscardStackDialog)', () => {
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    expect(screen.queryByTestId('confirm-dialog-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeDefined();
    expect(screen.queryByTestId('discard-stack-dialog-42')).toBeNull();
  });

  it('backlog: ConfirmDialog shows correct copy', () => {
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    expect(screen.getByText('Discard ticket?')).toBeDefined();
    expect(screen.getByTestId('confirm-dialog-confirm').textContent).toBe('Discard ticket');
  });

  it('backlog: cancelling ConfirmDialog closes it without calling discardStack', async () => {
    const discardSpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ discardStack: discardSpy } as any);
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(screen.queryByTestId('confirm-dialog-confirm')).toBeNull();
    await act(async () => {});
    expect(discardSpy).not.toHaveBeenCalled();
  });

  it('backlog: confirming Discard calls discardStack with close disposition and does not call cancelRefinement', async () => {
    const discardSpy = vi.fn().mockResolvedValue(undefined);
    const removeSpy = vi.fn();
    useAppStore.setState({ discardStack: discardSpy, removeRefinementSession: removeSpy } as any);
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(discardSpy).toHaveBeenCalledWith('42', PROJECT_DIR, 'close'));
    expect(api.tickets.cancelRefinement).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('spec_ready: clicking Discard opens ConfirmDialog', () => {
    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeDefined();
    expect(screen.queryByTestId('discard-stack-dialog-42')).toBeNull();
  });

  it('spec_ready: confirming Discard calls discardStack with close disposition and does not call cancelRefinement', async () => {
    const discardSpy = vi.fn().mockResolvedValue(undefined);
    const removeSpy = vi.fn();
    useAppStore.setState({ discardStack: discardSpy, removeRefinementSession: removeSpy } as any);
    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(discardSpy).toHaveBeenCalledWith('42', PROJECT_DIR, 'close'));
    expect(api.tickets.cancelRefinement).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('refining: clicking Discard opens ConfirmDialog (not DiscardStackDialog)', () => {
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeDefined();
    expect(screen.queryByTestId('discard-stack-dialog-42')).toBeNull();
  });

  it('refining: confirming Discard with no active session calls discardStack without cancelRefinement', async () => {
    const discardSpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ discardStack: discardSpy, refinementSessions: [] } as any);
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(discardSpy).toHaveBeenCalledWith('42', PROJECT_DIR, 'close'));
    expect(api.tickets.cancelRefinement).not.toHaveBeenCalled();
  });

  it('refining: confirming Discard with active session calls cancelRefinement, removeRefinementSession, then discardStack in order', async () => {
    const callOrder: string[] = [];
    const discardSpy = vi.fn().mockImplementation(async () => { callOrder.push('discard'); });
    const removeSpy = vi.fn().mockImplementation(() => { callOrder.push('remove'); });
    api.tickets.cancelRefinement.mockImplementation(async () => { callOrder.push('cancel'); });

    useAppStore.setState({
      discardStack: discardSpy,
      removeRefinementSession: removeSpy,
      refinementSessions: [{
        id: 'sess-discard',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'running',
        phase: 'check',
        startedAt: 0,
      }],
    } as any);

    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
      await Promise.resolve();
    });

    await waitFor(() => expect(discardSpy).toHaveBeenCalled());
    expect(api.tickets.cancelRefinement).toHaveBeenCalledWith('sess-discard');
    expect(removeSpy).toHaveBeenCalledWith('sess-discard');
    expect(discardSpy).toHaveBeenCalledWith('42', PROJECT_DIR, 'close');
    expect(callOrder).toEqual(['cancel', 'remove', 'discard']);
  });

  it('backlog: Discard button is disabled while discardInFlight is set', () => {
    useAppStore.setState({ discardInFlight: { '42|/proj': true } } as any);
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-discard-42') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('spec_ready: Discard button is disabled while discardInFlight is set', () => {
    useAppStore.setState({ discardInFlight: { '42|/proj': true } } as any);
    render(<TicketCard ticket={makeTicket('spec_ready') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-discard-42') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('refining: Discard button is disabled while discardInFlight is set', () => {
    useAppStore.setState({ discardInFlight: { '42|/proj': true } } as any);
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-discard-42') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // =========================================================================
  // #525 — Discard icon-only, accessibility, and error-block tests
  // =========================================================================

  it('discard icon has aria-label="Discard" on backlog column', () => {
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-discard-42');
    expect(btn.getAttribute('aria-label')).toBe('Discard');
  });

  it('discard icon has aria-label="Discard" on in_stack column', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    const btn = screen.getByTestId('ticket-card-discard-42');
    expect(btn.getAttribute('aria-label')).toBe('Discard');
  });

  it('backlog: discard control does not render visible "Discard" text', () => {
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    // The word "Discard" must not appear as visible text in the card
    expect(screen.queryByText('Discard')).toBeNull();
  });

  it('in_stack: discard control does not render visible "Discard" text', () => {
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    expect(screen.queryByText('Discard')).toBeNull();
  });

  it('getByLabelText("Discard") resolves to the same element as getByTestId for backlog', () => {
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    expect(screen.getByLabelText('Discard')).toBe(screen.getByTestId('ticket-card-discard-42'));
  });

  it('backlog: discard error block still renders in card body when discardErrors is set', () => {
    useAppStore.setState({ discardErrors: { '42|/proj': 'Something went wrong' } } as any);
    render(<TicketCard ticket={makeTicket('backlog') as any} stacks={[]} />);
    expect(screen.getByText('Something went wrong')).toBeDefined();
  });

  it('in_stack: discard error block still renders in card body when discardErrors is set', () => {
    useAppStore.setState({ discardErrors: { '42|/proj': 'Stack removal failed' } } as any);
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[]} />);
    expect(screen.getByText('Stack removal failed')).toBeDefined();
  });

  it('pr_open: discard error block still renders in card body when discardErrors is set', () => {
    useAppStore.setState({ discardErrors: { '42|/proj': 'PR discard error' } } as any);
    render(<TicketCard ticket={makeTicket('pr_open') as any} stacks={[]} />);
    expect(screen.getByText('PR discard error')).toBeDefined();
  });

  // =========================================================================
  // #539 — Error message surfaced in refine-fail badge
  // =========================================================================

  it('refining: errored session — badge shows refinementSession.error text', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-err-msg',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'errored',
        phase: 'check',
        error: 'Claude API rate limit exceeded',
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    const badge = screen.getByTestId('ticket-card-error-badge-42');
    expect(badge.textContent).toContain('Claude API rate limit exceeded');
  });

  it('refining: ready+result.error — badge shows refinementSession.result.error text', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-ready-err-msg',
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
          error: 'spec gate validation failed',
        },
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    const badge = screen.getByTestId('ticket-card-error-badge-42');
    expect(badge.textContent).toContain('spec gate validation failed');
  });

  it('refining: refineStartError only (no session) — badge shows gate-start error text', () => {
    useAppStore.setState({
      refineStartErrors: { [`42|${PROJECT_DIR}`]: 'IPC connection refused' },
      refinementSessions: [],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    const badge = screen.getByTestId('ticket-card-error-badge-42');
    expect(badge.textContent).toContain('IPC connection refused');
  });

  it('refining: interrupted session with no error field — badge falls back to "Refinement failed"', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-int-noerr',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'interrupted',
        phase: 'check',
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    const badge = screen.getByTestId('ticket-card-error-badge-42');
    expect(badge.textContent).toBe('Refinement failed');
  });

  it('refining: error badge has title attribute equal to the full message', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-title',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'errored',
        phase: 'check',
        error: 'Detailed error message here',
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    const badge = screen.getByTestId('ticket-card-error-badge-42');
    expect(badge.getAttribute('title')).toBe('Detailed error message here');
  });

  it('refining: error badge has truncation class applied', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-truncate',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'errored',
        phase: 'check',
        error: 'Some error',
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    const badge = screen.getByTestId('ticket-card-error-badge-42');
    expect(badge.classList.contains('truncate')).toBe(true);
  });

  it('refining: multiline error message renders in single badge element with full text in title', () => {
    const multilineMsg = 'Line one\nLine two\nLine three';
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-multiline',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'errored',
        phase: 'check',
        error: multilineMsg,
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    const badge = screen.getByTestId('ticket-card-error-badge-42');
    expect(badge.textContent).toBe(multilineMsg);
    expect(badge.getAttribute('title')).toBe(multilineMsg);
    // Must be a single element, not multiple
    expect(badge.tagName).toBeTruthy();
  });

  // =========================================================================
  // #510 — gap-question Answer path survives RefinementIndicator removal
  // =========================================================================

  it('refining: ready+questions — Answer button calls openRefinementSession (gap-question path works without indicator, #510)', () => {
    const session = {
      id: 'sess-510-answer',
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
    expect(useAppStore.getState().currentRefinementSessionId).toBe('sess-510-answer');
    // No discard-related IPC is ever called when the Answer button is clicked
    expect(api.tickets.cancelRefinement).not.toHaveBeenCalled();
  });

  // =========================================================================
  // #524 — Move to backlog from refining
  // =========================================================================

  it('refining: shows Move to backlog button distinct from Discard button', () => {
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    expect(screen.getByTestId('ticket-card-move-to-backlog-42')).toBeDefined();
    expect(screen.getByTestId('ticket-card-discard-42')).toBeDefined();
  });

  it('refining: clicking Move to backlog opens dialog without calling cancelRefinement or moveTicketColumn', async () => {
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-move-to-backlog-42'));
    expect(screen.getByTestId('move-to-backlog-dialog-42')).toBeDefined();
    await act(async () => {});
    expect(api.tickets.cancelRefinement).not.toHaveBeenCalled();
    expect(api.ticketBoard.setColumn).not.toHaveBeenCalled();
  });

  it('refining: confirming Move to backlog with running session calls cancelRefinement, removeRefinementSession, then moveTicketColumn(backlog) in order', async () => {
    const callOrder: string[] = [];
    const removeSpy = vi.fn().mockImplementation(() => { callOrder.push('remove'); });
    api.tickets.cancelRefinement.mockImplementation(async () => { callOrder.push('cancel'); });
    api.ticketBoard.setColumn.mockImplementation(async () => { callOrder.push('setColumn'); });

    useAppStore.setState({
      removeRefinementSession: removeSpy,
      boardTickets: [makeTicket('refining') as any],
      refinementSessions: [{
        id: 'sess-move',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'running',
        phase: 'check',
        startedAt: 0,
      }],
    } as any);

    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-move-to-backlog-42'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
      await Promise.resolve();
    });

    await waitFor(() => expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'backlog'));
    expect(api.tickets.cancelRefinement).toHaveBeenCalledWith('sess-move');
    expect(removeSpy).toHaveBeenCalledWith('sess-move');
    expect(callOrder).toEqual(['cancel', 'remove', 'setColumn']);
    expect(api.tickets.close).not.toHaveBeenCalled();
    expect(api.ticketBoard.delete).not.toHaveBeenCalled();
  });

  it('refining: confirming Move to backlog with no session skips cancelRefinement and calls moveTicketColumn(backlog)', async () => {
    useAppStore.setState({
      boardTickets: [makeTicket('refining') as any],
      refinementSessions: [],
    } as any);

    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-move-to-backlog-42'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
      await Promise.resolve();
    });

    await waitFor(() => expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'backlog'));
    expect(api.tickets.cancelRefinement).not.toHaveBeenCalled();
  });

  it('refining: cancelling Move to backlog dialog calls neither cancelRefinement nor moveTicketColumn', async () => {
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-move-to-backlog-42'));
    expect(screen.getByTestId('move-to-backlog-dialog-42')).toBeDefined();
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(screen.queryByTestId('move-to-backlog-dialog-42')).toBeNull();
    await act(async () => {});
    expect(api.tickets.cancelRefinement).not.toHaveBeenCalled();
    expect(api.ticketBoard.setColumn).not.toHaveBeenCalled();
  });

  it('refining: Discard button still opens close-ticket dialog after adding Move to backlog (regression)', async () => {
    const discardSpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ discardStack: discardSpy, refinementSessions: [] } as any);
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    fireEvent.click(screen.getByTestId('ticket-card-discard-42'));
    expect(screen.queryByTestId('move-to-backlog-dialog-42')).toBeNull();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(discardSpy).toHaveBeenCalledWith('42', PROJECT_DIR, 'close'));
  });

  it('in_stack: shows Resume button for completed stack with latest_task_token_limited=true', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', latest_task_token_limited: true, pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.getByTestId('ticket-card-resume-completed-42')).toBeDefined();
  });

  it('in_stack: does not show Resume button for completed stack with latest_task_token_limited=false', () => {
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', latest_task_token_limited: false, pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    expect(screen.queryByTestId('ticket-card-resume-completed-42')).toBeNull();
  });

  it('in_stack: calling Resume on completed token-limited stack calls recheckCompletedStack', async () => {
    const recheckFn = vi.fn().mockResolvedValue({ outcome: 'resuming_with_session' });
    useAppStore.setState({ recheckCompletedStack: recheckFn } as any);
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', latest_task_token_limited: true, pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-resume-completed-42'));
    await waitFor(() => expect(recheckFn).toHaveBeenCalledWith('s1'));
  });

  it('in_stack: not_token_limited outcome shows "completed normally" message', async () => {
    const recheckFn = vi.fn().mockResolvedValue({ outcome: 'not_token_limited' });
    useAppStore.setState({ recheckCompletedStack: recheckFn } as any);
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', latest_task_token_limited: true, pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-resume-completed-42'));
    await waitFor(() => {
      expect(screen.getByText('No interrupted work found — stack completed normally.')).toBeDefined();
    });
  });

  it('in_stack: container_gone outcome shows appropriate message', async () => {
    const recheckFn = vi.fn().mockResolvedValue({ outcome: 'container_gone' });
    useAppStore.setState({ recheckCompletedStack: recheckFn } as any);
    const stack = { id: 's1', ticket: '42', project_dir: PROJECT_DIR, status: 'completed', latest_task_token_limited: true, pr_url: null, pr_number: null } as any;
    render(<TicketCard ticket={makeTicket('in_stack') as any} stacks={[stack]} />);
    fireEvent.click(screen.getByTestId('ticket-card-resume-completed-42'));
    await waitFor(() => {
      expect(screen.getByText('Container not running — cannot verify log.')).toBeDefined();
    });
  });

  it('refining: running session — no session-destructive IPC call is made (#510)', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'sess-510-running',
        ticketId: '42',
        projectDir: PROJECT_DIR,
        status: 'running',
        phase: 'check',
        startedAt: 0,
      }],
    });
    render(<TicketCard ticket={makeTicket('refining') as any} stacks={[]} />);
    // Progress bar visible — no actionable buttons that could destroy the session
    expect(screen.queryByTestId('ticket-card-answer-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-retry-42')).toBeNull();
    expect(screen.queryByTestId('ticket-card-start-refine-42')).toBeNull();
    // No IPC calls that could destroy the running session
    expect(api.tickets.cancelRefinement).not.toHaveBeenCalled();
  });
});
