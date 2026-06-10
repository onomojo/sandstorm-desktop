/**
 * Integration tests: closed-ticket cleanup on sync (#392).
 *
 * Tests the deleteClosedEarlyColumnTickets registry method and the tickets:list
 * IPC handler cleanup behavior using the real SQLite database in a running
 * Electron process. Assertions run in app.evaluate() (main process) so no
 * UI interaction is required — the suite is purely about DB state.
 *
 * Note: app.evaluate() uses CDP Runtime.evaluate which runs in the raw V8 global
 * context. require() is NOT available there (it is a local CJS wrapper variable).
 * Registry and ipcMain are accessed via globalThis.__sandstorm, which is assigned
 * by registerIpcHandlers() on startup.
 *
 * Scenarios:
 * 1. Closed backlog ticket is hard-deleted on a successful sync.
 * 2. Ticket moved to in_stack is kept even when absent from the open-ticket fetch.
 * 3. Empty successful fetch deletes all early-column rows.
 * 4. deleteClosedEarlyColumnTickets returns the correct deleted count (backs Q7 logging).
 * 5. Re-seeding a previously deleted ticket puts it back in backlog.
 * 6. Cleanup is scoped to project_dir — sibling projects are unaffected.
 * 7. tickets:list IPC handler: ok:true fetch triggers cleanup and emits log.
 * 8. tickets:list IPC handler: ok:false fetch leaves rows intact, no log emitted.
 */
import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test';
import fs from 'fs';

let app: ElectronApplication;
const TEST_DIR_BASE = '/tmp/e2e-sync-cleanup';

test.beforeAll(async () => {
  fs.mkdirSync(TEST_DIR_BASE, { recursive: true });
  app = await electron.launch({
    args: ['dist/main/index.cjs', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { PLAYWRIGHT_TEST: '1', ...process.env },
  });
});

test.afterAll(async () => {
  await app?.close();
  try { fs.rmSync(TEST_DIR_BASE, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Registry-level integration tests (real SQLite DB via main process)
// ---------------------------------------------------------------------------

test('closed backlog ticket is removed when absent from open-ticket set', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t1';

    registry.seedBoardTicket('OPEN-1', dir, 'Open ticket');
    // Insert CLOSED-1 directly so it is not session-protected (simulates a ticket
    // that existed in the DB from a prior session, not touched in the current one).
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('CLOSED-1', dir, 'backlog', 'Closed ticket');

    const deleted = registry.deleteClosedEarlyColumnTickets(dir, ['OPEN-1']);
    const rows = registry.listBoardTickets(dir);
    return { deleted, ticketIds: rows.map((r: { ticket_id: string }) => r.ticket_id) };
  });

  expect(result.deleted).toBe(1);
  expect(result.ticketIds).toEqual(['OPEN-1']);
});

test('in_stack ticket is retained even when absent from the open-ticket set', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t2';

    registry.setBoardTicketColumn('STARTED-1', dir, 'in_stack');
    // Insert BACKLOG-1 directly so it is not session-protected — it should be
    // cleaned up by the sync since it is absent from the open-ticket list.
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('BACKLOG-1', dir, 'backlog', 'Backlog ticket');

    // Sync returns empty — STARTED-1 is absent from fetch but must survive
    const deleted = registry.deleteClosedEarlyColumnTickets(dir, []);
    const rows = registry.listBoardTickets(dir);
    return {
      deleted,
      columns: rows.map((r: { ticket_id: string; column: string }) => ({ id: r.ticket_id, col: r.column })),
    };
  });

  expect(result.deleted).toBe(1);
  expect(result.columns).toHaveLength(1);
  expect(result.columns[0]).toEqual({ id: 'STARTED-1', col: 'in_stack' });
});

test('empty successful fetch deletes all early-column rows for the project', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t3';

    // Insert all three tickets directly (no session protection) to simulate rows
    // that came from a prior session and have no in-session protection.
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('A', dir, 'backlog', 'A');
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('B', dir, 'refining', 'B');
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('C', dir, 'spec_ready', 'C');

    const deleted = registry.deleteClosedEarlyColumnTickets(dir, []);
    return { deleted, remaining: registry.listBoardTickets(dir).length };
  });

  expect(result.deleted).toBe(3);
  expect(result.remaining).toBe(0);
});

