/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
      stacks: [],
    });
  });

  it('renders the dialog with the ticket id input', () => {
    render(<RefineTicketDialog />);
    expect(screen.getByText('Refine Ticket')).toBeDefined();
    expect(screen.getByTestId('refine-ticket-id')).toBeDefined();
  });

  it('Run Gate is disabled until a ticket id is entered', () => {
    render(<RefineTicketDialog />);
    const btn = screen.getByTestId('refine-run-gate');
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('closes when Cancel is clicked', () => {
    render(<RefineTicketDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
  });

  it('renders the pass state and a Start Stack button when the gate passes', async () => {
    const user = userEvent.setup();
    api.tickets.specCheck.mockResolvedValue({
      passed: true, questions: [], gateSummary: 'Gate=PASS, questions=0',
      ticketUrl: 'https://github.com/o/r/issues/310', cached: false,
    });
    render(<RefineTicketDialog />);
    await user.type(screen.getByTestId('refine-ticket-id'), '310');
    fireEvent.click(screen.getByTestId('refine-run-gate'));

    await waitFor(() => {
      expect(screen.getByTestId('refine-pass')).toBeDefined();
    });
    expect(api.tickets.specCheck).toHaveBeenCalledWith('310', '/proj');
    expect(screen.getByTestId('refine-start-stack')).toBeDefined();
    const nameInput = screen.getByTestId('refine-stack-name') as HTMLInputElement;
    expect(nameInput.value).toBe('ticket-310');
  });

  it('renders the fail state with a per-question form', async () => {
    const user = userEvent.setup();
    api.tickets.specCheck.mockResolvedValue({
      passed: false,
      questions: ['What is X?', 'What is Y?'],
      gateSummary: 'Gate=FAIL, questions=2',
      ticketUrl: null,
      cached: false,
    });
    render(<RefineTicketDialog />);
    await user.type(screen.getByTestId('refine-ticket-id'), '310');
    fireEvent.click(screen.getByTestId('refine-run-gate'));

    await waitFor(() => {
      expect(screen.getByTestId('refine-fail')).toBeDefined();
    });
    expect(screen.getByText('What is X?')).toBeDefined();
    expect(screen.getByTestId('refine-answer-0')).toBeDefined();
    expect(screen.getByTestId('refine-answer-1')).toBeDefined();

    // Submit answers should be disabled until all are filled.
    const submit = screen.getByTestId('refine-submit-answers');
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('calls specRefine with the formatted Q/A payload when answers are submitted', async () => {
    const user = userEvent.setup();
    api.tickets.specCheck.mockResolvedValue({
      passed: false,
      questions: ['What is X?'],
      gateSummary: 'Gate=FAIL, questions=1',
      ticketUrl: null,
      cached: false,
    });
    api.tickets.specRefine.mockResolvedValue({
      passed: true, questions: [], gateSummary: 'Gate=PASS, questions=0',
      ticketUrl: null, cached: false,
    });
    render(<RefineTicketDialog />);
    await user.type(screen.getByTestId('refine-ticket-id'), '310');
    fireEvent.click(screen.getByTestId('refine-run-gate'));
    await waitFor(() => screen.getByTestId('refine-fail'));

    await user.type(screen.getByTestId('refine-answer-0'), 'X is foo');
    fireEvent.click(screen.getByTestId('refine-submit-answers'));

    await waitFor(() => {
      expect(api.tickets.specRefine).toHaveBeenCalledWith(
        '310',
        '/proj',
        expect.stringContaining('Q1: What is X?\nA: X is foo'),
      );
    });

    // Should land on the pass state after the refine succeeds.
    await waitFor(() => screen.getByTestId('refine-pass'));
  });

  it('calls stacks.create with verbatim ticket body when Start Stack is clicked', async () => {
    const user = userEvent.setup();
    api.tickets.specCheck.mockResolvedValue({
      passed: true, questions: [], gateSummary: 'Gate=PASS', ticketUrl: null, cached: false,
    });
    api.tickets.fetch.mockResolvedValue({
      body: '# Issue: Refine ticket\n\nbody text', url: null,
    });
    api.stacks.create.mockResolvedValue({
      id: 'ticket-310', project: 'proj', status: 'building', services: [],
    });

    render(<RefineTicketDialog />);
    await user.type(screen.getByTestId('refine-ticket-id'), '310');
    fireEvent.click(screen.getByTestId('refine-run-gate'));
    await waitFor(() => screen.getByTestId('refine-start-stack'));

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

    // Dialog should close after success
    expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
  });

  it('shows the cached banner copy when the gate result is cached', async () => {
    const user = userEvent.setup();
    api.tickets.specCheck.mockResolvedValue({
      passed: true, questions: [], gateSummary: 'cached', ticketUrl: null, cached: true,
    });
    render(<RefineTicketDialog />);
    await user.type(screen.getByTestId('refine-ticket-id'), '310');
    fireEvent.click(screen.getByTestId('refine-run-gate'));
    await waitFor(() => screen.getByTestId('refine-pass'));
    expect(screen.getByText(/already passed/i)).toBeDefined();
  });

  it('surfaces an error when specCheck rejects', async () => {
    const user = userEvent.setup();
    api.tickets.specCheck.mockRejectedValue(new Error('gh rate limit'));
    render(<RefineTicketDialog />);
    await user.type(screen.getByTestId('refine-ticket-id'), '310');
    fireEvent.click(screen.getByTestId('refine-run-gate'));
    await waitFor(() => {
      expect(screen.getByTestId('refine-error').textContent).toMatch(/gh rate limit/);
    });
  });

  // #317 — opening Refine via "Refine #N" hand-off from Create should not
  // re-prompt for the id; the gate should fire automatically.
  describe('prefill hand-off (#317)', () => {
    it('hydrates the ticket id from refineTicketPrefill on mount', () => {
      useAppStore.setState({ refineTicketPrefill: '77' });
      api.tickets.specCheck.mockResolvedValue({
        passed: true, questions: [], gateSummary: '', ticketUrl: null, cached: false,
      });
      render(<RefineTicketDialog />);
      const input = screen.getByTestId('refine-ticket-id') as HTMLInputElement;
      expect(input.value).toBe('77');
    });

    it('auto-runs the gate when opened with a prefill', async () => {
      useAppStore.setState({ refineTicketPrefill: '77' });
      api.tickets.specCheck.mockResolvedValue({
        passed: true, questions: [], gateSummary: 'Gate=PASS', ticketUrl: null, cached: false,
      });
      render(<RefineTicketDialog />);
      await waitFor(() => {
        expect(api.tickets.specCheck).toHaveBeenCalledWith('77', '/proj');
      });
      // Lands on the pass state — user goes straight to Start Stack.
      await waitFor(() => screen.getByTestId('refine-pass'));
    });

    it('clears the prefill after consuming it (so reopening cold doesn\'t re-fire)', () => {
      useAppStore.setState({ refineTicketPrefill: '77' });
      api.tickets.specCheck.mockResolvedValue({
        passed: false, questions: [], gateSummary: '', ticketUrl: null, cached: false,
      });
      render(<RefineTicketDialog />);
      expect(useAppStore.getState().refineTicketPrefill).toBeNull();
    });

    it('does NOT auto-run when there is no prefill (user opened Refine cold)', () => {
      useAppStore.setState({ refineTicketPrefill: null });
      render(<RefineTicketDialog />);
      expect(api.tickets.specCheck).not.toHaveBeenCalled();
    });
  });
});
