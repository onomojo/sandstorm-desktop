import Database from 'better-sqlite3';
import path from 'path';
import { KANBAN_COLUMNS } from '../../../shared/kanban';

export type BoardTicketRow = {
  ticket_id: string;
  project_dir: string;
  column: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export class BoardModule {
  constructor(
    private db: Database.Database,
    private sessionProtectedTickets: Set<string>,
    private onTicketMoved: (ticketId: string, projectDir: string, column: string) => void,
  ) {}

  seedBoardTicket(ticketId: string, projectDir: string, title: string): void {
    const normalizedDir = path.resolve(projectDir);
    this.db.prepare(
      `INSERT INTO ticket_board (ticket_id, project_dir, column, title)
       VALUES (?, ?, 'backlog', ?)
       ON CONFLICT(ticket_id, project_dir) DO UPDATE SET title = excluded.title`
    ).run(ticketId, normalizedDir, title);
    this.sessionProtectedTickets.add(`${ticketId}|${normalizedDir}`);
  }

  setBoardTicketColumn(ticketId: string, projectDir: string, column: string): void {
    const normalizedDir = path.resolve(projectDir);
    this.db.prepare(
      `INSERT INTO ticket_board (ticket_id, project_dir, column, title)
       VALUES (?, ?, ?, '')
       ON CONFLICT(ticket_id, project_dir) DO UPDATE SET column = excluded.column, updated_at = datetime('now')`
    ).run(ticketId, normalizedDir, column);
    this.sessionProtectedTickets.add(`${ticketId}|${normalizedDir}`);
    this.onTicketMoved(ticketId, normalizedDir, column);
  }

  advanceTicketToPrOpenIfInStack(ticketId: string, projectDir: string): void {
    const tickets = this.listBoardTickets(projectDir);
    const ticket = tickets.find(t => t.ticket_id === ticketId);
    if (ticket?.column === 'in_stack') {
      this.setBoardTicketColumn(ticketId, projectDir, 'pr_open');
    }
  }

  reconcilePrOpenStuckTickets(): void {
    const rows = this.db.prepare(
      `SELECT tb.ticket_id, tb.project_dir
       FROM ticket_board tb
       JOIN stacks s ON s.ticket = tb.ticket_id AND s.project_dir = tb.project_dir
       WHERE tb.column = 'pr_open' AND s.pr_number IS NULL`
    ).all() as { ticket_id: string; project_dir: string }[];
    for (const row of rows) {
      this.setBoardTicketColumn(row.ticket_id, row.project_dir, 'in_stack');
    }
  }

  reconcilePrCreatedTickets(): void {
    const stacks = this.db.prepare(
      "SELECT ticket, project_dir FROM stacks WHERE status = 'pr_created' AND ticket IS NOT NULL"
    ).all() as { ticket: string; project_dir: string }[];
    for (const stack of stacks) {
      this.advanceTicketToPrOpenIfInStack(stack.ticket, stack.project_dir);
    }
  }

  listBoardTickets(projectDir: string): BoardTicketRow[] {
    const normalizedDir = path.resolve(projectDir);
    return this.db.prepare(
      `SELECT ticket_id, project_dir, column, title, created_at, updated_at
       FROM ticket_board WHERE project_dir = ? ORDER BY created_at ASC`
    ).all(normalizedDir) as BoardTicketRow[];
  }

  listBoardTicketsInOrder(projectDir: string, orderedIds: string[]): BoardTicketRow[] {
    const allRows = this.listBoardTickets(projectDir);
    const rowMap = new Map(allRows.map(r => [r.ticket_id, r]));
    const fetchedSet = new Set(orderedIds);
    const result: BoardTicketRow[] = [];
    for (const id of orderedIds) {
      const row = rowMap.get(id);
      if (row) result.push(row);
    }
    for (const row of allRows) {
      if (!fetchedSet.has(row.ticket_id)) result.push(row);
    }
    return result;
  }

  deleteClosedEarlyColumnTickets(projectDir: string, openTicketIds: string[]): number {
    const normalizedDir = path.resolve(projectDir);
    const earlyColumns = KANBAN_COLUMNS.filter(c =>
      (['backlog', 'refining', 'spec_ready'] as readonly string[]).includes(c)
    );
    const earlyColSql = earlyColumns.map(c => `'${c}'`).join(',');

    const sessionKept = [...this.sessionProtectedTickets]
      .filter(k => k.endsWith(`|${normalizedDir}`))
      .map(k => k.split('|')[0]);
    const effectiveKeepIds = [...new Set([...openTicketIds, ...sessionKept])];

    if (effectiveKeepIds.length === 0) {
      return this.db.prepare(
        `DELETE FROM ticket_board WHERE project_dir = ? AND column IN (${earlyColSql})`
      ).run(normalizedDir).changes;
    }

    const idPlaceholders = effectiveKeepIds.map(() => '?').join(',');
    return this.db.prepare(
      `DELETE FROM ticket_board WHERE project_dir = ? AND column IN (${earlyColSql}) AND ticket_id NOT IN (${idPlaceholders})`
    ).run(normalizedDir, ...effectiveKeepIds).changes;
  }

  deleteBoardTicket(ticketId: string, projectDir: string): void {
    const normalizedDir = path.resolve(projectDir);
    this.db.prepare(
      `DELETE FROM ticket_board WHERE ticket_id = ? AND project_dir = ?`
    ).run(ticketId, normalizedDir);
  }
}
