/**
 * @vitest-environment jsdom
 *
 * Regression tests for the restart-restoration bug (ticket #427, Problem 2):
 * replaying persisted passed refinement sessions on startup must NOT move tickets
 * out of started columns (in_stack, pr_open, merged) back to spec_ready.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../src/renderer/store';

const PROJECT_DIR = '/proj';

function makePassedSession(ticketId = '42') {
  return {
    id: `sess-${ticketId}`,
    ticketId,
    projectDir: PROJECT_DIR,
    status: 'ready' as const,
    phase: 'check' as const,
    result: {
      passed: true,
      questions: [],
      gateSummary: 'Gate=PASS',
      ticketUrl: null,
      cached: false,
    },
    startedAt: 0,
  };
}

function setupMockApi() {
  const setColumn = vi.fn().mockResolvedValue(undefined);
  const api = {
    ticketBoard: { setColumn },
    stacks: { list: vi.fn().mockResolvedValue([]) },
    projects: { list: vi.fn().mockResolvedValue([]) },
    tickets: { listRefinements: vi.fn().mockResolvedValue([]) },
  } as unknown as typeof window.sandstorm;

  Object.defineProperty(window, 'sandstorm', {
    value: api,
    writable: true,
    configurable: true,
  });

  return { setColumn };
}

describe('refinement session hydration replay', () => {
  let setColumn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ setColumn } = setupMockApi());
    useAppStore.setState({
      refinementSessions: [],
      boardTickets: [],
      projects: [{ id: 1, name: 'proj', directory: PROJECT_DIR, added_at: '' }],
      activeProjectId: 1,
    });
  });

  it('regression: replaying a passed session with replay:true does NOT move ticket to spec_ready', async () => {
    const session = makePassedSession('42');

    useAppStore.getState().upsertRefinementSession(session, { replay: true });

    // Allow any microtasks to settle
    await Promise.resolve();

    expect(setColumn).not.toHaveBeenCalledWith('42', PROJECT_DIR, 'spec_ready');
  });

  it('regression holds even when boardTickets is empty at replay time', async () => {
    // Ensure boardTickets is explicitly empty — simulates the startup race
    useAppStore.setState({ boardTickets: [] });

    const session = makePassedSession('99');
    useAppStore.getState().upsertRefinementSession(session, { replay: true });

    await Promise.resolve();

    expect(setColumn).not.toHaveBeenCalledWith('99', PROJECT_DIR, 'spec_ready');
  });

  it('regression holds across multiple replayed sessions at once', async () => {
    const sessions = ['100', '101', '102'].map(makePassedSession);

    sessions.forEach((s) => {
      useAppStore.getState().upsertRefinementSession(s, { replay: true });
    });

    await Promise.resolve();

    expect(setColumn).not.toHaveBeenCalledWith(expect.anything(), PROJECT_DIR, 'spec_ready');
  });

  it('preserves intended behavior: live transition (no replay flag) DOES fire moveTicketColumn to spec_ready', async () => {
    const session = makePassedSession('42');

    // No replay flag — this is a genuine live refinement:update event
    useAppStore.getState().upsertRefinementSession(session);

    await Promise.resolve();

    expect(setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'spec_ready');
  });

  it('idempotency: re-emitting an already-passed session (no replay flag) does NOT re-fire spec_ready move', async () => {
    const session = makePassedSession('42');

    // First emit — genuine transition
    useAppStore.getState().upsertRefinementSession(session);
    await Promise.resolve();
    expect(setColumn).toHaveBeenCalledTimes(1);

    setColumn.mockClear();

    // Second emit of the same passed session — should be a no-op
    useAppStore.getState().upsertRefinementSession(session);
    await Promise.resolve();
    expect(setColumn).not.toHaveBeenCalled();
  });

  it('session is still stored in refinementSessions even when replay suppresses the column move', () => {
    const session = makePassedSession('55');

    useAppStore.getState().upsertRefinementSession(session, { replay: true });

    const stored = useAppStore.getState().refinementSessions.find((s) => s.id === session.id);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe('ready');
    expect(stored?.result?.passed).toBe(true);
  });
});
