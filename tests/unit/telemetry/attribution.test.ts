import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { countTicketsShipped, ORCHESTRATOR_TICKET_ID } from '../../../src/main/telemetry/attribution';

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

  // ORCHESTRATOR_TICKET_ID is kept and exported — verify it is defined
  it('ORCHESTRATOR_TICKET_ID is a non-empty string', () => {
    expect(typeof ORCHESTRATOR_TICKET_ID).toBe('string');
    expect(ORCHESTRATOR_TICKET_ID.length).toBeGreaterThan(0);
  });
});
