import { describe, it, expect } from 'vitest';
import { groupByPipeline } from '../../../../src/renderer/components/telemetry/utils';
import type { ByTicketEntry } from '../../../../src/main/telemetry/types';
import type { TicketBoardEntry } from '../../../../src/renderer/store';

const makeEntry = (ticketId: string, cost: number): ByTicketEntry => ({
  ticketId,
  model: null,
  cost,
  tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
  cacheHit: 0,
  lifecycle: null,
  unpriced: false,
});

const makeBoardTicket = (ticket_id: string, column: TicketBoardEntry['column']): TicketBoardEntry => ({
  ticket_id,
  project_dir: '/test',
  column,
  title: `Ticket ${ticket_id}`,
  updated_at: '',
});

describe('groupByPipeline', () => {
  it('groups costs by board column', () => {
    const byTicket = [makeEntry('1', 3.0), makeEntry('2', 2.0)];
    const boardTickets = [
      makeBoardTicket('1', 'merged'),
      makeBoardTicket('2', 'pr_open'),
    ];
    const groups = groupByPipeline(byTicket, boardTickets);
    const merged = groups.find((g) => g.column === 'merged')!;
    const prOpen = groups.find((g) => g.column === 'pr_open')!;
    expect(merged.totalCost).toBe(3.0);
    expect(prOpen.totalCost).toBe(2.0);
  });

  it('empty column has $0 and 0%', () => {
    const byTicket = [makeEntry('1', 5.0)];
    const boardTickets = [makeBoardTicket('1', 'merged')];
    const groups = groupByPipeline(byTicket, boardTickets);
    const backlog = groups.find((g) => g.column === 'backlog')!;
    expect(backlog.totalCost).toBe(0);
    expect(backlog.pct).toBe(0);
  });

  it('unmatched ticketId goes to Unattributed', () => {
    const byTicket = [makeEntry('999', 4.0)];
    const boardTickets: TicketBoardEntry[] = [];
    const groups = groupByPipeline(byTicket, boardTickets);
    const unattr = groups.find((g) => g.column === 'unattributed')!;
    expect(unattr.totalCost).toBe(4.0);
    expect(unattr.displayName).toBe('Unattributed');
  });

  it('__orchestrator__ is excluded from pipeline grouping entirely', () => {
    const byTicket = [makeEntry('__orchestrator__', 2.5)];
    const boardTickets: TicketBoardEntry[] = [];
    const groups = groupByPipeline(byTicket, boardTickets);
    const unattr = groups.find((g) => g.column === 'unattributed')!;
    // orchestrator excluded — does not count toward any column, including unattributed
    expect(unattr.totalCost).toBe(0);
    const grandTotal = groups.reduce((s, g) => s + g.totalCost, 0);
    expect(grandTotal).toBe(0);
  });

  it('percentages sum to 100', () => {
    const byTicket = [makeEntry('1', 3.0), makeEntry('2', 2.0)];
    const boardTickets = [
      makeBoardTicket('1', 'merged'),
      makeBoardTicket('2', 'pr_open'),
    ];
    const groups = groupByPipeline(byTicket, boardTickets);
    const totalPct = groups.reduce((s, g) => s + g.pct, 0);
    expect(totalPct).toBeCloseTo(100, 1);
  });

  it('returns all KANBAN_COLUMNS plus unattributed even with no data', () => {
    const groups = groupByPipeline([], []);
    expect(groups).toHaveLength(7); // 6 columns + unattributed
    expect(groups.every((g) => g.totalCost === 0)).toBe(true);
  });
});
