/**
 * @vitest-environment jsdom
 *
 * Tests for openRefineDialogFromCard — covers the bug where stale refinement
 * sessions caused a silent no-op, and the running-session path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../src/renderer/store';
import type { RefinementSession } from '../../src/main/control-plane/refinement-store';

const TICKET_ID = 'T-42';
const PROJECT_DIR = '/proj';

function makeSession(overrides: Partial<RefinementSession> = {}): RefinementSession {
  return {
    id: 'sess-1',
    ticketId: TICKET_ID,
    projectDir: PROJECT_DIR,
    status: 'ready',
    phase: 'check',
    startedAt: 0,
    ...overrides,
  };
}

function makeSandstormApi(overrides: Record<string, unknown> = {}) {
  const specCheckAsync = vi.fn().mockResolvedValue({ sessionId: 'new-sess' });
  const cancelRefinement = vi.fn().mockResolvedValue(undefined);
  const api = {
    ticketBoard: {
      setColumn: vi.fn().mockResolvedValue(undefined),
    },
    tickets: {
      specCheckAsync,
      cancelRefinement,
      listRefinements: vi.fn().mockResolvedValue([]),
    },
    stacks: { list: vi.fn().mockResolvedValue([]) },
    projects: { list: vi.fn().mockResolvedValue([]) },
    ...overrides,
  } as unknown as typeof window.sandstorm;

  Object.defineProperty(window, 'sandstorm', {
    value: api,
    writable: true,
    configurable: true,
  });

  return { specCheckAsync, cancelRefinement, setColumn: (api.ticketBoard as { setColumn: ReturnType<typeof vi.fn> }).setColumn };
}

describe('openRefineDialogFromCard', () => {
  let mocks: ReturnType<typeof makeSandstormApi>;

  beforeEach(() => {
    mocks = makeSandstormApi();
    useAppStore.setState({
      refinementSessions: [],
      boardTickets: [],
      refineInFlight: {},
      refineStartErrors: {},
      projects: [{ id: 1, name: 'proj', directory: PROJECT_DIR, added_at: '' }],
      activeProjectId: 1,
    } as Parameters<typeof useAppStore.setState>[0]);
  });

  // ---------------------------------------------------------------------------
  // The regression: stale session must not cause a silent no-op
  // ---------------------------------------------------------------------------

  it('regression: stale ready session is cancelled and fresh gate starts', async () => {
    const stale = makeSession({ status: 'ready' });
    useAppStore.setState({ refinementSessions: [stale] } as Parameters<typeof useAppStore.setState>[0]);

    useAppStore.getState().openRefineDialogFromCard(TICKET_ID, PROJECT_DIR, 'backlog');

    await Promise.resolve();

    expect(mocks.cancelRefinement).toHaveBeenCalledWith('sess-1');
    expect(mocks.specCheckAsync).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR);
  });

  it('stale errored session is cancelled and fresh gate starts', async () => {
    const stale = makeSession({ status: 'errored' });
    useAppStore.setState({ refinementSessions: [stale] } as Parameters<typeof useAppStore.setState>[0]);

    useAppStore.getState().openRefineDialogFromCard(TICKET_ID, PROJECT_DIR, 'backlog');

    await Promise.resolve();

    expect(mocks.cancelRefinement).toHaveBeenCalledWith('sess-1');
    expect(mocks.specCheckAsync).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR);
  });

  it('stale interrupted session is cancelled and fresh gate starts', async () => {
    const stale = makeSession({ status: 'interrupted' });
    useAppStore.setState({ refinementSessions: [stale] } as Parameters<typeof useAppStore.setState>[0]);

    useAppStore.getState().openRefineDialogFromCard(TICKET_ID, PROJECT_DIR, 'backlog');

    await Promise.resolve();

    expect(mocks.cancelRefinement).toHaveBeenCalledWith('sess-1');
    expect(mocks.specCheckAsync).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR);
  });

  it('stale session is removed from store state before starting fresh gate', async () => {
    const stale = makeSession({ status: 'ready' });
    useAppStore.setState({ refinementSessions: [stale] } as Parameters<typeof useAppStore.setState>[0]);

    useAppStore.getState().openRefineDialogFromCard(TICKET_ID, PROJECT_DIR, 'backlog');
    await Promise.resolve();

    const sessions = useAppStore.getState().refinementSessions;
    const stillStale = sessions.find((s) => s.id === 'sess-1');
    expect(stillStale).toBeUndefined();
  });

  it('card moves to refining after stale session is discarded', async () => {
    const stale = makeSession({ status: 'ready' });
    useAppStore.setState({ refinementSessions: [stale] } as Parameters<typeof useAppStore.setState>[0]);

    useAppStore.getState().openRefineDialogFromCard(TICKET_ID, PROJECT_DIR, 'backlog');
    await Promise.resolve();

    expect(mocks.setColumn).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR, 'refining');
  });

  // ---------------------------------------------------------------------------
  // Running session: open the dialog, do NOT start a new gate
  // ---------------------------------------------------------------------------

  it('running session: opens existing session dialog and does not cancel or start new gate', async () => {
    const running = makeSession({ status: 'running' });
    useAppStore.setState({ refinementSessions: [running] } as Parameters<typeof useAppStore.setState>[0]);

    useAppStore.getState().openRefineDialogFromCard(TICKET_ID, PROJECT_DIR, 'backlog');
    await Promise.resolve();

    expect(mocks.cancelRefinement).not.toHaveBeenCalled();
    expect(mocks.specCheckAsync).not.toHaveBeenCalled();
    expect(useAppStore.getState().currentRefinementSessionId).toBe('sess-1');
    expect(useAppStore.getState().showRefineTicketDialog).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // No existing session: normal fresh-gate flow
  // ---------------------------------------------------------------------------

  it('no existing session: starts gate and moves to refining', async () => {
    useAppStore.getState().openRefineDialogFromCard(TICKET_ID, PROJECT_DIR, 'backlog');
    await Promise.resolve();

    expect(mocks.cancelRefinement).not.toHaveBeenCalled();
    expect(mocks.specCheckAsync).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR);
    expect(mocks.setColumn).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR, 'refining');
  });

  // ---------------------------------------------------------------------------
  // Double-click guard
  // ---------------------------------------------------------------------------

  it('refineInFlight guard prevents a second call from starting another gate', async () => {
    useAppStore.setState({
      refineInFlight: { [`${TICKET_ID}|${PROJECT_DIR}`]: true },
    } as Parameters<typeof useAppStore.setState>[0]);

    useAppStore.getState().openRefineDialogFromCard(TICKET_ID, PROJECT_DIR, 'backlog');
    await Promise.resolve();

    expect(mocks.specCheckAsync).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cancel IPC failure is swallowed (best-effort)
  // ---------------------------------------------------------------------------

  it('cancelRefinement failure is swallowed and gate still starts', async () => {
    mocks.cancelRefinement.mockRejectedValueOnce(new Error('IPC fail'));
    const stale = makeSession({ status: 'ready' });
    useAppStore.setState({ refinementSessions: [stale] } as Parameters<typeof useAppStore.setState>[0]);

    useAppStore.getState().openRefineDialogFromCard(TICKET_ID, PROJECT_DIR, 'backlog');
    // Give the async cancelRefinement time to reject
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.specCheckAsync).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR);
  });
});
