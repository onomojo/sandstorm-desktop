import Database from 'better-sqlite3';
import { ORCHESTRATOR_TICKET_ID } from './types';

export { ORCHESTRATOR_TICKET_ID };

/**
 * Count of distinct tickets that have been shipped.
 * Shipped = ticket_board.column = 'merged' OR (no board row and stack/stack_history
 * reached status/final_status of pr_created/pushed). Survives teardown via stack_history.
 */
export function countTicketsShipped(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT ticket) AS n FROM (
      SELECT ticket_id AS ticket FROM ticket_board WHERE column = 'merged'
      UNION
      SELECT s.ticket FROM stacks s
      WHERE s.ticket IS NOT NULL
        AND s.status IN ('pr_created', 'pushed')
        AND s.ticket NOT IN (SELECT ticket_id FROM ticket_board)
      UNION
      SELECT sh.ticket FROM stack_history sh
      WHERE sh.ticket IS NOT NULL
        AND sh.final_status IN ('pr_created', 'pushed')
        AND sh.ticket NOT IN (SELECT ticket_id FROM ticket_board)
    )
  `).get() as { n: number };
  return row.n;
}
