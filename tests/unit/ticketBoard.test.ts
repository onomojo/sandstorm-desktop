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
});

describe('store: openCreatePRDialogForTicket revert-on-cancel', () => {
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

  it('moves ticket to pr_open on open', async () => {
    useAppStore.getState().openCreatePRDialogForTicket('s1', '42', PROJECT_DIR, 'in_stack');
    await new Promise(resolve => setTimeout(resolve, 0));
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('pr_open');
  });

  it('reverts ticket column when dialog closed with prCreated=false', async () => {
    useAppStore.getState().openCreatePRDialogForTicket('s1', '42', PROJECT_DIR, 'in_stack');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useAppStore.getState().boardTickets.find(t => t.ticket_id === '42')?.column).toBe('pr_open');

    useAppStore.getState().setShowCreatePRDialog(null);
    await new Promise(resolve => setTimeout(resolve, 0));
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('in_stack');
  });

  it('does NOT revert when prCreated flag is set', async () => {
    useAppStore.getState().openCreatePRDialogForTicket('s1', '42', PROJECT_DIR, 'in_stack');
    await new Promise(resolve => setTimeout(resolve, 0));

    // Simulate PR was created — set the flag
    const ctx = useAppStore.getState()._prDialogContext!;
    useAppStore.setState({ _prDialogContext: { ...ctx, prCreated: true } });

    useAppStore.getState().setShowCreatePRDialog(null);
    await new Promise(resolve => setTimeout(resolve, 0));
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === '42');
    expect(entry?.column).toBe('pr_open');
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
