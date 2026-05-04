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
});
