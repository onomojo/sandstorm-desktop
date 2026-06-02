/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RefinementIndicator } from '../../../src/renderer/components/RefinementIndicator';
import { useAppStore, RefinementSession } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeSession(overrides: Partial<RefinementSession> = {}): RefinementSession {
  return {
    id: 'session-1',
    ticketId: '123',
    projectDir: '/proj',
    status: 'running',
    phase: 'check',
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('RefinementIndicator', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
      refinementSessions: [],
      currentRefinementSessionId: null,
      showRefineTicketDialog: false,
    });
  });

  it('renders nothing when there are no sessions', () => {
    render(<RefinementIndicator />);
    expect(screen.queryByTestId('refinement-indicator')).toBeNull();
  });

  it('renders the pill when there is a running session', () => {
    useAppStore.setState({
      refinementSessions: [makeSession({ status: 'running' })],
    });
    render(<RefinementIndicator />);
    expect(screen.getByTestId('refinement-indicator')).toBeDefined();
    expect(screen.getByTestId('refinement-indicator-pill').textContent).toMatch(/1 refinement/);
  });

  it('shows count of multiple sessions', () => {
    useAppStore.setState({
      refinementSessions: [
        makeSession({ id: 's1', ticketId: '1', status: 'running' }),
        makeSession({ id: 's2', ticketId: '2', status: 'ready' }),
      ],
    });
    render(<RefinementIndicator />);
    expect(screen.getByTestId('refinement-indicator-pill').textContent).toMatch(/2 refinements/);
  });

  it('opens dropdown on click', () => {
    useAppStore.setState({
      refinementSessions: [makeSession({ status: 'running' })],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));
    expect(screen.getByTestId('refinement-indicator-dropdown')).toBeDefined();
  });

  it('lists each session in the dropdown', () => {
    useAppStore.setState({
      refinementSessions: [
        makeSession({ id: 's1', ticketId: '123', status: 'running' }),
        makeSession({ id: 's2', ticketId: '456', status: 'ready', result: { passed: true, questions: [], gateSummary: '', ticketUrl: null, cached: false } }),
      ],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));
    expect(screen.getByTestId('refinement-session-s1')).toBeDefined();
    expect(screen.getByTestId('refinement-session-s2')).toBeDefined();
  });

  it('opens refine dialog with the correct session on click', () => {
    useAppStore.setState({
      refinementSessions: [makeSession({ id: 's1', ticketId: '123', status: 'ready', result: { passed: true, questions: [], gateSummary: '', ticketUrl: null, cached: false } })],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));
    fireEvent.click(screen.getByTestId('refinement-session-s1'));

    expect(useAppStore.getState().currentRefinementSessionId).toBe('s1');
    expect(useAppStore.getState().showRefineTicketDialog).toBe(true);
  });

  it('only shows sessions for the active project', () => {
    useAppStore.setState({
      refinementSessions: [
        makeSession({ id: 's1', ticketId: '1', projectDir: '/proj', status: 'running' }),
        makeSession({ id: 's2', ticketId: '2', projectDir: '/other-proj', status: 'running' }),
      ],
    });
    render(<RefinementIndicator />);
    // Only 1 session for /proj should be shown
    expect(screen.getByTestId('refinement-indicator-pill').textContent).toMatch(/1 refinement/);
  });

  // =========================================================================
  // Discard (✕) button tests
  // =========================================================================

  it('renders an inline discard button for each visible session row', () => {
    useAppStore.setState({
      refinementSessions: [
        makeSession({ id: 's1', ticketId: '1', status: 'running' }),
        makeSession({ id: 's2', ticketId: '2', status: 'errored' }),
      ],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));
    expect(screen.getByTestId('refinement-session-discard-s1')).toBeDefined();
    expect(screen.getByTestId('refinement-session-discard-s2')).toBeDefined();
  });

  it('clicking ✕ invokes discardRefinement IPC with the session id', async () => {
    useAppStore.setState({
      refinementSessions: [makeSession({ id: 's1', ticketId: '1', status: 'errored' })],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('refinement-session-discard-s1'));
    });

    expect(api.tickets.discardRefinement).toHaveBeenCalledWith('s1');
  });

  it('clicking ✕ removes the session from the store', async () => {
    useAppStore.setState({
      refinementSessions: [makeSession({ id: 's1', ticketId: '1', status: 'errored' })],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('refinement-session-discard-s1'));
    });

    expect(useAppStore.getState().refinementSessions.find((s) => s.id === 's1')).toBeUndefined();
  });

  it('clicking ✕ does not trigger the open-dialog handler', async () => {
    useAppStore.setState({
      refinementSessions: [makeSession({ id: 's1', ticketId: '1', status: 'ready', result: { passed: true, questions: [], gateSummary: '', ticketUrl: null, cached: false } })],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('refinement-session-discard-s1'));
    });

    // Dialog should not have been opened
    expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
    expect(useAppStore.getState().currentRefinementSessionId).toBeNull();
  });

  it('clicking ✕ closes the dialog when the discarded session is the currently open one', async () => {
    useAppStore.setState({
      refinementSessions: [makeSession({ id: 's1', ticketId: '1', status: 'ready', result: { passed: true, questions: [], gateSummary: '', ticketUrl: null, cached: false } })],
      currentRefinementSessionId: 's1',
      showRefineTicketDialog: true,
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('refinement-session-discard-s1'));
    });

    expect(useAppStore.getState().showRefineTicketDialog).toBe(false);
  });

  // =========================================================================
  // "Clear all" button tests
  // =========================================================================

  it('renders a "Clear all" button in the dropdown', () => {
    useAppStore.setState({
      refinementSessions: [makeSession({ id: 's1', status: 'errored' })],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));
    expect(screen.getByTestId('refinement-clear-all')).toBeDefined();
  });

  it('"Clear all" discards every visible session', async () => {
    useAppStore.setState({
      refinementSessions: [
        makeSession({ id: 's1', ticketId: '1', status: 'errored' }),
        makeSession({ id: 's2', ticketId: '2', status: 'interrupted' }),
      ],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('refinement-clear-all'));
    });

    expect(api.tickets.discardRefinement).toHaveBeenCalledWith('s1');
    expect(api.tickets.discardRefinement).toHaveBeenCalledWith('s2');
    expect(api.tickets.discardRefinement).toHaveBeenCalledTimes(2);
  });

  it('"Clear all" only discards sessions from the active project', async () => {
    useAppStore.setState({
      refinementSessions: [
        makeSession({ id: 's1', ticketId: '1', projectDir: '/proj', status: 'errored' }),
        makeSession({ id: 's2', ticketId: '2', projectDir: '/other-proj', status: 'errored' }),
      ],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('refinement-clear-all'));
    });

    expect(api.tickets.discardRefinement).toHaveBeenCalledWith('s1');
    expect(api.tickets.discardRefinement).not.toHaveBeenCalledWith('s2');
  });

  it('"Clear all" removes all visible sessions from the store', async () => {
    useAppStore.setState({
      refinementSessions: [
        makeSession({ id: 's1', ticketId: '1', status: 'errored' }),
        makeSession({ id: 's2', ticketId: '2', status: 'interrupted' }),
      ],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('refinement-clear-all'));
    });

    expect(useAppStore.getState().refinementSessions).toHaveLength(0);
  });

  // =========================================================================
  // Regression: terminal-state sessions can be discarded
  // =========================================================================

  it('discards an errored session (regression: previously no discard path existed)', async () => {
    useAppStore.setState({
      refinementSessions: [makeSession({ id: 'err-1', ticketId: '99', status: 'errored' })],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('refinement-session-discard-err-1'));
    });

    expect(api.tickets.discardRefinement).toHaveBeenCalledWith('err-1');
    expect(useAppStore.getState().refinementSessions.find((s) => s.id === 'err-1')).toBeUndefined();
  });

  it('discards an interrupted session', async () => {
    useAppStore.setState({
      refinementSessions: [makeSession({ id: 'int-1', ticketId: '88', status: 'interrupted' })],
    });
    render(<RefinementIndicator />);
    fireEvent.click(screen.getByTestId('refinement-indicator-pill'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('refinement-session-discard-int-1'));
    });

    expect(api.tickets.discardRefinement).toHaveBeenCalledWith('int-1');
    expect(useAppStore.getState().refinementSessions.find((s) => s.id === 'int-1')).toBeUndefined();
  });
});