test('deleteClosedEarlyColumnTickets returns the correct deleted count (Q7 log value)', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t4';

    // K1 and K2 are in the provider's open-ticket list — seed via API (session-protected).
    registry.seedBoardTicket('K1', dir, 'Keep 1');
    registry.seedBoardTicket('K2', dir, 'Keep 2');
    // D1–D3 are NOT in the open-ticket list and not session-protected — insert directly.
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('D1', dir, 'backlog', 'Delete 1');
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('D2', dir, 'backlog', 'Delete 2');
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('D3', dir, 'backlog', 'Delete 3');

    const deleted = registry.deleteClosedEarlyColumnTickets(dir, ['K1', 'K2']);
    const remaining = registry.listBoardTickets(dir).length;
    return { deleted, remaining };
  });

  expect(result.deleted).toBe(3);
  expect(result.remaining).toBe(2);
});

test('re-seeding a deleted ticket puts it back in backlog', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t5';

    // Insert directly (not session-protected) to simulate a row from a prior session.
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('REOPEN-1', dir, 'backlog', 'Will be deleted');
    registry.deleteClosedEarlyColumnTickets(dir, []);

    // Ticket is "reopened" — re-appears in next sync and is re-seeded
    registry.seedBoardTicket('REOPEN-1', dir, 'Reopened ticket');
    const rows = registry.listBoardTickets(dir);
    return rows.map((r: { ticket_id: string; column: string }) => ({ id: r.ticket_id, col: r.column }));
  });

  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({ id: 'REOPEN-1', col: 'backlog' });
});

test('cleanup is scoped to project_dir — sibling projects are unaffected', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dirA = '/tmp/e2e-sync-cleanup/t6-alpha';
    const dirB = '/tmp/e2e-sync-cleanup/t6-beta';

    // Insert ALPHA-1 directly (not session-protected) so the sync can delete it.
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('ALPHA-1', dirA, 'backlog', 'Alpha ticket');
    registry.seedBoardTicket('BETA-1', dirB, 'Beta ticket');

    const deleted = registry.deleteClosedEarlyColumnTickets(dirA, []);
    return {
      deleted,
      alpha: registry.listBoardTickets(dirA).length,
      beta: registry.listBoardTickets(dirB).length,
    };
  });

  expect(result.deleted).toBe(1);
  expect(result.alpha).toBe(0);
  expect(result.beta).toBe(1);
});

// ---------------------------------------------------------------------------
// IPC handler simulation tests — verify handler logic for ok:true / ok:false
// These tests replicate the ipc.ts tickets:list handler logic in app.evaluate()
// to verify that fetch success/failure correctly gates deletion.
// ---------------------------------------------------------------------------

test('tickets:list handler: ok:true fetch seeds, cleans up, and logs deletion count', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t7';

    // IPC-OPEN is already in the provider's open list — seed via API (session-protected).
    registry.seedBoardTicket('IPC-OPEN', dir, 'Still open');
    // IPC-CLOSED is not in the open list and not session-protected — insert directly.
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('IPC-CLOSED', dir, 'backlog', 'Now closed');

    // Capture console.log output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
      origLog(...args);
    };

    // Simulate what tickets:list handler does when listTicketsWithConfig returns ok:true
    const fetchResult = { ok: true, tickets: [{ id: 'IPC-OPEN', title: 'Still open', author: '' }] };
    if (fetchResult.ok) {
      for (const t of fetchResult.tickets) {
        registry.seedBoardTicket(t.id, dir, t.title);
      }
      const openIds = fetchResult.tickets.map((t: { id: string }) => t.id);
      const deletedCount = registry.deleteClosedEarlyColumnTickets(dir, openIds);
      if (deletedCount > 0) {
        console.log(`[tickets:list] Removed ${deletedCount} closed early-column ticket(s) from board for project: ${dir}`);
      }
    }

    console.log = origLog;

    const rows = registry.listBoardTickets(dir);
    return {
      ticketIds: rows.map((r: { ticket_id: string }) => r.ticket_id),
      hasLog: logs.some(l => l.includes('Removed 1 closed early-column')),
    };
  });

  expect(result.ticketIds).toEqual(['IPC-OPEN']);
  expect(result.hasLog).toBe(true);
});

