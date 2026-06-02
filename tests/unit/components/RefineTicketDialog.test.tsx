/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RefineTicketDialog, formatElapsed } from '../../../src/renderer/components/RefineTicketDialog';
import { useAppStore, type RefineQuestion } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

const MULTI_OPT_QUESTIONS: RefineQuestion[] = [
  {
    id: 'q1',
    question: 'What is X?',
    options: [
      { id: 'a', label: 'Option A' },
      { id: 'b', label: 'Option B' },
    ],
  },
  {
    id: 'q2',
    question: 'What is Y?',
    options: [
      { id: 'a', label: 'Yes' },
      { id: 'b', label: 'No' },
    ],
  },
];

const SINGLE_OPT_QUESTION: RefineQuestion[] = [
  {
    id: 'q1',
    question: 'What is X?',
    options: [
      { id: 'a', label: 'Option A' },
      { id: 'b', label: 'Option B' },
    ],
  },
];

describe('RefineTicketDialog', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
      showRefineTicketDialog: true,
      refineTicketPrefill: null,
      refinementSessions: [],
      currentRefinementSessionId: null,
      stacks: [],
      refineAnswerDrafts: {},
    } as any);
    // Default: specCheckAsync returns a sessionId immediately
    api.tickets.specCheckAsync = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
    api.tickets.specRefineAsync = vi.fn().mockResolvedValue(undefined);
    api.tickets.cancelRefinement = vi.fn().mockResolvedValue(undefined);
    api.tickets.listRefinements = vi.fn().mockResolvedValue([]);
  });

  it('renders the dialog with ticket id input when no session', () => {
    render(<RefineTicketDialog />);
    expect(screen.getByText('Refine Ticket')).toBeDefined();
    expect(screen.getByTestId('refine-ticket-id')).toBeDefined();
  });

  it('Run Gate button is disabled until ticket id is entered', () => {
    render(<RefineTicketDialog />);
    const btn = screen.getByTestId('refine-run-gate');
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('closes dialog when Dismiss/Cancel is clicked (no session)', () => {
    render(<RefineTicketDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
  });

  it('clicking Run Gate calls specCheckAsync and sets currentRefinementSessionId', async () => {
    const user = userEvent.setup();
    render(<RefineTicketDialog />);
    await user.type(screen.getByTestId('refine-ticket-id'), '310');
    fireEvent.click(screen.getByTestId('refine-run-gate'));

    await waitFor(() => {
      expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('310', '/proj');
    });
    await waitFor(() => {
      expect(useAppStore.getState().currentRefinementSessionId).toBe('session-1');
    });
  });

  it('shows running state when session status is running', async () => {
    const user = userEvent.setup();
    render(<RefineTicketDialog />);
    await user.type(screen.getByTestId('refine-ticket-id'), '310');

    // Inject running session before clicking Run Gate
    api.tickets.specCheckAsync = vi.fn().mockImplementation(async () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'running', phase: 'check', startedAt: Date.now(),
        }],
      });
      return { sessionId: 'session-1' };
    });

    fireEvent.click(screen.getByTestId('refine-run-gate'));

    await waitFor(() => {
      expect(screen.getByTestId('refine-running')).toBeDefined();
    });
  });

  it('dismissing the dialog while running keeps session alive in store', async () => {
    // Pre-populate a running session
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'running', phase: 'check', startedAt: Date.now(),
      }],
      currentRefinementSessionId: 'session-1',
    });

    render(<RefineTicketDialog />);
    // The X / Dismiss button closes the dialog but keeps the session
    fireEvent.click(screen.getByLabelText('Close'));

    expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
    expect(useAppStore.getState().refinementSessions).toHaveLength(1);
    expect(useAppStore.getState().refinementSessions[0].status).toBe('running');
  });

  it('shows pass state when session is ready and gate passed', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: {
          passed: true, questions: [], gateSummary: 'Gate=PASS, questions=0',
          ticketUrl: 'https://github.com/o/r/issues/310', cached: false,
        },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    expect(screen.getByTestId('refine-pass')).toBeDefined();
    expect(screen.getByTestId('refine-start-stack')).toBeDefined();
    const nameInput = screen.getByTestId('refine-stack-name') as HTMLInputElement;
    expect(nameInput.value).toBe('ticket-310');
  });

  it('shows fail state with question form when gate failed with questions', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: {
          passed: false,
          questions: MULTI_OPT_QUESTIONS,
          gateSummary: 'Gate=FAIL, questions=2',
          ticketUrl: null, cached: false,
        },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    expect(screen.getByTestId('refine-fail')).toBeDefined();
    expect(screen.getByText('What is X?')).toBeDefined();
    expect(screen.getByTestId('refine-answer-0')).toBeDefined();
    expect(screen.getByTestId('refine-answer-1')).toBeDefined();
    const submit = screen.getByTestId('refine-submit-answers');
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('renders radio buttons for each option per question', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: {
          passed: false,
          questions: MULTI_OPT_QUESTIONS,
          gateSummary: 'Gate=FAIL, questions=2',
          ticketUrl: null, cached: false,
        },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    // 2 options per question × 2 questions = 4 radio inputs
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    // 1 textarea per question = 2 textareas
    const textareas = screen.getAllByRole('textbox');
    expect(textareas).toHaveLength(2);
  });

  it('submit is enabled when an option is selected (no text required)', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: {
          passed: false,
          questions: MULTI_OPT_QUESTIONS,
          gateSummary: 'Gate=FAIL, questions=2',
          ticketUrl: null, cached: false,
        },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    const submit = screen.getByTestId('refine-submit-answers');
    expect(submit.hasAttribute('disabled')).toBe(true);

    // Select one option for q1 — submit still disabled (q2 unanswered)
    await user.click(screen.getByTestId('refine-option-0-a'));
    expect(submit.hasAttribute('disabled')).toBe(true);

    // Select one option for q2 — now both answered, submit enabled
    await user.click(screen.getByTestId('refine-option-1-a'));
    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('submit is enabled when additional context text is provided (no option required)', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: {
          passed: false,
          questions: MULTI_OPT_QUESTIONS,
          gateSummary: 'Gate=FAIL, questions=2',
          ticketUrl: null, cached: false,
        },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    const submit = screen.getByTestId('refine-submit-answers');

    // Type text into both textareas
    await user.type(screen.getByTestId('refine-answer-0'), 'custom detail for q1');
    await user.type(screen.getByTestId('refine-answer-1'), 'custom detail for q2');
    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('shows Run Gate button when gate failed with zero questions and calls specCheckAsync on click', async () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: {
          passed: false,
          questions: [],
          gateSummary: 'Gate=FAIL, questions=0',
          ticketUrl: null, cached: false,
        },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    expect(screen.getByTestId('refine-fail')).toBeDefined();
    const runGateBtn = screen.getByTestId('refine-run-gate');
    expect(runGateBtn).toBeDefined();

    fireEvent.click(runGateBtn);

    await waitFor(() => {
      expect(api.tickets.cancelRefinement).toHaveBeenCalledWith('session-1');
    });
    await waitFor(() => {
      expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('310', '/proj');
    });
  });

  it('calls specRefineAsync with formatted Q/Selected/Additional serialization when option selected', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: {
          passed: false,
          questions: SINGLE_OPT_QUESTION,
          gateSummary: 'Gate=FAIL, questions=1',
          ticketUrl: null, cached: false,
        },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    // Select option A and add extra context
    await user.click(screen.getByTestId('refine-option-0-a'));
    await user.type(screen.getByTestId('refine-answer-0'), 'extra detail');
    fireEvent.click(screen.getByTestId('refine-submit-answers'));

    await waitFor(() => {
      expect(api.tickets.specRefineAsync).toHaveBeenCalledWith(
        'session-1',
        '310',
        '/proj',
        expect.stringContaining('Q1: What is X?'),
      );
    });
    await waitFor(() => {
      const call = (api.tickets.specRefineAsync as ReturnType<typeof vi.fn>).mock.calls[0];
      const body: string = call[3];
      expect(body).toContain('Selected: Option A');
      expect(body).toContain('Additional context: extra detail');
    });
  });

  it('calls specRefineAsync with (none) selected when only text is provided', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: {
          passed: false,
          questions: SINGLE_OPT_QUESTION,
          gateSummary: 'Gate=FAIL, questions=1',
          ticketUrl: null, cached: false,
        },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    await user.type(screen.getByTestId('refine-answer-0'), 'X is foo');
    fireEvent.click(screen.getByTestId('refine-submit-answers'));

    await waitFor(() => {
      const call = (api.tickets.specRefineAsync as ReturnType<typeof vi.fn>).mock.calls[0];
      const body: string = call[3];
      expect(body).toContain('Q1: What is X?');
      expect(body).toContain('Selected: (none)');
      expect(body).toContain('Additional context: X is foo');
    });
  });

  it('shows error state when session is errored', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'errored', phase: 'check', startedAt: Date.now(),
        error: 'gh rate limit',
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    expect(screen.getByTestId('refine-error').textContent).toMatch(/gh rate limit/);
    expect(screen.getByTestId('refine-retry')).toBeDefined();
  });

  it('shows interrupted state with retry button', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'interrupted', phase: 'check', startedAt: Date.now(),
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    expect(screen.getByTestId('refine-interrupted')).toBeDefined();
    expect(screen.getByTestId('refine-retry')).toBeDefined();
  });

  it('shows cancel confirmation and calls cancelRefinement on confirm', async () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'running', phase: 'check', startedAt: Date.now(),
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    fireEvent.click(screen.getByTestId('refine-cancel-btn'));

    expect(screen.getByTestId('refine-cancel-confirm')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByTestId('refine-cancel-confirm-btn'));
    });

    await waitFor(() => {
      expect(api.tickets.cancelRefinement).toHaveBeenCalledWith('session-1');
    });
    expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
    expect(useAppStore.getState().refinementSessions).toHaveLength(0);
  });

  it('calls stacks.create and removes session after Start Stack', async () => {
    api.tickets.fetch.mockResolvedValue({ body: '# Issue: Refine ticket\n\nbody text', url: null });
    api.stacks.create.mockResolvedValue({ id: 'ticket-310', project: 'proj', status: 'building', services: [] });

    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: { passed: true, questions: [], gateSummary: 'Gate=PASS', ticketUrl: null, cached: false },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    // stack name is auto-populated; click start
    fireEvent.click(screen.getByTestId('refine-start-stack'));

    await waitFor(() => {
      expect(api.stacks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ticket-310',
          projectDir: '/proj',
          ticket: '310',
          task: '# Issue: Refine ticket\n\nbody text',
          gateApproved: true,
        }),
      );
    });
    expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
    expect(useAppStore.getState().refinementSessions).toHaveLength(0);
  });

  // #388: Refine-dialog "Start Stack" must move the ticket column to 'in_stack'.
  // Before the fix, handleStartStack created the stack but never called
  // moveTicketColumn — leaving the ticket visually stuck in spec_ready/backlog.
  it('persists in_stack column after Start Stack succeeds (#388)', async () => {
    api.tickets.fetch.mockResolvedValue({ body: '# title\nbody', url: null });
    api.stacks.create.mockResolvedValue({ id: 'ticket-310', project: 'proj', status: 'building', services: [] });

    useAppStore.setState({
      boardTickets: [
        { ticket_id: '310', project_dir: '/proj', column: 'spec_ready', title: 'T', updated_at: '' },
      ],
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: { passed: true, questions: [], gateSummary: 'Gate=PASS', ticketUrl: null, cached: false },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    fireEvent.click(screen.getByTestId('refine-start-stack'));

    await waitFor(() => {
      expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('310', '/proj', 'in_stack');
    });
    await waitFor(() => {
      const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '310');
      expect(entry?.column).toBe('in_stack');
    });
  });

  it('shows the cached banner copy when gate result is cached', () => {
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: { passed: true, questions: [], gateSummary: 'cached', ticketUrl: null, cached: true },
      }],
      currentRefinementSessionId: 'session-1',
    });
    render(<RefineTicketDialog />);
    expect(screen.getByText(/already passed/i)).toBeDefined();
  });

  describe('prefill hand-off (#317)', () => {
    it('auto-runs the gate when opened with a prefill', async () => {
      useAppStore.setState({ refineTicketPrefill: '77' });
      render(<RefineTicketDialog />);

      await waitFor(() => {
        expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('77', '/proj');
      });
    });

    it('clears the prefill after consuming it', () => {
      useAppStore.setState({ refineTicketPrefill: '77' });
      render(<RefineTicketDialog />);
      expect(useAppStore.getState().refineTicketPrefill).toBeNull();
    });

    it('does NOT auto-run when there is no prefill', () => {
      useAppStore.setState({ refineTicketPrefill: null });
      render(<RefineTicketDialog />);
      expect(api.tickets.specCheckAsync).not.toHaveBeenCalled();
    });

    it('opening via Answer path (existing session, no prefill) does not call specCheckAsync', async () => {
      useAppStore.setState({
        refineTicketPrefill: null,
        currentRefinementSessionId: 'sess-answer',
        refinementSessions: [{
          id: 'sess-answer',
          ticketId: '42',
          projectDir: '/proj',
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
        }],
      });

      render(<RefineTicketDialog />);

      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

      expect(api.tickets.specCheckAsync).not.toHaveBeenCalled();
    });

    it('re-refinement Run-Gate path still calls specCheckAsync', async () => {
      useAppStore.setState({
        refineTicketPrefill: null,
        currentRefinementSessionId: 'sess-ready',
        refinementSessions: [{
          id: 'sess-ready',
          ticketId: '310',
          projectDir: '/proj',
          status: 'ready' as const,
          phase: 'check' as const,
          result: {
            passed: false,
            questions: [],
            gateSummary: 'Gate=FAIL, questions=0',
            ticketUrl: null,
            cached: false,
          },
          startedAt: 0,
        }],
      });

      render(<RefineTicketDialog />);
      fireEvent.click(screen.getByTestId('refine-run-gate'));

      await waitFor(() => {
        expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('310', '/proj');
      });
    });
  });

  describe('elapsed timer (#370)', () => {
    it('formatElapsed formats whole seconds as MM:SS', () => {
      expect(formatElapsed(0)).toBe('00:00');
      expect(formatElapsed(999)).toBe('00:00');
      expect(formatElapsed(1_000)).toBe('00:01');
      expect(formatElapsed(59_000)).toBe('00:59');
      expect(formatElapsed(60_000)).toBe('01:00');
      expect(formatElapsed(125_000)).toBe('02:05');
      expect(formatElapsed(3_600_000)).toBe('60:00');
    });

    it('clamps negative inputs to 00:00', () => {
      expect(formatElapsed(-1)).toBe('00:00');
      expect(formatElapsed(-99_999)).toBe('00:00');
    });

    it('renders the elapsed timer next to "Running spec gate…" while running', () => {
      const start = Date.now() - 7_000; // 7s ago
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'running', phase: 'check', startedAt: start,
        }],
        currentRefinementSessionId: 'session-1',
      });
      render(<RefineTicketDialog />);
      const timer = screen.getByTestId('refine-elapsed-timer');
      // Timer should be present and show a MM:SS value.
      expect(timer.textContent).toMatch(/^\d{2}:\d{2}$/);
    });

    it('does not render the elapsed timer once the session transitions to ready', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'ready', phase: 'check', startedAt: Date.now(),
          result: { passed: true, questions: [], gateSummary: '', ticketUrl: null, cached: false },
        }],
        currentRefinementSessionId: 'session-1',
      });
      render(<RefineTicketDialog />);
      expect(screen.queryByTestId('refine-elapsed-timer')).toBeNull();
    });
  });

  describe('streaming output panel', () => {
    it('shows the stream panel when session is running', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'running', phase: 'check', startedAt: Date.now(),
        }],
        currentRefinementSessionId: 'session-1',
      });
      render(<RefineTicketDialog />);
      expect(screen.getByTestId('refine-stream-panel')).toBeDefined();
    });

    it('renders streamed text in the panel', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'running', phase: 'check', startedAt: Date.now(),
          streamingOutput: 'Evaluating spec quality…\nChecking scope…',
        }],
        currentRefinementSessionId: 'session-1',
      });
      render(<RefineTicketDialog />);
      const panel = screen.getByTestId('refine-stream-panel');
      expect(panel.textContent).toContain('Evaluating spec quality');
    });

    it('shows placeholder when streamingOutput is empty', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'running', phase: 'check', startedAt: Date.now(),
          streamingOutput: '',
        }],
        currentRefinementSessionId: 'session-1',
      });
      render(<RefineTicketDialog />);
      expect(screen.getByText('Waiting for output…')).toBeDefined();
    });

    it('does not show the stream panel when session is ready (pass)', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'ready', phase: 'check', startedAt: Date.now(),
          result: { passed: true, questions: [], gateSummary: '', ticketUrl: null, cached: false },
        }],
        currentRefinementSessionId: 'session-1',
      });
      render(<RefineTicketDialog />);
      expect(screen.queryByTestId('refine-stream-panel')).toBeNull();
    });

    it('renders indicator lines (→ prefix) with italic + dimmer styling', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'running', phase: 'check', startedAt: Date.now(),
          streamingOutput: 'Evaluating spec…\n→ Read(src/main/foo.ts)\nDone.',
        }],
        currentRefinementSessionId: 'session-1',
      });
      render(<RefineTicketDialog />);
      const panel = screen.getByTestId('refine-stream-panel');
      // The indicator line should be present in the panel text
      expect(panel.textContent).toContain('→ Read(src/main/foo.ts)');
      // Find the span containing the indicator line and verify it has the dimmer class
      const spans = panel.querySelectorAll('span');
      const indicatorSpan = Array.from(spans).find((s) =>
        s.textContent?.includes('→ Read(src/main/foo.ts)'),
      );
      expect(indicatorSpan).toBeDefined();
      expect(indicatorSpan!.className).toContain('opacity-50');
      expect(indicatorSpan!.className).toContain('italic');
    });

    it('renders prose lines without indicator styling', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'running', phase: 'check', startedAt: Date.now(),
          streamingOutput: 'Evaluating spec quality…',
        }],
        currentRefinementSessionId: 'session-1',
      });
      render(<RefineTicketDialog />);
      const panel = screen.getByTestId('refine-stream-panel');
      const spans = panel.querySelectorAll('span');
      const proseSpan = Array.from(spans).find((s) =>
        s.textContent?.includes('Evaluating spec quality…'),
      );
      expect(proseSpan).toBeDefined();
      // Prose spans have no className (undefined → no dimming/italic)
      expect(proseSpan!.className || '').not.toContain('opacity-50');
      expect(proseSpan!.className || '').not.toContain('italic');
    });
  });

  describe('appendRefinementStreamChunk store action', () => {
    it('appends delta to streamingOutput for a running session', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'sess', ticketId: '1', projectDir: '/p',
          status: 'running', phase: 'check', startedAt: 0,
          streamingOutput: 'hello ',
        }],
      });
      useAppStore.getState().appendRefinementStreamChunk('sess', 'world');
      const s = useAppStore.getState().refinementSessions[0];
      expect(s.streamingOutput).toBe('hello world');
    });

    it('ignores delta for a non-running session', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'sess', ticketId: '1', projectDir: '/p',
          status: 'ready', phase: 'check', startedAt: 0,
        }],
      });
      useAppStore.getState().appendRefinementStreamChunk('sess', 'ignored');
      const s = useAppStore.getState().refinementSessions[0];
      expect(s.streamingOutput).toBeUndefined();
    });

    it('ignores delta for unknown session id', () => {
      useAppStore.setState({ refinementSessions: [] });
      expect(() => useAppStore.getState().appendRefinementStreamChunk('unknown', 'x')).not.toThrow();
    });
  });

  describe('refining column wiring (#393)', () => {
    beforeEach(() => {
      useAppStore.setState({
        boardTickets: [
          { ticket_id: '310', project_dir: '/proj', column: 'backlog', title: 'T', updated_at: '' },
        ],
        stacks: [],
      });
    });

    it('Run Gate moves ticket to refining silently when no live stack', async () => {
      const user = userEvent.setup();
      render(<RefineTicketDialog />);
      await user.type(screen.getByTestId('refine-ticket-id'), '310');
      fireEvent.click(screen.getByTestId('refine-run-gate'));

      await waitFor(() => {
        expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('310', '/proj', 'refining');
      });
      await waitFor(() => {
        expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('310', '/proj');
      });
    });

    it('Run Gate stores _refineDialogContext for revert-on-cancel', async () => {
      const user = userEvent.setup();
      render(<RefineTicketDialog />);
      await user.type(screen.getByTestId('refine-ticket-id'), '310');
      fireEvent.click(screen.getByTestId('refine-run-gate'));

      await waitFor(() => {
        const ctx = useAppStore.getState()._refineDialogContext;
        expect(ctx).not.toBeNull();
        expect(ctx?.ticketId).toBe('310');
        expect(ctx?.projectDir).toBe('/proj');
        expect(ctx?.previousColumn).toBe('backlog');
      });
    });

    it('closing dialog after Run Gate with no session reverts column to previousColumn', async () => {
      const user = userEvent.setup();
      render(<RefineTicketDialog />);
      await user.type(screen.getByTestId('refine-ticket-id'), '310');
      fireEvent.click(screen.getByTestId('refine-run-gate'));

      // Wait for context to be stashed
      await waitFor(() => {
        expect(useAppStore.getState()._refineDialogContext).not.toBeNull();
      });

      // Close dialog (no session exists — gate returned sessionId but no session in store yet)
      useAppStore.setState({ refinementSessions: [] });
      fireEvent.click(screen.getByLabelText('Close'));

      await waitFor(() => {
        expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('310', '/proj', 'backlog');
      });
    });

    it('shows teardown confirmation modal when live stack exists', async () => {
      useAppStore.setState({
        stacks: [{
          id: 'stack-42', project: 'proj', project_dir: '/proj', ticket: '310',
          branch: null, description: null, status: 'running', error: null,
          pr_url: null, pr_number: null, runtime: 'docker' as const,
          total_input_tokens: 0, total_output_tokens: 0,
          total_execution_input_tokens: 0, total_execution_output_tokens: 0,
          total_review_input_tokens: 0, total_review_output_tokens: 0,
          rate_limit_reset_at: null, created_at: '', updated_at: '',
          current_model: null, services: [],
        }],
      });
      const user = userEvent.setup();
      render(<RefineTicketDialog />);
      await user.type(screen.getByTestId('refine-ticket-id'), '310');
      fireEvent.click(screen.getByTestId('refine-run-gate'));

      await waitFor(() => {
        expect(screen.getByTestId('refine-teardown-confirm-dialog')).toBeDefined();
      });
      // Gate must NOT have been started yet
      expect(api.tickets.specCheckAsync).not.toHaveBeenCalled();
    });

    it('confirming teardown modal calls stacks.teardown and starts gate', async () => {
      useAppStore.setState({
        stacks: [{
          id: 'stack-42', project: 'proj', project_dir: '/proj', ticket: '310',
          branch: null, description: null, status: 'running', error: null,
          pr_url: null, pr_number: null, runtime: 'docker' as const,
          total_input_tokens: 0, total_output_tokens: 0,
          total_execution_input_tokens: 0, total_execution_output_tokens: 0,
          total_review_input_tokens: 0, total_review_output_tokens: 0,
          rate_limit_reset_at: null, created_at: '', updated_at: '',
          current_model: null, services: [],
        }],
      });
      const user = userEvent.setup();
      render(<RefineTicketDialog />);
      await user.type(screen.getByTestId('refine-ticket-id'), '310');
      fireEvent.click(screen.getByTestId('refine-run-gate'));

      await waitFor(() => screen.getByTestId('refine-teardown-confirm-dialog'));

      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

      await waitFor(() => {
        expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('310', '/proj', 'refining');
      });
      await waitFor(() => {
        expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('310', '/proj');
      });
      await waitFor(() => {
        expect(api.stacks.teardown).toHaveBeenCalledWith('stack-42');
      });
    });

    it('cancelling teardown modal aborts — no move, no gate, no teardown', async () => {
      useAppStore.setState({
        stacks: [{
          id: 'stack-42', project: 'proj', project_dir: '/proj', ticket: '310',
          branch: null, description: null, status: 'running', error: null,
          pr_url: null, pr_number: null, runtime: 'docker' as const,
          total_input_tokens: 0, total_output_tokens: 0,
          total_execution_input_tokens: 0, total_execution_output_tokens: 0,
          total_review_input_tokens: 0, total_review_output_tokens: 0,
          rate_limit_reset_at: null, created_at: '', updated_at: '',
          current_model: null, services: [],
        }],
      });
      const user = userEvent.setup();
      render(<RefineTicketDialog />);
      await user.type(screen.getByTestId('refine-ticket-id'), '310');
      fireEvent.click(screen.getByTestId('refine-run-gate'));

      await waitFor(() => screen.getByTestId('refine-teardown-confirm-dialog'));

      fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

      await waitFor(() => {
        expect(screen.queryByTestId('refine-teardown-confirm-dialog')).toBeNull();
      });
      expect(api.ticketBoard.setColumn).not.toHaveBeenCalled();
      expect(api.tickets.specCheckAsync).not.toHaveBeenCalled();
      expect(api.stacks.teardown).not.toHaveBeenCalled();
    });

    it('shows error when multiple stacks match ticket+project', async () => {
      const stackBase = {
        branch: null, description: null, status: 'running', error: null,
        pr_url: null, pr_number: null, runtime: 'docker' as const,
        total_input_tokens: 0, total_output_tokens: 0,
        total_execution_input_tokens: 0, total_execution_output_tokens: 0,
        total_review_input_tokens: 0, total_review_output_tokens: 0,
        rate_limit_reset_at: null, created_at: '', updated_at: '',
        current_model: null, services: [],
      };
      useAppStore.setState({
        stacks: [
          { ...stackBase, id: 'stack-a', project: 'proj', project_dir: '/proj', ticket: '310' },
          { ...stackBase, id: 'stack-b', project: 'proj', project_dir: '/proj', ticket: '310' },
        ],
      });
      const user = userEvent.setup();
      render(<RefineTicketDialog />);
      await user.type(screen.getByTestId('refine-ticket-id'), '310');
      fireEvent.click(screen.getByTestId('refine-run-gate'));

      await waitFor(() => {
        expect(screen.getByTestId('refine-error').textContent).toMatch(/Multiple stacks/);
      });
      expect(api.stacks.teardown).not.toHaveBeenCalled();
    });

    it('does not trigger teardown modal for stack in different project', async () => {
      useAppStore.setState({
        stacks: [{
          id: 'stack-other', project: 'other', project_dir: '/other', ticket: '310',
          branch: null, description: null, status: 'running', error: null,
          pr_url: null, pr_number: null, runtime: 'docker' as const,
          total_input_tokens: 0, total_output_tokens: 0,
          total_execution_input_tokens: 0, total_execution_output_tokens: 0,
          total_review_input_tokens: 0, total_review_output_tokens: 0,
          rate_limit_reset_at: null, created_at: '', updated_at: '',
          current_model: null, services: [],
        }],
      });
      const user = userEvent.setup();
      render(<RefineTicketDialog />);
      await user.type(screen.getByTestId('refine-ticket-id'), '310');
      fireEvent.click(screen.getByTestId('refine-run-gate'));

      await waitFor(() => {
        expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('310', '/proj');
      });
      expect(screen.queryByTestId('refine-teardown-confirm-dialog')).toBeNull();
      expect(api.stacks.teardown).not.toHaveBeenCalled();
    });

    it('idempotent: already in refining — moves column but shows no teardown modal', async () => {
      useAppStore.setState({
        boardTickets: [
          { ticket_id: '310', project_dir: '/proj', column: 'refining', title: 'T', updated_at: '' },
        ],
        stacks: [{
          id: 'stack-42', project: 'proj', project_dir: '/proj', ticket: '310',
          branch: null, description: null, status: 'running', error: null,
          pr_url: null, pr_number: null, runtime: 'docker' as const,
          total_input_tokens: 0, total_output_tokens: 0,
          total_execution_input_tokens: 0, total_execution_output_tokens: 0,
          total_review_input_tokens: 0, total_review_output_tokens: 0,
          rate_limit_reset_at: null, created_at: '', updated_at: '',
          current_model: null, services: [],
        }],
      });
      const user = userEvent.setup();
      render(<RefineTicketDialog />);
      await user.type(screen.getByTestId('refine-ticket-id'), '310');
      fireEvent.click(screen.getByTestId('refine-run-gate'));

      await waitFor(() => {
        expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('310', '/proj');
      });
      expect(screen.queryByTestId('refine-teardown-confirm-dialog')).toBeNull();
      expect(api.stacks.teardown).not.toHaveBeenCalled();
    });
  });

  describe('prefill hand-off with refining column (#393)', () => {
    beforeEach(() => {
      useAppStore.setState({
        boardTickets: [
          { ticket_id: '77', project_dir: '/proj', column: 'backlog', title: 'T', updated_at: '' },
        ],
        stacks: [],
      });
    });

    it('auto-runs gate and moves to refining when opened with a prefill (no live stack)', async () => {
      useAppStore.setState({ refineTicketPrefill: '77' });
      render(<RefineTicketDialog />);

      await waitFor(() => {
        expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('77', '/proj', 'refining');
      });
      await waitFor(() => {
        expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('77', '/proj');
      });
    });

    it('shows teardown modal when prefill ticket has a live stack', async () => {
      useAppStore.setState({
        refineTicketPrefill: '77',
        stacks: [{
          id: 'stack-77', project: 'proj', project_dir: '/proj', ticket: '77',
          branch: null, description: null, status: 'running', error: null,
          pr_url: null, pr_number: null, runtime: 'docker' as const,
          total_input_tokens: 0, total_output_tokens: 0,
          total_execution_input_tokens: 0, total_execution_output_tokens: 0,
          total_review_input_tokens: 0, total_review_output_tokens: 0,
          rate_limit_reset_at: null, created_at: '', updated_at: '',
          current_model: null, services: [],
        }],
      });
      render(<RefineTicketDialog />);

      await waitFor(() => {
        expect(screen.getByTestId('refine-teardown-confirm-dialog')).toBeDefined();
      });
      expect(api.tickets.specCheckAsync).not.toHaveBeenCalled();
    });

    it('confirming teardown from prefill path starts gate and tears down stack', async () => {
      useAppStore.setState({
        refineTicketPrefill: '77',
        stacks: [{
          id: 'stack-77', project: 'proj', project_dir: '/proj', ticket: '77',
          branch: null, description: null, status: 'running', error: null,
          pr_url: null, pr_number: null, runtime: 'docker' as const,
          total_input_tokens: 0, total_output_tokens: 0,
          total_execution_input_tokens: 0, total_execution_output_tokens: 0,
          total_review_input_tokens: 0, total_review_output_tokens: 0,
          rate_limit_reset_at: null, created_at: '', updated_at: '',
          current_model: null, services: [],
        }],
      });
      render(<RefineTicketDialog />);

      await waitFor(() => screen.getByTestId('refine-teardown-confirm-dialog'));
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

      await waitFor(() => {
        expect(api.ticketBoard.setColumn).toHaveBeenCalledWith('77', '/proj', 'refining');
      });
      await waitFor(() => {
        expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('77', '/proj');
      });
      await waitFor(() => {
        expect(api.stacks.teardown).toHaveBeenCalledWith('stack-77');
      });
    });
  });

  describe('openRefineDialogFromCard background flow (#424)', () => {
    // With the background refine flow, clicking Refine on a backlog card:
    // - moves the ticket to 'refining' optimistically
    // - starts the gate via specCheckAsync WITHOUT opening the dialog
    // - dialog is only opened when the user clicks "Answer" on the refining card
    it('starts gate in background without opening dialog, stashes _refineDialogContext', async () => {
      useAppStore.setState({
        boardTickets: [
          { ticket_id: '42', project_dir: '/proj', column: 'backlog', title: 'T', updated_at: '' },
        ],
        stacks: [],
        showRefineTicketDialog: false,
        refineTicketPrefill: null,
        currentRefinementSessionId: null,
        _refineDialogContext: null,
        refineInFlight: {},
        refineStartErrors: {},
      });

      useAppStore.getState().openRefineDialogFromCard('42', '/proj', 'backlog');

      // Dialog is NOT opened — backgrounding path suppresses modal
      expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
      expect(useAppStore.getState().refineTicketPrefill).toBeNull();

      // Context is stashed with the real previous column for potential Answer flow
      expect(useAppStore.getState()._refineDialogContext?.previousColumn).toBe('backlog');

      // Gate was started via specCheckAsync
      await waitFor(() => {
        expect(api.tickets.specCheckAsync).toHaveBeenCalledWith('42', '/proj');
      });
    });
  });

  describe('recommended option badge and preselection (#421)', () => {
    const RECOMMENDED_QUESTIONS: RefineQuestion[] = [
      {
        id: 'q1',
        question: 'What is X?',
        options: [
          { id: 'a', label: 'Option A', recommended: true },
          { id: 'b', label: 'Option B' },
        ],
      },
      {
        id: 'q2',
        question: 'What is Y?',
        options: [
          { id: 'a', label: 'Yes' },
          { id: 'b', label: 'No' },
        ],
      },
    ];

    const MULTI_RECOMMENDED_QUESTION: RefineQuestion[] = [
      {
        id: 'q1',
        question: 'Pick one?',
        options: [
          { id: 'a', label: 'Option A', recommended: true },
          { id: 'b', label: 'Option B', recommended: true },
        ],
      },
    ];

    function setupFailState(questions: RefineQuestion[]) {
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'ready', phase: 'check', startedAt: Date.now(),
          result: {
            passed: false,
            questions,
            gateSummary: `Gate=FAIL, questions=${questions.length}`,
            ticketUrl: null, cached: false,
          },
        }],
        currentRefinementSessionId: 'session-1',
      });
    }

    it('renders Recommended badge next to the flagged option only', () => {
      setupFailState(RECOMMENDED_QUESTIONS);
      render(<RefineTicketDialog />);
      expect(screen.getByTestId('refine-option-recommended-0-a')).toBeDefined();
      expect(screen.queryByTestId('refine-option-recommended-0-b')).toBeNull();
      expect(screen.queryByTestId('refine-option-recommended-1-a')).toBeNull();
      expect(screen.queryByTestId('refine-option-recommended-1-b')).toBeNull();
    });

    it('preselects the recommended option on first render', () => {
      setupFailState(RECOMMENDED_QUESTIONS);
      render(<RefineTicketDialog />);
      const radioA = screen.getByTestId('refine-option-0-a') as HTMLInputElement;
      const radioB = screen.getByTestId('refine-option-0-b') as HTMLInputElement;
      expect(radioA.checked).toBe(true);
      expect(radioB.checked).toBe(false);
    });

    it('no preselection when no option is recommended', () => {
      setupFailState(MULTI_OPT_QUESTIONS);
      render(<RefineTicketDialog />);
      const radios = screen.getAllByRole('radio') as HTMLInputElement[];
      expect(radios.every((r) => !r.checked)).toBe(true);
    });

    it('submit stays disabled when some questions lack a recommendation (unanswered)', () => {
      // RECOMMENDED_QUESTIONS: q1 has recommended option (preselected), q2 has none (null)
      setupFailState(RECOMMENDED_QUESTIONS);
      render(<RefineTicketDialog />);
      const submit = screen.getByTestId('refine-submit-answers');
      // q2 is unanswered — submit must be disabled despite q1 being preselected
      expect(submit.hasAttribute('disabled')).toBe(true);
    });

    it('submit is enabled when all questions have a recommendation preselected', async () => {
      const allRecommended: RefineQuestion[] = [
        {
          id: 'q1', question: 'Q1?',
          options: [
            { id: 'a', label: 'A', recommended: true },
            { id: 'b', label: 'B' },
          ],
        },
        {
          id: 'q2', question: 'Q2?',
          options: [
            { id: 'a', label: 'Yes' },
            { id: 'b', label: 'No', recommended: true },
          ],
        },
      ];
      setupFailState(allRecommended);
      render(<RefineTicketDialog />);
      const submit = screen.getByTestId('refine-submit-answers');
      expect(submit.hasAttribute('disabled')).toBe(false);
    });

    it('escape hatch: clicking the already-selected recommended option deselects it', async () => {
      const user = userEvent.setup();
      setupFailState(RECOMMENDED_QUESTIONS);
      render(<RefineTicketDialog />);

      const radioA = screen.getByTestId('refine-option-0-a') as HTMLInputElement;
      expect(radioA.checked).toBe(true);

      // Click the already-selected radio — should toggle back to null
      await user.click(radioA);
      expect(radioA.checked).toBe(false);
    });

    it('escape hatch: submit is disabled after deselecting the only recommended answer with no text', async () => {
      const user = userEvent.setup();
      const oneQuestion: RefineQuestion[] = [
        {
          id: 'q1', question: 'Q?',
          options: [
            { id: 'a', label: 'A', recommended: true },
            { id: 'b', label: 'B' },
          ],
        },
      ];
      setupFailState(oneQuestion);
      render(<RefineTicketDialog />);

      const submit = screen.getByTestId('refine-submit-answers');
      expect(submit.hasAttribute('disabled')).toBe(false);

      // Deselect the recommended option
      await user.click(screen.getByTestId('refine-option-0-a'));
      expect(submit.hasAttribute('disabled')).toBe(true);
    });

    it('clicking a different option after deselect selects that option', async () => {
      const user = userEvent.setup();
      setupFailState(RECOMMENDED_QUESTIONS);
      render(<RefineTicketDialog />);

      const radioA = screen.getByTestId('refine-option-0-a') as HTMLInputElement;
      const radioB = screen.getByTestId('refine-option-0-b') as HTMLInputElement;
      expect(radioA.checked).toBe(true);

      // Click B directly — should select B and deselect A
      await user.click(radioB);
      expect(radioB.checked).toBe(true);
      expect(radioA.checked).toBe(false);
    });

    it('when multiple options are recommended, only the first gets badge and preselection', () => {
      setupFailState(MULTI_RECOMMENDED_QUESTION);
      render(<RefineTicketDialog />);

      expect(screen.getByTestId('refine-option-recommended-0-a')).toBeDefined();
      expect(screen.queryByTestId('refine-option-recommended-0-b')).toBeNull();

      const radioA = screen.getByTestId('refine-option-0-a') as HTMLInputElement;
      const radioB = screen.getByTestId('refine-option-0-b') as HTMLInputElement;
      expect(radioA.checked).toBe(true);
      expect(radioB.checked).toBe(false);
    });
  });

  describe('answer persistence (#429)', () => {
    it('calls postAnswers with combined answers before specRefineAsync when submitting', async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'ready', phase: 'check', startedAt: Date.now(),
          result: {
            passed: false,
            questions: SINGLE_OPT_QUESTION,
            gateSummary: 'Gate=FAIL, questions=1',
            ticketUrl: null, cached: false,
          },
        }],
        currentRefinementSessionId: 'session-1',
      });

      const callOrder: string[] = [];
      api.tickets.postAnswers = vi.fn().mockImplementation(async () => {
        callOrder.push('postAnswers');
      });
      api.tickets.specRefineAsync = vi.fn().mockImplementation(async () => {
        callOrder.push('specRefineAsync');
      });

      render(<RefineTicketDialog />);
      await user.click(screen.getByTestId('refine-option-0-a'));
      fireEvent.click(screen.getByTestId('refine-submit-answers'));

      await waitFor(() => {
        expect(api.tickets.postAnswers).toHaveBeenCalled();
        expect(api.tickets.specRefineAsync).toHaveBeenCalled();
      });

      // Verify postAnswers received ticketId, projectDir, and the combined answers body
      const postCall = (api.tickets.postAnswers as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(postCall[0]).toBe('310');
      expect(postCall[1]).toBe('/proj');
      expect(postCall[2]).toContain('Q1: What is X?');
      expect(postCall[2]).toContain('Selected: Option A');

      // Verify postAnswers was called before specRefineAsync
      expect(callOrder[0]).toBe('postAnswers');
      expect(callOrder[1]).toBe('specRefineAsync');
    });

    it('still calls specRefineAsync even if postAnswers fails', async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'ready', phase: 'check', startedAt: Date.now(),
          result: {
            passed: false,
            questions: SINGLE_OPT_QUESTION,
            gateSummary: 'Gate=FAIL, questions=1',
            ticketUrl: null, cached: false,
          },
        }],
        currentRefinementSessionId: 'session-1',
      });

      api.tickets.postAnswers = vi.fn().mockRejectedValue(new Error('network error'));
      api.tickets.specRefineAsync = vi.fn().mockResolvedValue(undefined);

      render(<RefineTicketDialog />);
      await user.click(screen.getByTestId('refine-option-0-a'));
      fireEvent.click(screen.getByTestId('refine-submit-answers'));

      await waitFor(() => {
        expect(api.tickets.specRefineAsync).toHaveBeenCalled();
      });
    });

    it('closes dialog after submitting answers (regression #447)', async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1', ticketId: '310', projectDir: '/proj',
          status: 'ready', phase: 'check', startedAt: Date.now(),
          result: {
            passed: false,
            questions: SINGLE_OPT_QUESTION,
            gateSummary: 'Gate=FAIL, questions=1',
            ticketUrl: null, cached: false,
          },
        }],
        currentRefinementSessionId: 'session-1',
      });

      render(<RefineTicketDialog />);
      await user.click(screen.getByTestId('refine-option-0-a'));
      fireEvent.click(screen.getByTestId('refine-submit-answers'));

      await waitFor(() => {
        expect(api.tickets.specRefineAsync).toHaveBeenCalled();
        expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
      });
    });
  });

  describe('ticket title display (#451)', () => {
    const sessionBase = {
      id: 'session-1', ticketId: '310', projectDir: '/proj',
      status: 'running' as const, phase: 'check' as const, startedAt: Date.now(),
    };

    it('shows ticket title when board entry has a non-empty title', () => {
      useAppStore.setState({
        refinementSessions: [sessionBase],
        currentRefinementSessionId: 'session-1',
        boardTickets: [
          { ticket_id: '310', project_dir: '/proj', column: 'refining', title: 'Add dark mode', updated_at: '' },
        ],
      });
      render(<RefineTicketDialog />);
      expect(screen.getByText('#310')).toBeDefined();
      expect(screen.getByTestId('refine-ticket-title').textContent).toBe('Add dark mode');
    });

    it('falls back to bare #N when board entry has empty title', () => {
      useAppStore.setState({
        refinementSessions: [sessionBase],
        currentRefinementSessionId: 'session-1',
        boardTickets: [
          { ticket_id: '310', project_dir: '/proj', column: 'refining', title: '', updated_at: '' },
        ],
      });
      render(<RefineTicketDialog />);
      expect(screen.getByText('#310')).toBeDefined();
      expect(screen.queryByTestId('refine-ticket-title')).toBeNull();
    });

    it('falls back to bare #N when no board entry exists', () => {
      useAppStore.setState({
        refinementSessions: [sessionBase],
        currentRefinementSessionId: 'session-1',
        boardTickets: [],
      });
      render(<RefineTicketDialog />);
      expect(screen.getByText('#310')).toBeDefined();
      expect(screen.queryByTestId('refine-ticket-title')).toBeNull();
    });

    it('treats whitespace-only title as empty and falls back to bare #N', () => {
      useAppStore.setState({
        refinementSessions: [sessionBase],
        currentRefinementSessionId: 'session-1',
        boardTickets: [
          { ticket_id: '310', project_dir: '/proj', column: 'refining', title: '   ', updated_at: '' },
        ],
      });
      render(<RefineTicketDialog />);
      expect(screen.getByText('#310')).toBeDefined();
      expect(screen.queryByTestId('refine-ticket-title')).toBeNull();
    });

    it('applies truncation class to title element for long titles', () => {
      useAppStore.setState({
        refinementSessions: [sessionBase],
        currentRefinementSessionId: 'session-1',
        boardTickets: [
          {
            ticket_id: '310', project_dir: '/proj', column: 'refining', updated_at: '',
            title: 'This is an extremely long ticket title that would overflow the 768px modal if not properly truncated with CSS ellipsis',
          },
        ],
      });
      render(<RefineTicketDialog />);
      const titleEl = screen.getByTestId('refine-ticket-title');
      expect(titleEl.className).toContain('truncate');
    });
  });

  // ---------------------------------------------------------------------------
  // Draft preservation (#459)
  // ---------------------------------------------------------------------------
  describe('refine answer draft preservation (#459)', () => {
    const makeFailSession = (id = 'session-1', questions = MULTI_OPT_QUESTIONS) => ({
      id,
      ticketId: '310',
      projectDir: '/proj',
      status: 'ready' as const,
      phase: 'check' as const,
      startedAt: Date.now(),
      result: {
        passed: false,
        questions,
        gateSummary: 'Gate=FAIL',
        ticketUrl: null,
        cached: false,
      },
    });

    const setFailState = (id = 'session-1', questions = MULTI_OPT_QUESTIONS) => {
      useAppStore.setState({
        refinementSessions: [makeFailSession(id, questions)],
        currentRefinementSessionId: id,
        refineAnswerDrafts: {},
      } as any);
    };

    it('backdrop click preserves answers — reopening restores option and text', async () => {
      const user = userEvent.setup();
      setFailState();

      const { unmount } = render(<RefineTicketDialog />);

      // Select option and type text
      await user.click(screen.getByTestId('refine-option-0-a'));
      await user.type(screen.getByTestId('refine-answer-0'), 'some context');

      // Simulate backdrop click (closes dialog but keeps session)
      const backdrop = screen.getByTestId('refine-ticket-dialog');
      fireEvent.click(backdrop);
      unmount();

      // Draft must be persisted in the store even after unmount
      expect(useAppStore.getState().refineAnswerDrafts['session-1']).toBeDefined();
      expect(useAppStore.getState().refineAnswerDrafts['session-1'][0].optionId).toBe('a');
      expect(useAppStore.getState().refineAnswerDrafts['session-1'][0].text).toBe('some context');

      // Reopen the dialog
      useAppStore.setState({ showRefineTicketDialog: true } as any);
      render(<RefineTicketDialog />);

      // Assert option is still selected and textarea retains value
      const radio = screen.getByTestId('refine-option-0-a') as HTMLInputElement;
      expect(radio.checked).toBe(true);
      const textarea = screen.getByTestId('refine-answer-0') as HTMLTextAreaElement;
      expect(textarea.value).toBe('some context');
    });

    it('switching sessions shows each session draft independently', async () => {
      const user = userEvent.setup();

      const session2 = {
        id: 'session-2',
        ticketId: '311',
        projectDir: '/proj',
        status: 'ready' as const,
        phase: 'check' as const,
        startedAt: Date.now(),
        result: {
          passed: false,
          questions: SINGLE_OPT_QUESTION,
          gateSummary: 'Gate=FAIL',
          ticketUrl: null,
          cached: false,
        },
      };

      useAppStore.setState({
        refinementSessions: [makeFailSession('session-1'), session2],
        currentRefinementSessionId: 'session-1',
        refineAnswerDrafts: {},
      } as any);

      render(<RefineTicketDialog />);

      // Enter answer for session-1
      await user.click(screen.getByTestId('refine-option-0-a'));
      await user.type(screen.getByTestId('refine-answer-0'), 'session1 note');

      // Switch to session-2 — answers should be empty/default
      act(() => {
        useAppStore.getState().setCurrentRefinementSessionId('session-2');
      });

      await waitFor(() => {
        const radio = screen.getByTestId('refine-option-0-a') as HTMLInputElement;
        // No draft for session-2 yet, so no option pre-selected
        expect(radio.checked).toBe(false);
        const textarea = screen.getByTestId('refine-answer-0') as HTMLTextAreaElement;
        expect(textarea.value).toBe('');
      });

      // Switch back to session-1 — drafts restored
      act(() => {
        useAppStore.getState().setCurrentRefinementSessionId('session-1');
      });

      await waitFor(() => {
        const radio = screen.getByTestId('refine-option-0-a') as HTMLInputElement;
        expect(radio.checked).toBe(true);
        const textarea = screen.getByTestId('refine-answer-0') as HTMLTextAreaElement;
        expect(textarea.value).toBe('session1 note');
      });
    });

    it('submit answers clears the draft for that session', async () => {
      const user = userEvent.setup();
      setFailState('session-1', SINGLE_OPT_QUESTION);

      render(<RefineTicketDialog />);
      await user.click(screen.getByTestId('refine-option-0-a'));
      await user.type(screen.getByTestId('refine-answer-0'), 'before submit');

      // Confirm draft saved
      expect(useAppStore.getState().refineAnswerDrafts['session-1']).toBeDefined();

      fireEvent.click(screen.getByTestId('refine-submit-answers'));

      await waitFor(() => {
        expect(api.tickets.specRefineAsync).toHaveBeenCalled();
        expect(useAppStore.getState().refineAnswerDrafts['session-1']).toBeUndefined();
      });
    });

    it('retry (handleRetry) discards old session draft and new session starts empty', async () => {
      // Use errored state to show the refine-retry button
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1',
          ticketId: '310',
          projectDir: '/proj',
          status: 'errored' as const,
          phase: 'check' as const,
          startedAt: Date.now(),
          error: 'gate error',
        }],
        currentRefinementSessionId: 'session-1',
        refineAnswerDrafts: {},
      } as any);
      // Pre-populate draft for session-1
      useAppStore.getState().setRefineAnswerDraft('session-1', [{ optionId: 'a', text: 'old note' }]);

      // New session returned by specCheckAsync
      api.tickets.specCheckAsync = vi.fn().mockResolvedValue({ sessionId: 'session-2' });

      render(<RefineTicketDialog />);
      fireEvent.click(screen.getByTestId('refine-retry'));

      await waitFor(() => {
        expect(useAppStore.getState().currentRefinementSessionId).toBe('session-2');
      });

      // Old session draft must be gone
      expect(useAppStore.getState().refineAnswerDrafts['session-1']).toBeUndefined();
      // New session has no draft
      expect(useAppStore.getState().refineAnswerDrafts['session-2']).toBeUndefined();
    });

    it('restores guarded against length mismatch (more questions than saved answers)', async () => {
      // Pre-save draft with only 1 answer for a 2-question session
      useAppStore.setState({
        refinementSessions: [makeFailSession('session-1', MULTI_OPT_QUESTIONS)],
        currentRefinementSessionId: 'session-1',
        refineAnswerDrafts: {
          'session-1': [{ optionId: 'b', text: 'only first' }],
        },
      } as any);

      // Should not crash
      expect(() => render(<RefineTicketDialog />)).not.toThrow();

      // First question answer restored from draft
      const radio = screen.getByTestId('refine-option-0-b') as HTMLInputElement;
      expect(radio.checked).toBe(true);
      const textarea0 = screen.getByTestId('refine-answer-0') as HTMLTextAreaElement;
      expect(textarea0.value).toBe('only first');

      // Second question falls back to default (no optionId, empty text)
      const textarea1 = screen.getByTestId('refine-answer-1') as HTMLTextAreaElement;
      expect(textarea1.value).toBe('');
    });

    it('legacy string questions use positional fallback on restore', async () => {
      const legacyQuestions = [
        'What approach should we use?' as unknown as ReturnType<typeof Object>,
        'Any performance concerns?' as unknown as ReturnType<typeof Object>,
      ];
      // These will be coerced to RefineQuestion with id 'q' and empty options
      useAppStore.setState({
        refinementSessions: [{
          id: 'session-1',
          ticketId: '310',
          projectDir: '/proj',
          status: 'ready' as const,
          phase: 'check' as const,
          startedAt: Date.now(),
          result: {
            passed: false,
            questions: legacyQuestions as any,
            gateSummary: 'Gate=FAIL',
            ticketUrl: null,
            cached: false,
          },
        }],
        currentRefinementSessionId: 'session-1',
        refineAnswerDrafts: {
          'session-1': [
            { optionId: null, text: 'approach note' },
            { optionId: null, text: 'perf note' },
          ],
        },
      } as any);

      render(<RefineTicketDialog />);

      const textarea0 = screen.getByTestId('refine-answer-0') as HTMLTextAreaElement;
      const textarea1 = screen.getByTestId('refine-answer-1') as HTMLTextAreaElement;
      expect(textarea0.value).toBe('approach note');
      expect(textarea1.value).toBe('perf note');
    });

    it('no draft on first open — default recommended option pre-selected', () => {
      const recommendedQuestions = [{
        id: 'q1',
        question: 'Pick one',
        options: [
          { id: 'a', label: 'Option A', recommended: true },
          { id: 'b', label: 'Option B' },
        ],
      }];
      useAppStore.setState({
        refinementSessions: [makeFailSession('session-1', recommendedQuestions)],
        currentRefinementSessionId: 'session-1',
        refineAnswerDrafts: {},
      } as any);

      render(<RefineTicketDialog />);

      const radioA = screen.getByTestId('refine-option-0-a') as HTMLInputElement;
      expect(radioA.checked).toBe(true);
    });
  });

  describe('upsertRefinementSession clears streamingOutput on completion', () => {
    it('clears streamingOutput when status transitions to ready', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'sess', ticketId: '1', projectDir: '/p',
          status: 'running', phase: 'check', startedAt: 0,
          streamingOutput: 'some output',
        }],
      });
      useAppStore.getState().upsertRefinementSession({
        id: 'sess', ticketId: '1', projectDir: '/p',
        status: 'ready', phase: 'check', startedAt: 0,
        result: { passed: true, questions: [], gateSummary: '', ticketUrl: null, cached: false },
      });
      const s = useAppStore.getState().refinementSessions[0];
      expect(s.streamingOutput).toBeUndefined();
    });

    it('clears streamingOutput when status transitions to errored', () => {
      useAppStore.setState({
        refinementSessions: [{
          id: 'sess', ticketId: '1', projectDir: '/p',
          status: 'running', phase: 'check', startedAt: 0,
          streamingOutput: 'partial',
        }],
      });
      useAppStore.getState().upsertRefinementSession({
        id: 'sess', ticketId: '1', projectDir: '/p',
        status: 'errored', phase: 'check', startedAt: 0,
        error: 'something failed',
      });
      const s = useAppStore.getState().refinementSessions[0];
      expect(s.streamingOutput).toBeUndefined();
    });
  });
});
