import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TicketRollupStore } from '../../../src/main/telemetry/rollup-store';
import { ORCHESTRATOR_TICKET_ID } from '../../../src/main/telemetry/attribution';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE stacks (
      id          TEXT PRIMARY KEY,
      ticket      TEXT,
      project_dir TEXT NOT NULL DEFAULT '/proj',
      status      TEXT NOT NULL DEFAULT 'completed'
    );
    CREATE TABLE tasks (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      stack_id              TEXT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      resolved_model        TEXT
    );
    CREATE TABLE stack_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      stack_id     TEXT NOT NULL,
      ticket       TEXT,
      task_history TEXT,
      final_status TEXT NOT NULL DEFAULT 'completed'
    );
    CREATE TABLE ticket_board (
      ticket_id   TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      column      TEXT NOT NULL DEFAULT 'backlog',
      title       TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (ticket_id, project_dir)
    );
    CREATE TABLE ticket_rollups (
      ticket_id            TEXT PRIMARY KEY,
      title                TEXT NOT NULL DEFAULT '',
      column               TEXT,
      total_cost           REAL NOT NULL DEFAULT 0,
      total_input_tokens   INTEGER NOT NULL DEFAULT 0,
      total_output_tokens  INTEGER NOT NULL DEFAULT 0,
      total_cache_read     INTEGER NOT NULL DEFAULT 0,
      total_cache_creation INTEGER NOT NULL DEFAULT 0,
      primary_model        TEXT,
      unpriced             INTEGER NOT NULL DEFAULT 0,
      computed_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE rollup_dirty_stacks (
      stack_id  TEXT PRIMARY KEY,
      marked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('TicketRollupStore', () => {
  let db: Database.Database;
  let store: TicketRollupStore;

  beforeEach(() => {
    db = makeDb();
    store = new TicketRollupStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('works with rollup tables pre-created by registry migrations', () => {
    const tables = (db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ticket_rollups','rollup_dirty_stacks')
    `).all() as { name: string }[]).map(r => r.name).sort();
    expect(tables).toEqual(['rollup_dirty_stacks', 'ticket_rollups']);
  });

  it('returns empty array when no data exists', () => {
    expect(store.getByTicket()).toEqual([]);
  });

  it('getByTicket triggers a refresh when dirty stacks exist', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-1')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 500, 200, 'claude-sonnet-4-5')`);
    store.markStackDirty('s1');

    const rollups = store.getByTicket();
    expect(rollups).toHaveLength(1);
    expect(rollups[0].ticketId).toBe('TICKET-1');
  });

  it('serves from cache after initial refresh (dirty_stacks is cleared)', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-2')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 100, 50, 'claude-sonnet-4-5')`);
    store.refresh();

    // No dirty stacks — should serve from cache
    const dirtyCount = (db.prepare('SELECT COUNT(*) AS n FROM rollup_dirty_stacks').get() as { n: number }).n;
    expect(dirtyCount).toBe(0);

    const rollups = store.getByTicket();
    expect(rollups).toHaveLength(1);
  });

  it('refresh() rebuilds rollups from scratch', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-3')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 1000, 500, 'claude-sonnet-4-5')`);
    store.refresh();

    const rollups = store.getByTicket();
    expect(rollups[0].tokens.input).toBe(1000);
  });

  it('rollups persist across simulated teardown (stack_history)', () => {
    // Simulate archival: stack_history has the historical tasks
    const hist = JSON.stringify([{
      input_tokens: 3000,
      output_tokens: 1500,
      cache_read_tokens: 500,
      cache_creation_tokens: 0,
      resolved_model: 'claude-sonnet-4-5',
    }]);
    db.exec(`INSERT INTO stack_history (stack_id, ticket, task_history) VALUES ('s-old', 'TICKET-HIST', '${hist}')`);
    store.refresh();

    const rollups = store.getByTicket();
    expect(rollups[0].ticketId).toBe('TICKET-HIST');
    expect(rollups[0].tokens.input).toBe(3000);
    expect(rollups[0].tokens.cacheRead).toBe(500);
  });

  it('incremental dirty-stack re-derive: only re-computes when dirty', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-INC')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 200, 100, 'claude-sonnet-4-5')`);
    store.refresh();

    // Simulate new task tokens — mark dirty
    store.markStackDirty('s1');
    db.exec(`UPDATE tasks SET input_tokens = 400, output_tokens = 200 WHERE stack_id = 's1'`);

    const rollups = store.getByTicket();
    expect(rollups[0].tokens.input).toBe(400);
  });

  it('markDirty() (for board moves) triggers refresh on next getByTicket', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-B')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 100, 50, 'claude-sonnet-4-5')`);
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('TICKET-B', '/proj', 'pr_open', 'Board Ticket')`);
    store.refresh();

    // Simulate board move to merged
    db.exec(`UPDATE ticket_board SET column = 'merged' WHERE ticket_id = 'TICKET-B'`);
    store.markDirty();

    const rollups = store.getByTicket();
    expect(rollups[0].column).toBe('merged');
  });

  it('cacheHit is 0 for all-zero-token ticket (division-by-zero guard)', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-ZERO')`);
    db.exec(`INSERT INTO tasks (stack_id, resolved_model) VALUES ('s1', 'claude-sonnet-4-5')`);
    store.refresh();

    const rollups = store.getByTicket();
    expect(rollups[0].cacheHit).toBe(0);
    expect(Number.isNaN(rollups[0].cacheHit)).toBe(false);
  });

  it('cacheHit is 0 for historical pre-capture tasks (cache_read_tokens DEFAULT 0)', () => {
    const hist = JSON.stringify([{ input_tokens: 500, output_tokens: 200, resolved_model: 'claude-sonnet-4-5' }]);
    db.exec(`INSERT INTO stack_history (stack_id, ticket, task_history) VALUES ('s1', 'TICKET-PRE', '${hist}')`);
    store.refresh();

    const rollups = store.getByTicket();
    expect(rollups[0].cacheHit).toBe(0);
  });

  it('mixed ticket: pre-capture and post-capture tasks blend cacheHit correctly', () => {
    // Historical task: no cache tokens
    const hist = JSON.stringify([{ input_tokens: 500, output_tokens: 200, resolved_model: 'claude-sonnet-4-5' }]);
    db.exec(`INSERT INTO stack_history (stack_id, ticket, task_history) VALUES ('s-old', 'TICKET-MIX', '${hist}')`);

    // Live task: has cache tokens
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s-live', 'TICKET-MIX')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, cache_read_tokens, resolved_model) VALUES ('s-live', 500, 200, 200, 'claude-sonnet-4-5')`);
    store.refresh();

    const rollups = store.getByTicket();
    // Total input = 1000, total cache_read = 200
    // cacheHit = 200 / (1000 + 200) * 100 ≈ 16.67%
    expect(rollups[0].cacheHit).toBeCloseTo(200 / 1200 * 100, 3);
  });

  it('orchestrator bucket appears last', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-A'), ('s2', NULL)`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 1000, 500, 'claude-sonnet-4-5')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s2', 500, 200, 'claude-sonnet-4-5')`);
    store.refresh();

    const rollups = store.getByTicket();
    expect(rollups[rollups.length - 1].ticketId).toBe(ORCHESTRATOR_TICKET_ID);
  });

  it('ticketsShipped() counts merged-column tickets', () => {
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('T-DONE', '/proj', 'merged', 'Done')`);
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('T-WIP', '/proj', 'in_stack', 'WIP')`);
    expect(store.ticketsShipped()).toBe(1);
  });

  it('totalTicketCost() excludes orchestrator bucket', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-COST'), ('s2', NULL)`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 1000, 500, 'claude-sonnet-4-5')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s2', 500, 200, 'claude-sonnet-4-5')`);
    store.refresh();

    const orcCost = store.totalTicketCost();
    // Only TICKET-COST's cost; orchestrator excluded
    const allRollups = store.getByTicket();
    const ticketCost = allRollups.find(r => r.ticketId === 'TICKET-COST')?.cost ?? 0;
    expect(orcCost).toBeCloseTo(ticketCost, 10);
  });
});
