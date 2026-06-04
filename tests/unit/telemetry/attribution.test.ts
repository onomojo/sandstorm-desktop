import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { computeTicketRollups, countTicketsShipped, ORCHESTRATOR_TICKET_ID } from '../../../src/main/telemetry/attribution';

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
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      stack_id             TEXT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
      input_tokens         INTEGER NOT NULL DEFAULT 0,
      output_tokens        INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      resolved_model       TEXT
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
  `);
  return db;
}

describe('computeTicketRollups', () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('returns empty array when no tasks exist', () => {
    expect(computeTicketRollups(db)).toEqual([]);
  });

  it('attributes live tasks to ticket via stacks join', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-1')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 1000, 500, 'claude-sonnet-4-5')`);
    const rollups = computeTicketRollups(db);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].ticketId).toBe('TICKET-1');
    expect(rollups[0].tokens.input).toBe(1000);
    expect(rollups[0].tokens.output).toBe(500);
    expect(rollups[0].cost).toBeGreaterThan(0);
  });

  it('rolls tasks with null ticket into orchestrator bucket', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', NULL)`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 500, 200, 'claude-sonnet-4-5')`);
    const rollups = computeTicketRollups(db);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].ticketId).toBe(ORCHESTRATOR_TICKET_ID);
    expect(rollups[0].title).toBe('Orchestrator / ad-hoc');
    expect(rollups[0].column).toBeNull();
  });

  it('attributes post-teardown tasks from stack_history.task_history', () => {
    const taskHistory = JSON.stringify([{
      input_tokens: 2000,
      output_tokens: 1000,
      cache_read_tokens: 500,
      cache_creation_tokens: 100,
      resolved_model: 'claude-sonnet-4-5',
    }]);
    db.exec(`INSERT INTO stack_history (stack_id, ticket, task_history) VALUES ('s-archived', 'TICKET-2', '${taskHistory}')`);
    const rollups = computeTicketRollups(db);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].ticketId).toBe('TICKET-2');
    expect(rollups[0].tokens.input).toBe(2000);
    expect(rollups[0].tokens.cacheRead).toBe(500);
  });

  it('merges live and historical tasks for the same ticket', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-3')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 300, 100, 'claude-sonnet-4-5')`);
    const hist = JSON.stringify([{ input_tokens: 700, output_tokens: 200, resolved_model: 'claude-sonnet-4-5' }]);
    db.exec(`INSERT INTO stack_history (stack_id, ticket, task_history) VALUES ('s2', 'TICKET-3', '${hist}')`);
    const rollups = computeTicketRollups(db);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].tokens.input).toBe(1000);
  });

  it('handles null ticket in stack_history — rolls up under orchestrator', () => {
    const hist = JSON.stringify([{ input_tokens: 100, output_tokens: 50, resolved_model: 'claude-haiku-4-5' }]);
    db.exec(`INSERT INTO stack_history (stack_id, ticket, task_history) VALUES ('s-hist', NULL, '${hist}')`);
    const rollups = computeTicketRollups(db);
    expect(rollups[0].ticketId).toBe(ORCHESTRATOR_TICKET_ID);
  });

  it('computes cacheHit correctly', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-4')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, cache_read_tokens, resolved_model) VALUES ('s1', 900, 100, 100, 'claude-sonnet-4-5')`);
    const rollups = computeTicketRollups(db);
    // cacheHit = 100 / (900 + 100) * 100 = 10%
    expect(rollups[0].cacheHit).toBeCloseTo(10, 5);
  });

  it('returns cacheHit = 0 for all-zero-token ticket (division-by-zero guard)', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-5')`);
    db.exec(`INSERT INTO tasks (stack_id, resolved_model) VALUES ('s1', 'claude-sonnet-4-5')`);
    const rollups = computeTicketRollups(db);
    expect(rollups[0].cacheHit).toBe(0);
    expect(Number.isNaN(rollups[0].cacheHit)).toBe(false);
  });

  it('returns cacheHit = 0 for historical pre-capture tasks (cache columns at DEFAULT 0)', () => {
    // Historical tasks have no cc/cr data — DEFAULT 0 means cacheHit = 0
    const hist = JSON.stringify([{ input_tokens: 500, output_tokens: 200, resolved_model: 'claude-sonnet-4-5' }]);
    db.exec(`INSERT INTO stack_history (stack_id, ticket, task_history) VALUES ('s1', 'TICKET-PRE', '${hist}')`);
    const rollups = computeTicketRollups(db);
    expect(rollups[0].cacheHit).toBe(0);
  });

  it('selects primary model as the one with highest output tokens', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-6')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 100, 50, 'claude-haiku-4-5')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 500, 300, 'claude-sonnet-4-5')`);
    const rollups = computeTicketRollups(db);
    expect(rollups[0].model).toBe('claude-sonnet-4-5');
  });

  it('enriches title and column from ticket_board', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-7')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 100, 50, 'claude-sonnet-4-5')`);
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('TICKET-7', '/proj', 'pr_open', 'My Feature')`);
    const rollups = computeTicketRollups(db);
    expect(rollups[0].title).toBe('My Feature');
    expect(rollups[0].column).toBe('pr_open');
  });

  it('places orchestrator bucket last in sorted output', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-A'), ('s2', NULL)`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 1000, 500, 'claude-sonnet-4-5')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s2', 500, 200, 'claude-sonnet-4-5')`);
    const rollups = computeTicketRollups(db);
    expect(rollups[rollups.length - 1].ticketId).toBe(ORCHESTRATOR_TICKET_ID);
  });

  it('marks unpriced=true for unknown model', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-U')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 100, 50, 'unknown-model-xyz')`);
    const rollups = computeTicketRollups(db);
    expect(rollups[0].unpriced).toBe(true);
    expect(rollups[0].cost).toBe(0);
  });

  it('lifecycle is null (pending sub-issue 4)', () => {
    db.exec(`INSERT INTO stacks (id, ticket) VALUES ('s1', 'TICKET-L')`);
    db.exec(`INSERT INTO tasks (stack_id, input_tokens, output_tokens, resolved_model) VALUES ('s1', 100, 50, 'claude-sonnet-4-5')`);
    const rollups = computeTicketRollups(db);
    expect(rollups[0].lifecycle).toBeNull();
  });
});

