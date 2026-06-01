/**
 * @vitest-environment jsdom
 *
 * Backend unit test for ticket_board DB table and Registry methods.
 * Tests migration idempotency, lazy seeding, and column transitions.
 * Also includes store-level tests for refreshBoardTickets and moveTicketColumn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import os from 'os';
import path from 'path';
import fs from 'fs';

let registry: Registry;
let dbPath: string;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-test-'));
  dbPath = path.join(dir, 'test.db');
  registry = await Registry.create(dbPath);
});

afterEach(() => {
  registry.close();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('ticket_board migration', () => {
  it('creates ticket_board table on fresh DB', async () => {
    // If no error is thrown, the table exists (methods below will confirm)
    const rows = registry.listBoardTickets('/some/dir');
    expect(Array.isArray(rows)).toBe(true);
  });

  it('is idempotent — second Registry.create on same DB does not fail', async () => {
    registry.close();
    const registry2 = await Registry.create(dbPath);
    const rows = registry2.listBoardTickets('/some/dir');
    expect(Array.isArray(rows)).toBe(true);
    registry2.close();
    // Reopen for afterEach cleanup
    registry = await Registry.create(dbPath);
  });
});

describe('seedBoardTicket', () => {
  it('inserts a new ticket at backlog', () => {
    registry.seedBoardTicket('42', '/proj', 'Fix the bug');
    const rows = registry.listBoardTickets('/proj');
    expect(rows).toHaveLength(1);
    expect(rows[0].ticket_id).toBe('42');
    expect(rows[0].column).toBe('backlog');
    expect(rows[0].title).toBe('Fix the bug');
  });

  it('does NOT change the column if the ticket already exists', () => {
    registry.seedBoardTicket('42', '/proj', 'Fix the bug');
    registry.setBoardTicketColumn('42', '/proj', 'spec_ready');
    // Seed again (simulating a re-fetch)
    registry.seedBoardTicket('42', '/proj', 'Fix the bug (updated title)');
    const rows = registry.listBoardTickets('/proj');
    expect(rows[0].column).toBe('spec_ready'); // unchanged
    expect(rows[0].title).toBe('Fix the bug (updated title)'); // title updated
  });

  it('is idempotent — seeding the same ticket multiple times at backlog stays at backlog', () => {
    registry.seedBoardTicket('42', '/proj', 'T');
    registry.seedBoardTicket('42', '/proj', 'T');
    registry.seedBoardTicket('42', '/proj', 'T');
    const rows = registry.listBoardTickets('/proj');
    expect(rows).toHaveLength(1);
    expect(rows[0].column).toBe('backlog');
  });
});

describe('setBoardTicketColumn', () => {
  it('moves an existing ticket to a new column', () => {
    registry.seedBoardTicket('42', '/proj', 'Fix the bug');
    registry.setBoardTicketColumn('42', '/proj', 'pr_open');
    const rows = registry.listBoardTickets('/proj');
    expect(rows[0].column).toBe('pr_open');
  });

  it('inserts at target column if the row does not exist', () => {
    registry.setBoardTicketColumn('99', '/proj', 'merged');
    const rows = registry.listBoardTickets('/proj');
    expect(rows[0].ticket_id).toBe('99');
    expect(rows[0].column).toBe('merged');
  });
});

describe('listBoardTickets', () => {
  it('scopes results to the given project directory', () => {
    registry.seedBoardTicket('1', '/alpha', 'Alpha ticket');
    registry.seedBoardTicket('2', '/beta', 'Beta ticket');
    const alpha = registry.listBoardTickets('/alpha');
    expect(alpha).toHaveLength(1);
    expect(alpha[0].ticket_id).toBe('1');

    const beta = registry.listBoardTickets('/beta');
    expect(beta).toHaveLength(1);
    expect(beta[0].ticket_id).toBe('2');
  });

  it('normalizes project_dir path (resolves to absolute)', () => {
    registry.seedBoardTicket('7', '/proj', 'T');
    // Should still find it with resolved path
    const rows = registry.listBoardTickets('/proj');
    expect(rows).toHaveLength(1);
  });

  it('round-trip: write a column, read it back', () => {
    registry.seedBoardTicket('55', '/proj', 'Round-trip test');
    registry.setBoardTicketColumn('55', '/proj', 'refining');
    const rows = registry.listBoardTickets('/proj');
    expect(rows[0].column).toBe('refining');
  });

  it('returns empty array when no tickets exist for project', () => {
    const rows = registry.listBoardTickets('/nonexistent');
    expect(rows).toEqual([]);
  });
});

// --- tickets:create board-seeding simulation ---
// Simulates the main-process behavior added in #385: after tickets:create
// resolves, the handler calls registry.seedBoardTicket so the card appears
// immediately without waiting for a provider list call.

describe('tickets:create seeding behavior', () => {
  it('listBoardTickets includes the new ticket after seeding at creation time', () => {
    registry.seedBoardTicket('99', '/proj', 'My new ticket');
    const rows = registry.listBoardTickets('/proj');
    expect(rows).toHaveLength(1);
    expect(rows[0].ticket_id).toBe('99');
    expect(rows[0].column).toBe('backlog');
    expect(rows[0].title).toBe('My new ticket');
  });

  it('card appears in backlog even when provider list call returns empty', () => {
    // Simulate: tickets:create succeeded and seeded the board.
    // Provider list (tickets:list) returns [] — simulating a lag.
    registry.seedBoardTicket('100', '/proj', 'Another ticket');

    // Normally tickets:list would call provider and get [], then listBoardTickets.
    // Since we seeded in step 1, the ticket must still be present.
    const rows = registry.listBoardTickets('/proj');
    const found = rows.find(r => r.ticket_id === '100');
    expect(found).toBeDefined();
    expect(found?.column).toBe('backlog');
  });
});

// --- advanceTicketToPrOpenIfInStack ---

describe('registry.advanceTicketToPrOpenIfInStack', () => {
  it('moves a ticket from in_stack to pr_open', () => {
    registry.setBoardTicketColumn('t1', '/proj', 'in_stack');
    registry.advanceTicketToPrOpenIfInStack('t1', '/proj');
    expect(registry.listBoardTickets('/proj')[0].column).toBe('pr_open');
  });

  it('leaves a merged ticket at merged (forward-only)', () => {
    registry.setBoardTicketColumn('t1', '/proj', 'merged');
    registry.advanceTicketToPrOpenIfInStack('t1', '/proj');
    expect(registry.listBoardTickets('/proj')[0].column).toBe('merged');
  });

  it('leaves a pr_open ticket at pr_open', () => {
    registry.setBoardTicketColumn('t1', '/proj', 'pr_open');
    registry.advanceTicketToPrOpenIfInStack('t1', '/proj');
    expect(registry.listBoardTickets('/proj')[0].column).toBe('pr_open');
  });

  it('is a no-op when the ticket does not exist in the board', () => {
    registry.advanceTicketToPrOpenIfInStack('nonexistent', '/proj');
    expect(registry.listBoardTickets('/proj')).toHaveLength(0);
  });
});

// --- reconcilePrCreatedTickets (backfill) ---

describe('registry.reconcilePrCreatedTickets', () => {
  it('advances an in_stack ticket to pr_open when linked stack is pr_created', () => {
    registry.createStack({ id: 's1', project: 'p', project_dir: '/proj', ticket: 'T-1', branch: null, description: null, status: 'pr_created', runtime: 'docker' });
    registry.setBoardTicketColumn('T-1', '/proj', 'in_stack');
    registry.reconcilePrCreatedTickets();
    const rows = registry.listBoardTickets('/proj');
    expect(rows[0].column).toBe('pr_open');
  });

  it('leaves a merged ticket at merged (forward-only)', () => {
    registry.createStack({ id: 's1', project: 'p', project_dir: '/proj', ticket: 'T-1', branch: null, description: null, status: 'pr_created', runtime: 'docker' });
    registry.setBoardTicketColumn('T-1', '/proj', 'merged');
    registry.reconcilePrCreatedTickets();
    expect(registry.listBoardTickets('/proj')[0].column).toBe('merged');
  });

  it('leaves a pr_open ticket at pr_open', () => {
    registry.createStack({ id: 's1', project: 'p', project_dir: '/proj', ticket: 'T-1', branch: null, description: null, status: 'pr_created', runtime: 'docker' });
    registry.setBoardTicketColumn('T-1', '/proj', 'pr_open');
    registry.reconcilePrCreatedTickets();
    expect(registry.listBoardTickets('/proj')[0].column).toBe('pr_open');
  });

  it('skips stacks with no linked ticket', () => {
    registry.createStack({ id: 's1', project: 'p', project_dir: '/proj', ticket: null, branch: null, description: null, status: 'pr_created', runtime: 'docker' });
    registry.reconcilePrCreatedTickets();
    expect(registry.listBoardTickets('/proj')).toHaveLength(0);
  });

  it('skips stacks not in pr_created status', () => {
    registry.createStack({ id: 's1', project: 'p', project_dir: '/proj', ticket: 'T-1', branch: null, description: null, status: 'in_stack' as any, runtime: 'docker' });
    registry.setBoardTicketColumn('T-1', '/proj', 'in_stack');
    registry.reconcilePrCreatedTickets();
    expect(registry.listBoardTickets('/proj')[0].column).toBe('in_stack');
  });

  it('is idempotent — calling twice does not break anything', () => {
    registry.createStack({ id: 's1', project: 'p', project_dir: '/proj', ticket: 'T-1', branch: null, description: null, status: 'pr_created', runtime: 'docker' });
    registry.setBoardTicketColumn('T-1', '/proj', 'in_stack');
    registry.reconcilePrCreatedTickets();
    registry.reconcilePrCreatedTickets();
    expect(registry.listBoardTickets('/proj')[0].column).toBe('pr_open');
  });
});

// --- deleteClosedEarlyColumnTickets ---

describe('deleteClosedEarlyColumnTickets', () => {
  it('removes backlog tickets absent from the open-id set', () => {
    registry.seedBoardTicket('open-1', '/proj', 'Open ticket');
    registry.seedBoardTicket('closed-1', '/proj', 'Closed ticket');
    const deleted = registry.deleteClosedEarlyColumnTickets('/proj', ['open-1']);
    const rows = registry.listBoardTickets('/proj');
    expect(deleted).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].ticket_id).toBe('open-1');
  });

  it('removes refining and spec_ready tickets absent from the open-id set', () => {
    registry.seedBoardTicket('r-1', '/proj', 'Refining');
    registry.setBoardTicketColumn('r-1', '/proj', 'refining');
    registry.seedBoardTicket('s-1', '/proj', 'Spec ready');
    registry.setBoardTicketColumn('s-1', '/proj', 'spec_ready');
    const deleted = registry.deleteClosedEarlyColumnTickets('/proj', []);
    expect(deleted).toBe(2);
    expect(registry.listBoardTickets('/proj')).toHaveLength(0);
  });

  it('leaves in_stack, pr_open, and merged tickets regardless of open-id set', () => {
    registry.setBoardTicketColumn('in-1', '/proj', 'in_stack');
    registry.setBoardTicketColumn('pr-1', '/proj', 'pr_open');
    registry.setBoardTicketColumn('m-1', '/proj', 'merged');
    const deleted = registry.deleteClosedEarlyColumnTickets('/proj', []);
    expect(deleted).toBe(0);
    const rows = registry.listBoardTickets('/proj');
    expect(rows).toHaveLength(3);
  });

  it('empty open-id set deletes all early-column rows for the project', () => {
    registry.seedBoardTicket('a', '/proj', 'A');
    registry.seedBoardTicket('b', '/proj', 'B');
    registry.setBoardTicketColumn('b', '/proj', 'refining');
    const deleted = registry.deleteClosedEarlyColumnTickets('/proj', []);
    expect(deleted).toBe(2);
    expect(registry.listBoardTickets('/proj')).toHaveLength(0);
  });

  it('is scoped to the given project_dir — does not affect other projects', () => {
    registry.seedBoardTicket('x', '/alpha', 'Alpha ticket');
    registry.seedBoardTicket('y', '/beta', 'Beta ticket');
    const deleted = registry.deleteClosedEarlyColumnTickets('/alpha', []);
    expect(deleted).toBe(1);
    expect(registry.listBoardTickets('/alpha')).toHaveLength(0);
    expect(registry.listBoardTickets('/beta')).toHaveLength(1);
  });

  it('returns 0 when there are no early-column tickets to remove', () => {
    registry.seedBoardTicket('keep-1', '/proj', 'Keep');
    const deleted = registry.deleteClosedEarlyColumnTickets('/proj', ['keep-1']);
    expect(deleted).toBe(0);
    expect(registry.listBoardTickets('/proj')).toHaveLength(1);
  });

  it('returns the correct count matching the number of rows removed', () => {
    registry.seedBoardTicket('t1', '/proj', 'T1');
    registry.seedBoardTicket('t2', '/proj', 'T2');
    registry.seedBoardTicket('t3', '/proj', 'T3');
    // Only t1 is still open
    const deleted = registry.deleteClosedEarlyColumnTickets('/proj', ['t1']);
    expect(deleted).toBe(2);
    const rows = registry.listBoardTickets('/proj');
    expect(rows).toHaveLength(1);
    expect(rows[0].ticket_id).toBe('t1');
  });

  it('a re-seeded ticket after deletion goes back to backlog', () => {
    registry.seedBoardTicket('reopen-1', '/proj', 'Reopened ticket');
    // Ticket is closed (not in open set) → deleted
    registry.deleteClosedEarlyColumnTickets('/proj', []);
    expect(registry.listBoardTickets('/proj')).toHaveLength(0);
    // Ticket is reopened → re-seed puts it in backlog
    registry.seedBoardTicket('reopen-1', '/proj', 'Reopened ticket');
    const rows = registry.listBoardTickets('/proj');
    expect(rows).toHaveLength(1);
    expect(rows[0].column).toBe('backlog');
  });
});

// --- Store-level tests ---

import { useAppStore } from '../../src/renderer/store';

const PROJECT_DIR = '/store-test-proj';

function setupSandstormMock(ticketsList: unknown[] = []) {
  Object.defineProperty(window, 'sandstorm', {
    value: {
      tickets: { list: vi.fn().mockResolvedValue(ticketsList) },
      ticketBoard: { setColumn: vi.fn().mockResolvedValue(undefined) },
    },
    writable: true,
    configurable: true,
  });
}

describe('store: refreshBoardTickets', () => {
  beforeEach(() => {
    useAppStore.setState({ boardTickets: [], boardTicketsLoading: false, boardTicketsError: null, lastTicketFetchAt: null });
  });

  it('calls tickets.list with the project dir, populates boardTickets, and clears loading state', async () => {
    const mockTickets = [
      { ticket_id: '1', project_dir: PROJECT_DIR, column: 'backlog', title: 'T1', updated_at: '' },
    ];
    setupSandstormMock(mockTickets);

    await useAppStore.getState().refreshBoardTickets(PROJECT_DIR);

    const state = useAppStore.getState();
    expect(state.boardTickets).toHaveLength(1);
    expect(state.boardTickets[0].ticket_id).toBe('1');
    expect(state.boardTicketsLoading).toBe(false);
    expect(state.lastTicketFetchAt).toBeTypeOf('number');
    expect((window.sandstorm as any).tickets.list).toHaveBeenCalledWith(PROJECT_DIR);
  });

  it('clears loading state on fetch error', async () => {
    Object.defineProperty(window, 'sandstorm', {
      value: { tickets: { list: vi.fn().mockRejectedValue(new Error('fail')) }, ticketBoard: { setColumn: vi.fn() } },
      writable: true,
      configurable: true,
    });

    await useAppStore.getState().refreshBoardTickets(PROJECT_DIR);

    const state = useAppStore.getState();
    expect(state.boardTicketsLoading).toBe(false);
    expect(state.boardTickets).toEqual([]);
  });

  it('sets boardTicketsError on fetch error', async () => {
    Object.defineProperty(window, 'sandstorm', {
      value: { tickets: { list: vi.fn().mockRejectedValue(new Error('network failure')) }, ticketBoard: { setColumn: vi.fn() } },
      writable: true,
      configurable: true,
    });

    await useAppStore.getState().refreshBoardTickets(PROJECT_DIR);

    const state = useAppStore.getState();
    expect(state.boardTicketsError).toBeTruthy();
    expect(typeof state.boardTicketsError).toBe('string');
  });

  it('clears boardTicketsError on successful fetch', async () => {
    useAppStore.setState({ boardTicketsError: 'previous error' });
    setupSandstormMock([]);

    await useAppStore.getState().refreshBoardTickets(PROJECT_DIR);

    expect(useAppStore.getState().boardTicketsError).toBeNull();
  });
});

describe('store: moveTicketColumn', () => {
  beforeEach(() => {
    setupSandstormMock();
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '42', project_dir: PROJECT_DIR, column: 'backlog', title: 'Test', updated_at: '' },
      ],
    });
  });

  it('optimistically updates boardTickets column before IPC resolves', async () => {
    let resolveIpc!: () => void;
    const ipcPromise = new Promise<void>(r => { resolveIpc = r; });
    (window.sandstorm as any).ticketBoard.setColumn = vi.fn().mockReturnValue(ipcPromise);

    const movePromise = useAppStore.getState().moveTicketColumn('42', PROJECT_DIR, 'refining');

    // Synchronously assert column changed before IPC resolves
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('refining');

    resolveIpc();
    await movePromise;
    expect((window.sandstorm as any).ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'refining');
  });

  it('matches by ticket_id only, regardless of project_dir string', async () => {
    setupSandstormMock();
    // moveTicketColumn is called with the same ticket_id but a slightly different dir string.
    // The boardTickets slice is already project-scoped, so ticket_id alone should match.
    await useAppStore.getState().moveTicketColumn('42', PROJECT_DIR + '/', 'spec_ready');
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('spec_ready');
  });

  it('reverts column when setColumn IPC rejects', async () => {
    Object.defineProperty(window, 'sandstorm', {
      value: {
        tickets: { list: vi.fn().mockResolvedValue([]) },
        ticketBoard: { setColumn: vi.fn().mockRejectedValue(new Error('IPC failure')) },
      },
      writable: true,
      configurable: true,
    });

    await useAppStore.getState().moveTicketColumn('42', PROJECT_DIR, 'spec_ready');
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('backlog');
  });

  // #388: rejection used to be swallowed with .catch(() => {}) which left the
  // card silently reverted to backlog with no error surfaced — directly producing
  // the reporter's "stuck in backlog and no feedback" symptom.
  it('surfaces moveTicketColumnError when setColumn IPC rejects (#388)', async () => {
    useAppStore.setState({ moveTicketColumnError: null });
    Object.defineProperty(window, 'sandstorm', {
      value: {
        tickets: { list: vi.fn().mockResolvedValue([]) },
        ticketBoard: { setColumn: vi.fn().mockRejectedValue(new Error('IPC boom')) },
      },
      writable: true,
      configurable: true,
    });

    await useAppStore.getState().moveTicketColumn('42', PROJECT_DIR, 'spec_ready');
    const err = useAppStore.getState().moveTicketColumnError;
    expect(err).toBeTruthy();
    expect(err).toMatch(/42/);
    expect(err).toMatch(/spec_ready/);
    expect(err).toMatch(/IPC boom/);
  });

  it('clears moveTicketColumnError on a subsequent successful move (#388)', async () => {
    useAppStore.setState({ moveTicketColumnError: 'prior failure' });
    await useAppStore.getState().moveTicketColumn('42', PROJECT_DIR, 'spec_ready');
    expect(useAppStore.getState().moveTicketColumnError).toBeNull();
  });

  it('clearMoveTicketColumnError() resets the surfaced error (#388)', () => {
    useAppStore.setState({ moveTicketColumnError: 'something failed' });
    useAppStore.getState().clearMoveTicketColumnError();
    expect(useAppStore.getState().moveTicketColumnError).toBeNull();
  });
});

// #388: spec-gate-pass → spec_ready transition is wired in the store's
// upsertRefinementSession handler (not the dialog) so that it fires even when
// the user closed the Refine dialog while the async gate was still running.
describe('store: upsertRefinementSession → spec_ready transition (#388)', () => {
  beforeEach(() => {
    setupSandstormMock();
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '310', project_dir: PROJECT_DIR, column: 'refining', title: 'T', updated_at: '' },
      ],
      refinementSessions: [],
      moveTicketColumnError: null,
    });
  });

  it('moves to spec_ready when status becomes ready && passed', async () => {
    useAppStore.getState().upsertRefinementSession({
      id: 'sess', ticketId: '310', projectDir: PROJECT_DIR,
      status: 'ready', phase: 'check', startedAt: 0,
      result: { passed: true, questions: [], gateSummary: 'PASS', ticketUrl: null, cached: false },
    });

    // setColumn is fire-and-forget from upsert; wait a microtask for the optimistic update.
    await new Promise(r => setTimeout(r, 0));
    expect((window.sandstorm as any).ticketBoard.setColumn).toHaveBeenCalledWith('310', PROJECT_DIR, 'spec_ready');
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '310');
    expect(entry?.column).toBe('spec_ready');
  });

  it('does NOT move to spec_ready when gate failed', async () => {
    useAppStore.getState().upsertRefinementSession({
      id: 'sess', ticketId: '310', projectDir: PROJECT_DIR,
      status: 'ready', phase: 'check', startedAt: 0,
      result: { passed: false, questions: [], gateSummary: 'FAIL', ticketUrl: null, cached: false },
    });
    await new Promise(r => setTimeout(r, 0));
    expect((window.sandstorm as any).ticketBoard.setColumn).not.toHaveBeenCalled();
  });

  it('does NOT move to spec_ready while the session is still running', async () => {
    useAppStore.getState().upsertRefinementSession({
      id: 'sess', ticketId: '310', projectDir: PROJECT_DIR,
      status: 'running', phase: 'check', startedAt: 0,
    });
    await new Promise(r => setTimeout(r, 0));
    expect((window.sandstorm as any).ticketBoard.setColumn).not.toHaveBeenCalled();
  });

  it('is idempotent on a re-emit — fires moveTicketColumn exactly once', async () => {
    const passedSession = {
      id: 'sess', ticketId: '310', projectDir: PROJECT_DIR,
      status: 'ready' as const, phase: 'check' as const, startedAt: 0,
      result: { passed: true, questions: [], gateSummary: 'PASS', ticketUrl: null, cached: false },
    };
    useAppStore.getState().upsertRefinementSession(passedSession);
    await new Promise(r => setTimeout(r, 0));
    expect((window.sandstorm as any).ticketBoard.setColumn).toHaveBeenCalledTimes(1);

    // A second upsert with the same ready+passed state must NOT re-fire.
    // Otherwise an in-flight 'in_stack' move could be demoted to 'spec_ready'.
    useAppStore.getState().upsertRefinementSession(passedSession);
    await new Promise(r => setTimeout(r, 0));
    expect((window.sandstorm as any).ticketBoard.setColumn).toHaveBeenCalledTimes(1);
  });

  it('final state is in_stack when Start Stack fires immediately after gate pass', async () => {
    // Simulate the documented edge case: gate-pass move fires, then user clicks
    // Start Stack which fires moveTicketColumn(in_stack). Final persisted state
    // must be in_stack (the later move wins).
    useAppStore.getState().upsertRefinementSession({
      id: 'sess', ticketId: '310', projectDir: PROJECT_DIR,
      status: 'ready', phase: 'check', startedAt: 0,
      result: { passed: true, questions: [], gateSummary: 'PASS', ticketUrl: null, cached: false },
    });
    await useAppStore.getState().moveTicketColumn('310', PROJECT_DIR, 'in_stack');
    await new Promise(r => setTimeout(r, 0));
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '310');
    expect(entry?.column).toBe('in_stack');
  });
});

describe('store: openCreatePRDialogForTicket (fallback dialog, no optimistic move)', () => {
  beforeEach(() => {
    setupSandstormMock();
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '42', project_dir: PROJECT_DIR, column: 'in_stack', title: 'Test', updated_at: '' },
      ],
      stacks: [],
      _prDialogContext: null,
    });
  });

  it('opens the dialog and sets _prDialogContext without moving the ticket column', async () => {
    useAppStore.getState().openCreatePRDialogForTicket('s1', '42', PROJECT_DIR, 'in_stack');
    await new Promise(resolve => setTimeout(resolve, 0));
    // Ticket stays in in_stack — no optimistic move
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('in_stack');
    expect(useAppStore.getState().showCreatePRDialog).toEqual({ stackId: 's1', initialError: undefined });
    expect(useAppStore.getState()._prDialogContext?.stackId).toBe('s1');
  });

  it('sets initialError in showCreatePRDialog when provided (Q4 fallback)', () => {
    useAppStore.getState().openCreatePRDialogForTicket('s1', '42', PROJECT_DIR, 'in_stack', 'gh failed');
    expect(useAppStore.getState().showCreatePRDialog).toEqual({ stackId: 's1', initialError: 'gh failed' });
  });

  it('closing the dialog clears _prDialogContext without changing the ticket column', async () => {
    useAppStore.getState().openCreatePRDialogForTicket('s1', '42', PROJECT_DIR, 'in_stack');
    await new Promise(resolve => setTimeout(resolve, 0));

    useAppStore.getState().setShowCreatePRDialog(null);
    await new Promise(resolve => setTimeout(resolve, 0));
    // Ticket is already in in_stack and stays there
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('in_stack');
    expect(useAppStore.getState()._prDialogContext).toBeNull();
    expect((window.sandstorm as any).ticketBoard.setColumn).not.toHaveBeenCalled();
  });
});

describe('store: setShowNewStackDialog revert-on-cancel', () => {
  beforeEach(() => {
    setupSandstormMock();
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '42', project_dir: PROJECT_DIR, column: 'spec_ready', title: 'Test', updated_at: '' },
      ],
      stacks: [],
      _newStackDialogContext: null,
    });
  });

  it('reverts ticket column when dialog closed with stackCreated=false', async () => {
    useAppStore.getState().openNewStackDialogForTicket('42', PROJECT_DIR, 'spec_ready');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useAppStore.getState().boardTickets.find(t => t.ticket_id === '42')?.column).toBe('in_stack');

    useAppStore.getState().setShowNewStackDialog(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('spec_ready');
  });

  it('does NOT revert when stackCreated flag is set', async () => {
    useAppStore.getState().openNewStackDialogForTicket('42', PROJECT_DIR, 'spec_ready');
    await new Promise(resolve => setTimeout(resolve, 0));

    // Simulate stack was created — set the flag
    const ctx = useAppStore.getState()._newStackDialogContext!;
    useAppStore.setState({ _newStackDialogContext: { ...ctx, stackCreated: true } });

    useAppStore.getState().setShowNewStackDialog(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('in_stack');
  });
});

describe('store: setShowRefineTicketDialog revert-on-cancel', () => {
  beforeEach(() => {
    setupSandstormMock();
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '42', project_dir: PROJECT_DIR, column: 'backlog', title: 'Test', updated_at: '' },
      ],
      refinementSessions: [],
    });
  });

  it('reverts ticket column when dialog closed with no matching refinement session', async () => {
    // Move the ticket to refining via openRefineDialogFromCard
    useAppStore.getState().openRefineDialogFromCard('42', PROJECT_DIR, 'backlog');

    // Wait for the optimistic column update
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useAppStore.getState().boardTickets.find(t => t.ticket_id === '42')?.column).toBe('refining');

    // Close dialog — no refinement session exists, so column should revert
    await new Promise(resolve => setTimeout(resolve, 0));
    useAppStore.getState().setShowRefineTicketDialog(false);

    // Wait for revert IPC
    await new Promise(resolve => setTimeout(resolve, 0));
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('backlog');
  });
});

// --- store: resolveRefinementTargets (#393) ---

function makeStack(overrides: Partial<{ id: string; ticket: string; project_dir: string }> = {}) {
  return {
    id: overrides.id ?? 'stack-1',
    project: 'proj',
    project_dir: overrides.project_dir ?? PROJECT_DIR,
    ticket: overrides.ticket ?? '42',
    branch: null,
    description: null,
    status: 'running',
    error: null,
    pr_url: null,
    pr_number: null,
    runtime: 'docker' as const,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_execution_input_tokens: 0,
    total_execution_output_tokens: 0,
    total_review_input_tokens: 0,
    total_review_output_tokens: 0,
    rate_limit_reset_at: null,
    created_at: '',
    updated_at: '',
    current_model: null,
    services: [],
  };
}

describe('store: resolveRefinementTargets (#393)', () => {
  beforeEach(() => {
    setupSandstormMock();
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '42', project_dir: PROJECT_DIR, column: 'backlog', title: 'Test', updated_at: '' },
      ],
      stacks: [],
    });
  });

  it('returns silent with backlog previousColumn when 0 stacks match', () => {
    const result = useAppStore.getState().resolveRefinementTargets('42', PROJECT_DIR);
    expect(result).toEqual({ kind: 'silent', previousColumn: 'backlog' });
  });

  it('returns confirm with stackId when exactly 1 stack matches (ticket + project_dir)', () => {
    useAppStore.setState({ stacks: [makeStack()] });
    const result = useAppStore.getState().resolveRefinementTargets('42', PROJECT_DIR);
    expect(result).toEqual({ kind: 'confirm', stackId: 'stack-1', previousColumn: 'backlog' });
  });

  it('returns error when >1 stacks match same ticket+project', () => {
    useAppStore.setState({
      stacks: [
        makeStack({ id: 'a' }),
        makeStack({ id: 'b' }),
      ],
    });
    const result = useAppStore.getState().resolveRefinementTargets('42', PROJECT_DIR);
    expect(result.kind).toBe('error');
  });

  it('does not match a stack in a different project_dir', () => {
    useAppStore.setState({ stacks: [makeStack({ project_dir: '/other-dir' })] });
    const result = useAppStore.getState().resolveRefinementTargets('42', PROJECT_DIR);
    expect(result).toEqual({ kind: 'silent', previousColumn: 'backlog' });
  });

  it('does not match a stack for a different ticket', () => {
    useAppStore.setState({ stacks: [makeStack({ ticket: '99' })] });
    const result = useAppStore.getState().resolveRefinementTargets('42', PROJECT_DIR);
    expect(result).toEqual({ kind: 'silent', previousColumn: 'backlog' });
  });

  it('returns silent (no teardown modal) when ticket is already in refining', () => {
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '42', project_dir: PROJECT_DIR, column: 'refining', title: 'T', updated_at: '' },
      ],
      stacks: [makeStack()], // live stack present, but idempotent move skips teardown prompt
    });
    const result = useAppStore.getState().resolveRefinementTargets('42', PROJECT_DIR);
    expect(result).toEqual({ kind: 'silent', previousColumn: 'refining' });
  });

  it('defaults previousColumn to backlog when ticket not in boardTickets', () => {
    useAppStore.setState({ boardTickets: [], stacks: [] });
    const result = useAppStore.getState().resolveRefinementTargets('99', PROJECT_DIR);
    expect(result).toEqual({ kind: 'silent', previousColumn: 'backlog' });
  });

  it('carries the correct previousColumn from board (e.g. spec_ready)', () => {
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '42', project_dir: PROJECT_DIR, column: 'spec_ready', title: 'T', updated_at: '' },
      ],
      stacks: [],
    });
    const result = useAppStore.getState().resolveRefinementTargets('42', PROJECT_DIR);
    expect(result).toEqual({ kind: 'silent', previousColumn: 'spec_ready' });
  });
});

describe('store: createPRAutomatic revert-on-cancel (#417)', () => {
  beforeEach(() => {
    setupSandstormMock();
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '42', project_dir: PROJECT_DIR, column: 'in_stack', title: 'Test', updated_at: '' },
      ],
      stacks: [],
      _prDialogContext: null,
      prCreateInFlight: {},
    });
  });

  it('reverts ticket to in_stack when dialog canceled after draft_failed', async () => {
    Object.defineProperty(window, 'sandstorm', {
      value: {
        tickets: { list: vi.fn().mockResolvedValue([]) },
        ticketBoard: { setColumn: vi.fn().mockResolvedValue(undefined) },
        pr: { createAuto: vi.fn().mockResolvedValue({ status: 'draft_failed' }) },
      },
      writable: true,
      configurable: true,
    });

    await useAppStore.getState().createPRAutomatic('s1', '42', PROJECT_DIR, 'in_stack');

    // After draft_failed the ticket should be at pr_open (optimistic move) and dialog should open
    const afterFail = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(afterFail?.column).toBe('pr_open');
    expect(useAppStore.getState().showCreatePRDialog).toEqual({ stackId: 's1', initialError: undefined });

    // User cancels dialog
    useAppStore.getState().setShowCreatePRDialog(null);
    await new Promise(resolve => setTimeout(resolve, 0));

    // Ticket must revert to in_stack
    const afterCancel = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(afterCancel?.column).toBe('in_stack');
    expect(useAppStore.getState()._prDialogContext).toBeNull();
  });

  it('reverts ticket to in_stack when dialog canceled after create_failed', async () => {
    const draft = { title: 'My PR', body: 'Description' };
    Object.defineProperty(window, 'sandstorm', {
      value: {
        tickets: { list: vi.fn().mockResolvedValue([]) },
        ticketBoard: { setColumn: vi.fn().mockResolvedValue(undefined) },
        pr: { createAuto: vi.fn().mockResolvedValue({ status: 'create_failed', draft, error: 'gh failed' }) },
      },
      writable: true,
      configurable: true,
    });

    await useAppStore.getState().createPRAutomatic('s1', '42', PROJECT_DIR, 'in_stack');

    // After create_failed the ticket should be at pr_open (optimistic move) and dialog should open with error
    const afterFail = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(afterFail?.column).toBe('pr_open');
    expect(useAppStore.getState().showCreatePRDialog).toEqual({ stackId: 's1', initialError: 'gh failed' });
    expect(useAppStore.getState().prDraftCache['s1']).toEqual(draft);

    // User cancels dialog
    useAppStore.getState().setShowCreatePRDialog(null);
    await new Promise(resolve => setTimeout(resolve, 0));

    // Ticket must revert to in_stack
    const afterCancel = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(afterCancel?.column).toBe('in_stack');
    expect(useAppStore.getState()._prDialogContext).toBeNull();
  });
});

describe('store: commitRefinementContext (#393)', () => {
  beforeEach(() => {
    setupSandstormMock();
    useAppStore.setState({
      boardTickets: [
        { ticket_id: '42', project_dir: PROJECT_DIR, column: 'backlog', title: 'Test', updated_at: '' },
      ],
      refinementSessions: [],
      _refineDialogContext: null,
    });
  });

  it('stashes _refineDialogContext with correct fields', async () => {
    useAppStore.getState().commitRefinementContext('42', PROJECT_DIR, 'backlog');
    const ctx = useAppStore.getState()._refineDialogContext;
    expect(ctx).toEqual({ ticketId: '42', projectDir: PROJECT_DIR, previousColumn: 'backlog' });
  });

  it('moves ticket to refining via moveTicketColumn', async () => {
    useAppStore.getState().commitRefinementContext('42', PROJECT_DIR, 'backlog');
    await new Promise(r => setTimeout(r, 0));
    expect((window.sandstorm as any).ticketBoard.setColumn).toHaveBeenCalledWith('42', PROJECT_DIR, 'refining');
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('refining');
  });

  it('reverts column when dialog closed after commitRefinementContext with no session', async () => {
    useAppStore.getState().commitRefinementContext('42', PROJECT_DIR, 'backlog');
    await new Promise(r => setTimeout(r, 0));
    expect(useAppStore.getState().boardTickets.find(t => t.ticket_id === '42')?.column).toBe('refining');

    useAppStore.getState().setShowRefineTicketDialog(false);
    await new Promise(r => setTimeout(r, 0));
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('backlog');
  });
});
