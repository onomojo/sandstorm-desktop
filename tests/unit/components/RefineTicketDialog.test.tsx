/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RefineTicketDialog } from '../../../src/renderer/components/RefineTicketDialog';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

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
    });
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
          questions: ['What is X?', 'What is Y?'],
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

  it('calls specRefineAsync with formatted Q/A when answers are submitted', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      refinementSessions: [{
        id: 'session-1', ticketId: '310', projectDir: '/proj',
        status: 'ready', phase: 'check', startedAt: Date.now(),
        result: {
          passed: false,
          questions: ['What is X?'],
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
      expect(api.tickets.specRefineAsync).toHaveBeenCalledWith(
        'session-1',
        '310',
        '/proj',
        expect.stringContaining('Q1: What is X?\nA: X is foo'),
      );
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
