/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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
  beforeEach(() => {
    mockSandstormApi();
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
});

