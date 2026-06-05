import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TicketRollupStore } from '../../../src/main/telemetry/rollup-store';

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

  it('ticketsShipped() returns 0 when no tickets are shipped', () => {
    expect(store.ticketsShipped()).toBe(0);
  });

  it('ticketsShipped() counts merged-column tickets', () => {
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('T-DONE', '/proj', 'merged', 'Done')`);
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('T-WIP', '/proj', 'in_stack', 'WIP')`);
    expect(store.ticketsShipped()).toBe(1);
  });

  it('ticketsShipped() counts stacks with pushed/pr_created status', () => {
    db.exec(`INSERT INTO stacks (id, ticket, status) VALUES ('s1', 'T-PUSH', 'pushed')`);
    db.exec(`INSERT INTO stacks (id, ticket, status) VALUES ('s2', 'T-PR', 'pr_created')`);
    expect(store.ticketsShipped()).toBe(2);
  });

  it('ticketsShipped() counts archived stacks with pr_created/pushed final_status', () => {
    db.exec(`INSERT INTO stack_history (stack_id, ticket, final_status) VALUES ('s-old', 'T-HIST', 'pushed')`);
    expect(store.ticketsShipped()).toBe(1);
  });

  it('ticketsShipped() does not double-count the same ticket across board and stacks', () => {
    db.exec(`INSERT INTO stacks (id, ticket, status) VALUES ('s1', 'T-BOTH', 'pushed')`);
    db.exec(`INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES ('T-BOTH', '/proj', 'merged', 'Done')`);
    expect(store.ticketsShipped()).toBe(1);
  });
});