describe('countTicketsShipped', () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('returns 0 when no tickets are shipped', () => {
    expect(countTicketsShipped(db)).toBe(0);
  });

  it('counts tickets with column=merged in ticket_board', () => {
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('T-1', '/proj', 'merged', 'Done')`);
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('T-2', '/proj', 'pr_open', 'In flight')`);
    expect(countTicketsShipped(db)).toBe(1);
  });

  it('counts stacks with pr_created/pushed status that have no board row', () => {
    db.exec(`INSERT INTO stacks (id, ticket, status) VALUES ('s1', 'T-PUSHED', 'pushed')`);
    db.exec(`INSERT INTO stacks (id, ticket, status) VALUES ('s2', 'T-PR', 'pr_created')`);
    expect(countTicketsShipped(db)).toBe(2);
  });

  it('does not double-count tickets that appear in both board and stacks', () => {
    db.exec(`INSERT INTO stacks (id, ticket, status) VALUES ('s1', 'T-BOTH', 'pushed')`);
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('T-BOTH', '/proj', 'merged', 'Done')`);
    expect(countTicketsShipped(db)).toBe(1);
  });

  it('counts archived stacks with pr_created/pushed final_status that have no board row', () => {
    db.exec(`INSERT INTO stack_history (stack_id, ticket, final_status) VALUES ('s-old', 'T-ARCHIVED', 'pushed')`);
    expect(countTicketsShipped(db)).toBe(1);
  });

  it('counts both pr_created and pushed final_status in stack_history', () => {
    db.exec(`INSERT INTO stack_history (stack_id, ticket, final_status) VALUES ('s1', 'T-PUSHED', 'pushed')`);
    db.exec(`INSERT INTO stack_history (stack_id, ticket, final_status) VALUES ('s2', 'T-PR', 'pr_created')`);
    expect(countTicketsShipped(db)).toBe(2);
  });

  it('does not count archived stacks with non-shipped final_status', () => {
    db.exec(`INSERT INTO stack_history (stack_id, ticket, final_status) VALUES ('s1', 'T-FAIL', 'failed')`);
    db.exec(`INSERT INTO stack_history (stack_id, ticket, final_status) VALUES ('s2', 'T-COMP', 'completed')`);
    expect(countTicketsShipped(db)).toBe(0);
  });

  it('does not double-count a ticket in stack_history that already has a merged board row', () => {
    db.exec(`INSERT INTO stack_history (stack_id, ticket, final_status) VALUES ('s-old', 'T-BOARD', 'pushed')`);
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('T-BOARD', '/proj', 'merged', 'Done')`);
    expect(countTicketsShipped(db)).toBe(1);
  });

  it('does not double-count a ticket in both live stacks and stack_history', () => {
    db.exec(`INSERT INTO stacks (id, ticket, status) VALUES ('s-live', 'T-DUP', 'pushed')`);
    db.exec(`INSERT INTO stack_history (stack_id, ticket, final_status) VALUES ('s-old', 'T-DUP', 'pushed')`);
    expect(countTicketsShipped(db)).toBe(1);
  });
});