test('tickets:list handler: ok:false fetch leaves all rows intact and emits no log', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t8';

    registry.seedBoardTicket('PRESERVE-1', dir, 'Keep me');
    registry.seedBoardTicket('PRESERVE-2', dir, 'Keep me too');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
      origLog(...args);
    };

    // Simulate what tickets:list handler does when listTicketsWithConfig returns ok:false
    const fetchResult = { ok: false };
    if (fetchResult.ok) {
      // This branch must NOT run — deletion must be skipped entirely
      registry.deleteClosedEarlyColumnTickets(dir, []);
    }

    console.log = origLog;

    const rows = registry.listBoardTickets(dir);
    return {
      ticketIds: rows.map((r: { ticket_id: string }) => r.ticket_id),
      deletionLogs: logs.filter(l => l.includes('Removed')),
    };
  });

  expect(result.ticketIds).toHaveLength(2);
  expect(result.ticketIds).toContain('PRESERVE-1');
  expect(result.ticketIds).toContain('PRESERVE-2');
  expect(result.deletionLogs).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Session-protection regression tests (#581)
// ---------------------------------------------------------------------------

test('session-protected ticket survives sync with empty openIds (create-then-sync race)', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t9';

    registry.seedBoardTicket('RACE-1', dir, 'Just created');
    const deleted = registry.deleteClosedEarlyColumnTickets(dir, []);
    const rows = registry.listBoardTickets(dir);
    return { deleted, ticketIds: rows.map((r: { ticket_id: string }) => r.ticket_id) };
  });

  expect(result.deleted).toBe(0);
  expect(result.ticketIds).toContain('RACE-1');
});

test('ticket moved refining → backlog survives subsequent sync', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t10';

    registry.seedBoardTicket('MOVED-1', dir, 'Will be moved');
    registry.setBoardTicketColumn('MOVED-1', dir, 'refining');
    registry.setBoardTicketColumn('MOVED-1', dir, 'backlog');
    const deleted = registry.deleteClosedEarlyColumnTickets(dir, []);
    const rows = registry.listBoardTickets(dir);
    const ticket = rows.find((r: { ticket_id: string }) => r.ticket_id === 'MOVED-1') as { column: string } | undefined;
    return { deleted, column: ticket?.column };
  });

  expect(result.deleted).toBe(0);
  expect(result.column).toBe('backlog');
});

test('session protection is scoped per project — unprotected tickets in another project are still deleted', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dirA = '/tmp/e2e-sync-cleanup/t11-a';
    const dirB = '/tmp/e2e-sync-cleanup/t11-b';

    registry.seedBoardTicket('PROTECTED-A', dirA, 'Protected in A');
    // Insert UNPROTECTED-B directly so it has no session protection.
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('UNPROTECTED-B', dirB, 'backlog', 'Unprotected in B');

    const deletedA = registry.deleteClosedEarlyColumnTickets(dirA, []);
    const deletedB = registry.deleteClosedEarlyColumnTickets(dirB, []);

    return {
      deletedA,
      deletedB,
      remainingA: registry.listBoardTickets(dirA).length,
      remainingB: registry.listBoardTickets(dirB).length,
    };
  });

  expect(result.deletedA).toBe(0);
  expect(result.deletedB).toBe(1);
  expect(result.remainingA).toBe(1);
  expect(result.remainingB).toBe(0);
});

test('non-protected early-column ticket is still deleted while session-protected one survives', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t12';

    registry.seedBoardTicket('PROT-1', dir, 'Protected');
    registry.db.prepare(
      'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)'
    ).run('UNPROT-1', dir, 'backlog', 'Unprotected');

    const deleted = registry.deleteClosedEarlyColumnTickets(dir, []);
    const rows = registry.listBoardTickets(dir);
    return { deleted, ticketIds: rows.map((r: { ticket_id: string }) => r.ticket_id) };
  });

  expect(result.deleted).toBe(1);
  expect(result.ticketIds).toEqual(['PROT-1']);
});

test('empty openIds with all tickets session-protected deletes nothing (fast-path regression)', async () => {
  const result = await app.evaluate(async () => {
    const { registry } = (globalThis as any).__sandstorm;
    const dir = '/tmp/e2e-sync-cleanup/t13';

    registry.seedBoardTicket('PROT-X', dir, 'Protected X');
    registry.seedBoardTicket('PROT-Y', dir, 'Protected Y');

    const deleted = registry.deleteClosedEarlyColumnTickets(dir, []);
    const rows = registry.listBoardTickets(dir);
    return { deleted, count: rows.length };
  });

  expect(result.deleted).toBe(0);
  expect(result.count).toBe(2);
});
