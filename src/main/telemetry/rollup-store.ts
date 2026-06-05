import Database from 'better-sqlite3';
import { countTicketsShipped } from './attribution';

export class TicketRollupStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Count of distinct tickets that have been shipped (merged or pushed).
   * Used to populate summary.ticketsShipped.
   */
  ticketsShipped(): number {
    return countTicketsShipped(this.db);
  }
}
