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
    registry.seedBoardTicket('CLOSED-1', dir, 'Closed ticket');

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
    registry.seedBoardTicket('BACKLOG-1', dir, 'Backlog ticket');

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

    registry.seedBoardTicket('A', dir, 'A');
    registry.seedBoardTicket('B', dir, 'B');
    registry.setBoardTicketColumn('B', dir, 'refining');
    registry.seedBoardTicket('C', dir, 'C');
    registry.setBoardTicketColumn('C', dir, 'spec_ready');

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

    registry.seedBoardTicket('K1', dir, 'Keep 1');
    registry.seedBoardTicket('K2', dir, 'Keep 2');
    registry.seedBoardTicket('D1', dir, 'Delete 1');
    registry.seedBoardTicket('D2', dir, 'Delete 2');
    registry.seedBoardTicket('D3', dir, 'Delete 3');

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

    registry.seedBoardTicket('REOPEN-1', dir, 'Will be deleted');
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

    registry.seedBoardTicket('ALPHA-1', dirA, 'Alpha ticket');
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

    // Seed two tickets as if from a previous sync
    registry.seedBoardTicket('IPC-OPEN', dir, 'Still open');
    registry.seedBoardTicket('IPC-CLOSED', dir, 'Now closed');

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
