import type { ByTicketEntry } from '@main/telemetry/types';
import type { TicketBoardEntry } from '../../store';
import { KANBAN_COLUMNS } from '../../types/kanban';
import type { KanbanColumn } from '../../types/kanban';

export const KANBAN_COLUMN_LABELS: Record<KanbanColumn, string> = {
  backlog: 'Backlog',
  refining: 'Refining',
  spec_ready: 'Spec Ready',
  in_stack: 'In Stack',
  pr_open: 'PR Open',
  merged: 'Merged',
};

export const KANBAN_COLUMN_COLORS: Record<KanbanColumn, string> = {
  backlog: '#7a7094',
  refining: '#c9a227',
  spec_ready: '#4a7fb5',
  in_stack: '#c9a227',
  pr_open: '#7b5ea7',
  merged: '#4a8c6e',
};

export interface PipelineGroup {
  column: KanbanColumn | 'unattributed';
  displayName: string;
  color: string;
  totalCost: number;
  pct: number;
}

export function groupByPipeline(
  byTicket: ByTicketEntry[],
  boardTickets: TicketBoardEntry[],
): PipelineGroup[] {
  const costByColumn: Record<string, number> = {};

  for (const entry of byTicket) {
    const board = boardTickets.find((t) => t.ticket_id === entry.ticketId);
    const col = board?.column ?? 'unattributed';
    costByColumn[col] = (costByColumn[col] ?? 0) + entry.cost;
  }

  const grandTotal = Object.values(costByColumn).reduce((s, v) => s + v, 0);

  const columns: Array<KanbanColumn | 'unattributed'> = [...KANBAN_COLUMNS, 'unattributed'];

  return columns.map((col) => {
    const totalCost = costByColumn[col] ?? 0;
    const pct = grandTotal > 0 ? (totalCost / grandTotal) * 100 : 0;
    const isReal = col !== 'unattributed';
    return {
      column: col,
      displayName: isReal ? KANBAN_COLUMN_LABELS[col as KanbanColumn] : 'Unattributed',
      color: isReal ? KANBAN_COLUMN_COLORS[col as KanbanColumn] : '#b8b0cc',
      totalCost,
      pct,
    };
  });
}
