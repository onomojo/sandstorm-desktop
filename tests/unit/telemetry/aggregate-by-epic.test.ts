/**
 * aggregate-by-epic.test.ts — unit tests for aggregateByEpic
 *
 * aggregateByEpic is electron-free: it accepts pre-computed ByTicketEntry[]
 * and EpicTask[] injected arrays, so no filesystem or SQLite setup is needed.
 */

import { describe, it, expect } from 'vitest';
import { aggregateByEpic } from '../../../src/main/telemetry/aggregator';
import type { ByTicketEntry } from '../../../src/main/telemetry/types';
import type { EpicTask } from '../../../src/main/control-plane/registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTicket(ticketId: string, cost: number, tokens?: Partial<ByTicketEntry['tokens']>): ByTicketEntry {
  return {
    ticketId,
    model: 'claude-sonnet-4-5',
    cost,
    tokens: {
      input: tokens?.input ?? 100,
      output: tokens?.output ?? 50,
      cacheCreate: tokens?.cacheCreate ?? 0,
      cacheRead: tokens?.cacheRead ?? 0,
      total: tokens?.total ?? 150,
    },
    cacheHit: 0,
    lifecycle: null,
    unpriced: false,
  };
}

function makeTask(
  epic_id: string,
  ticket_id: string,
  role: 'build' | 'reconcile',
  origin: 'planned' | 'gap' = 'planned',
): EpicTask {
  return { epic_id, ticket_id, role, origin, crit_id: null, gap_cycles: 0, done: 0 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregateByEpic', () => {
  it('returns empty array when epicTasks is empty', () => {
    const byTicket = [makeTicket('TICKET-1', 1.0)];
    expect(aggregateByEpic(byTicket, [])).toEqual([]);
  });

  it('produces zero-cost entry per epic when byTicket is empty', () => {
    const epicTasks = [makeTask('EPIC-1', 'TICKET-1', 'build')];
    const result = aggregateByEpic([], epicTasks);
    expect(result).toHaveLength(1);
    expect(result[0].epicId).toBe('EPIC-1');
    expect(result[0].cost).toBe(0);
    expect(result[0].memberCount).toBe(0);
  });

  it('sums cost and tokens from member tickets', () => {
    const byTicket = [
      makeTicket('TICKET-A', 1.0, { input: 100, output: 50, cacheCreate: 0, cacheRead: 0, total: 150 }),
      makeTicket('TICKET-B', 2.0, { input: 200, output: 100, cacheCreate: 0, cacheRead: 0, total: 300 }),
    ];
    const epicTasks = [
      makeTask('EPIC-1', 'TICKET-A', 'build'),
      makeTask('EPIC-1', 'TICKET-B', 'build'),
    ];
    const [epic] = aggregateByEpic(byTicket, epicTasks);
    expect(epic.epicId).toBe('EPIC-1');
    expect(epic.cost).toBe(3.0);
    expect(epic.tokens.input).toBe(300);
    expect(epic.tokens.output).toBe(150);
    expect(epic.tokens.total).toBe(450);
    expect(epic.memberCount).toBe(2);
  });

  it('partitions cost into build vs reconcile by role', () => {
    const byTicket = [
      makeTicket('T-BUILD', 2.0),
      makeTicket('T-RECONCILE', 1.0),
    ];
    const epicTasks = [
      makeTask('EPIC-1', 'T-BUILD', 'build'),
      makeTask('EPIC-1', 'T-RECONCILE', 'reconcile'),
    ];
    const [epic] = aggregateByEpic(byTicket, epicTasks);
    expect(epic.build.cost).toBe(2.0);
    expect(epic.reconcile.cost).toBe(1.0);
    expect(epic.cost).toBe(3.0);
  });

  it('reconcileRework is overlay of gap tickets regardless of role', () => {
    const byTicket = [
      makeTicket('T-PLANNED-BUILD', 1.0),
      makeTicket('T-GAP-BUILD', 2.0),
      makeTicket('T-GAP-RECONCILE', 0.5),
    ];
    const epicTasks = [
      makeTask('EPIC-1', 'T-PLANNED-BUILD', 'build', 'planned'),
      makeTask('EPIC-1', 'T-GAP-BUILD', 'build', 'gap'),
      makeTask('EPIC-1', 'T-GAP-RECONCILE', 'reconcile', 'gap'),
    ];
    const [epic] = aggregateByEpic(byTicket, epicTasks);
    expect(epic.reconcileRework.cost).toBeCloseTo(2.5);  // gap tickets only
    expect(epic.build.cost).toBeCloseTo(3.0);  // planned + gap build
    expect(epic.reconcile.cost).toBeCloseTo(0.5);  // gap reconcile
  });

  it('reconcileRework cost is <= build.cost + reconcile.cost (overlay invariant)', () => {
    const byTicket = [
      makeTicket('T1', 1.0),
      makeTicket('T2', 2.0),
      makeTicket('T3', 0.5),
    ];
    const epicTasks = [
      makeTask('EPIC-1', 'T1', 'build', 'gap'),
      makeTask('EPIC-1', 'T2', 'reconcile', 'gap'),
      makeTask('EPIC-1', 'T3', 'build', 'planned'),
    ];
    const [epic] = aggregateByEpic(byTicket, epicTasks);
    expect(epic.reconcileRework.cost).toBeLessThanOrEqual(epic.build.cost + epic.reconcile.cost);
  });

  it('excludes ORCHESTRATOR_TICKET_ID from rollups', () => {
    const byTicket = [
      makeTicket('__orchestrator__', 99.0),
      makeTicket('TICKET-REAL', 1.0),
    ];
    const epicTasks = [
      makeTask('EPIC-1', '__orchestrator__', 'build'),
      makeTask('EPIC-1', 'TICKET-REAL', 'build'),
    ];
    const [epic] = aggregateByEpic(byTicket, epicTasks);
    // orchestrator is excluded even if listed in epic_tasks
    expect(epic.cost).toBe(1.0);
    expect(epic.memberCount).toBe(1);
  });

  it('produces one entry per distinct epic_id', () => {
    const byTicket = [
      makeTicket('TA', 1.0),
      makeTicket('TB', 2.0),
      makeTicket('TC', 3.0),
    ];
    const epicTasks = [
      makeTask('EPIC-A', 'TA', 'build'),
      makeTask('EPIC-B', 'TB', 'build'),
      makeTask('EPIC-B', 'TC', 'reconcile'),
    ];
    const result = aggregateByEpic(byTicket, epicTasks);
    expect(result).toHaveLength(2);
    const epicA = result.find((e) => e.epicId === 'EPIC-A')!;
    const epicB = result.find((e) => e.epicId === 'EPIC-B')!;
    expect(epicA.cost).toBe(1.0);
    expect(epicB.cost).toBe(5.0);
  });

  it('tickets not in byTicket do not contribute to cost (member still counted as 0 spend)', () => {
    const byTicket = [makeTicket('TICKET-A', 5.0)];
    const epicTasks = [
      makeTask('EPIC-1', 'TICKET-A', 'build'),
      makeTask('EPIC-1', 'TICKET-MISSING', 'build'),
    ];
    const [epic] = aggregateByEpic(byTicket, epicTasks);
    expect(epic.cost).toBe(5.0);
    // TICKET-MISSING has no entry so memberCount only includes tickets with data
    expect(epic.memberCount).toBe(1);
  });

  it('ByEpicEntry has the correct shape', () => {
    const byTicket = [makeTicket('T1', 1.0)];
    const epicTasks = [makeTask('EPIC-1', 'T1', 'build')];
    const [epic] = aggregateByEpic(byTicket, epicTasks);
    expect(typeof epic.epicId).toBe('string');
    expect(typeof epic.cost).toBe('number');
    expect(typeof epic.memberCount).toBe('number');
    expect(Object.keys(epic.tokens).sort()).toEqual(['cacheCreate', 'cacheRead', 'input', 'output', 'total'].sort());
    expect(Object.keys(epic.build).sort()).toEqual(['cost', 'tokens'].sort());
    expect(Object.keys(epic.reconcile).sort()).toEqual(['cost', 'tokens'].sort());
    expect(Object.keys(epic.reconcileRework).sort()).toEqual(['cost', 'tokens'].sort());
  });

  it('reconcileRework tokens match the gap ticket tokens', () => {
    const gapTokens = { input: 80, output: 40, cacheCreate: 10, cacheRead: 5, total: 135 };
    const byTicket = [
      makeTicket('T-GAP', 1.5, gapTokens),
      makeTicket('T-PLANNED', 0.5),
    ];
    const epicTasks = [
      makeTask('EPIC-1', 'T-GAP', 'reconcile', 'gap'),
      makeTask('EPIC-1', 'T-PLANNED', 'reconcile', 'planned'),
    ];
    const [epic] = aggregateByEpic(byTicket, epicTasks);
    expect(epic.reconcileRework.tokens.input).toBe(80);
    expect(epic.reconcileRework.tokens.output).toBe(40);
    expect(epic.reconcileRework.tokens.cacheCreate).toBe(10);
    expect(epic.reconcileRework.tokens.cacheRead).toBe(5);
    expect(epic.reconcileRework.tokens.total).toBe(135);
  });
});
