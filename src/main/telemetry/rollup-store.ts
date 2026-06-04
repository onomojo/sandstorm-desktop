import Database from 'better-sqlite3';
import { computeTicketRollups, countTicketsShipped, ORCHESTRATOR_TICKET_ID } from './attribution';
import type { ByTicketEntry } from './types';

interface RollupRow {
  ticket_id: string;
  title: string;
  column: string | null;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_creation: number;
  primary_model: string | null;
  unpriced: number;
}

/**
 * Caches per-ticket cost rollups in SQLite so per-ticket / per-model views are fast
 * and survive stack teardown. Auto-invalidates when stacks are dirtied by token updates,
 * teardown, or board moves.
 */
export class TicketRollupStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Mark a stack dirty so the next getByTicket() call triggers a fresh rollup. */
  markStackDirty(stackId: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO rollup_dirty_stacks (stack_id, marked_at) VALUES (?, datetime('now'))`
    ).run(stackId);
  }

  /** Mark all rollups dirty (used when ticket board state changes). */
  markDirty(): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO rollup_dirty_stacks (stack_id, marked_at) VALUES ('__board__', datetime('now'))`
    ).run();
  }

  /**
   * Returns per-ticket rollups, re-deriving from the DB if any stack is dirty.
   * CacheHit for historical/pre-capture tasks is 0 (DEFAULT 0 on cache columns).
   */
  getByTicket(): ByTicketEntry[] {
    this.reconcile();
    const rows = this.db.prepare(
      `SELECT * FROM ticket_rollups ORDER BY
        CASE WHEN ticket_id = ? THEN 1 ELSE 0 END ASC,
        total_cost DESC`
    ).all(ORCHESTRATOR_TICKET_ID) as RollupRow[];

    return rows.map((row) => {
      const denom = row.total_input_tokens + row.total_cache_read;
      const cacheHit = denom > 0 ? (row.total_cache_read / denom) * 100 : 0;
      return {
        ticketId: row.ticket_id,
        model: row.primary_model,
        cost: row.total_cost,
        tokens: {
          input: row.total_input_tokens,
          output: row.total_output_tokens,
          cacheCreate: row.total_cache_creation,
          cacheRead: row.total_cache_read,
          total: row.total_input_tokens + row.total_output_tokens + row.total_cache_creation + row.total_cache_read,
        },
        cacheHit,
        lifecycle: null,
        unpriced: row.unpriced === 1,
      };
    });
  }

  /**
   * Force a full rebuild of all ticket rollups from the DB.
   * Called by the stats:telemetry:refresh IPC handler.
   */
  refresh(): void {
    const rollups = computeTicketRollups(this.db);
    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO ticket_rollups
        (ticket_id, title, column, total_cost, total_input_tokens, total_output_tokens,
         total_cache_read, total_cache_creation, primary_model, unpriced, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const rebuild = this.db.transaction((entries: ByTicketEntry[]) => {
      this.db.exec('DELETE FROM ticket_rollups');
      for (const entry of entries) {
        upsert.run(
          entry.ticketId,
          entry.ticketId, // title: no longer in ByTicketEntry; use ticketId as fallback
          null,           // column: no longer in ByTicketEntry
          entry.cost,
          entry.tokens.input,
          entry.tokens.output,
          entry.tokens.cacheRead,
          entry.tokens.cacheCreate,
          entry.model,
          entry.unpriced ? 1 : 0
        );
      }
      this.db.exec('DELETE FROM rollup_dirty_stacks');
    });

    rebuild(rollups);
  }

  /**
   * Count of distinct tickets that have been shipped (merged or pushed).
   * Used to populate summary.ticketsShipped.
   */
  ticketsShipped(): number {
    return countTicketsShipped(this.db);
  }

  /**
   * Total estimated USD cost of all per-ticket tasks (excluding orchestrator bucket).
   * Used to compute summary.costPerTicket.
   */
  totalTicketCost(): number {
    this.reconcile();
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(total_cost), 0) AS total
      FROM ticket_rollups
      WHERE ticket_id != ?
    `).get(ORCHESTRATOR_TICKET_ID) as { total: number };
    return row.total;
  }

  private reconcile(): void {
    const dirtyRows = this.db.prepare(
      'SELECT stack_id FROM rollup_dirty_stacks'
    ).all() as { stack_id: string }[];

    if (dirtyRows.length === 0) return;

    const dirtyIds = dirtyRows.map(r => r.stack_id);

    // __board__ means ticket board columns changed — full rebuild required
    if (dirtyIds.includes('__board__')) {
      this.refresh();
      return;
    }

    const ph = dirtyIds.map(() => '?').join(', ');

    // Find tickets touched by the specific dirty stacks (live + archived)
    const liveRows = this.db.prepare(
      `SELECT DISTINCT ticket FROM stacks WHERE id IN (${ph})`
    ).all(...dirtyIds) as { ticket: string | null }[];

    const histRows = this.db.prepare(
      `SELECT DISTINCT ticket FROM stack_history WHERE stack_id IN (${ph})`
    ).all(...dirtyIds) as { ticket: string | null }[];

    const affectedTickets = new Set<string>();
    for (const r of [...liveRows, ...histRows]) {
      affectedTickets.add(r.ticket ?? ORCHESTRATOR_TICKET_ID);
    }

    if (affectedTickets.size === 0) {
      // Stacks no longer exist anywhere — just clear dirty entries
      this.db.prepare(`DELETE FROM rollup_dirty_stacks WHERE stack_id IN (${ph})`).run(...dirtyIds);
      return;
    }

    // Recompute all rollups and filter to only the affected tickets
    const allRollups = computeTicketRollups(this.db);
    const affected = allRollups.filter(e => affectedTickets.has(e.ticketId));

    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO ticket_rollups
        (ticket_id, title, column, total_cost, total_input_tokens, total_output_tokens,
         total_cache_read, total_cache_creation, primary_model, unpriced, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    this.db.transaction(() => {
      for (const entry of affected) {
        upsert.run(
          entry.ticketId, entry.ticketId, null, entry.cost,
          entry.tokens.input, entry.tokens.output,
          entry.tokens.cacheRead, entry.tokens.cacheCreate,
          entry.model, entry.unpriced ? 1 : 0
        );
      }
      this.db.prepare(`DELETE FROM rollup_dirty_stacks WHERE stack_id IN (${ph})`).run(...dirtyIds);
    })();
  }
}
