import { describe, it, expect } from 'vitest';
import { groupByLifecycleStage } from '../../../../src/renderer/components/telemetry/utils';
import type { ByTicketEntry } from '../../../../src/main/telemetry/types';

const makeEntry = (
  ticketId: string,
  cost: number,
  lifecycle: ByTicketEntry['lifecycle'] = null,
): ByTicketEntry => ({
  ticketId,
  model: null,
  cost,
  tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
  cacheHit: 0,
  lifecycle,
  unpriced: false,
});

const makeLifecycle = (
  overrides: Partial<{ refine: number; spec: number; execution: number; review: number; verify: number; pr: number }> = {},
) => ({
  refine: 0,
  spec: 0,
  execution: 0,
  review: 0,
  verify: 0,
  pr: 0,
  ...overrides,
});

describe('groupByLifecycleStage', () => {
  it('regression: tickets all in merged column spread cost across lifecycle stages (not collapsed)', () => {
    // Both tickets happen to be "in merged" on the board — the old column-based approach would
    // collapse their entire cost into a single Merged bucket. The new function must distribute
    // costs across the actual lifecycle stages instead.
    const byTicket = [
      makeEntry('1', 5.0, makeLifecycle({ refine: 1.0, spec: 0.5, execution: 2.5, review: 0.8, pr: 0.2 })),
      makeEntry('2', 3.0, makeLifecycle({ refine: 0.5, spec: 0.3, execution: 1.5, review: 0.5, pr: 0.2 })),
    ];
    const groups = groupByLifecycleStage(byTicket);

    const refine = groups.find((g) => g.stage === 'refine')!;
    const spec = groups.find((g) => g.stage === 'spec')!;
    const execution = groups.find((g) => g.stage === 'execution')!;
    const review = groups.find((g) => g.stage === 'review')!;
    const pr = groups.find((g) => g.stage === 'pr')!;

    expect(refine.totalCost).toBeCloseTo(1.5, 10);
    expect(spec.totalCost).toBeCloseTo(0.8, 10);
    expect(execution.totalCost).toBeCloseTo(4.0, 10);
    expect(review.totalCost).toBeCloseTo(1.3, 10);
    expect(pr.totalCost).toBeCloseTo(0.4, 10);

    // Multiple stages have non-zero cost — not collapsed to a single bucket
    const nonZeroStages = groups.filter((g) => g.totalCost > 0);
    expect(nonZeroStages.length).toBeGreaterThan(1);
  });

  it('per-stage percentages sum to ~100% when total > 0', () => {
    const byTicket = [
      makeEntry('1', 6.0, makeLifecycle({ refine: 1.0, spec: 1.0, execution: 2.0, review: 1.0, pr: 1.0 })),
    ];
    const groups = groupByLifecycleStage(byTicket);
    const totalPct = groups.reduce((s, g) => s + g.pct, 0);
    expect(totalPct).toBeCloseTo(100, 1);
  });

  it('verify stage always has $0 totalCost and 0% pct', () => {
    const byTicket = [
      makeEntry('1', 5.0, makeLifecycle({ execution: 5.0 })),
    ];
    const groups = groupByLifecycleStage(byTicket);
    const verify = groups.find((g) => g.stage === 'verify')!;
    expect(verify.totalCost).toBe(0);
    expect(verify.pct).toBe(0);
  });

  it('tickets with lifecycle === null are excluded from stage rollup', () => {
    const byTicket = [
      makeEntry('1', 5.0, null),
      makeEntry('2', 3.0, makeLifecycle({ execution: 3.0 })),
    ];
    const groups = groupByLifecycleStage(byTicket);
    const execution = groups.find((g) => g.stage === 'execution')!;
    // Only ticket 2 counted; ticket 1 (null lifecycle) must not contribute
    expect(execution.totalCost).toBeCloseTo(3.0, 10);
    const grandTotal = groups.reduce((s, g) => s + g.totalCost, 0);
    expect(grandTotal).toBeCloseTo(3.0, 10);
  });

  it('empty input → all stages $0 and 0%, no NaN', () => {
    const groups = groupByLifecycleStage([]);
    expect(groups).toHaveLength(6);
    for (const g of groups) {
      expect(g.totalCost).toBe(0);
      expect(g.pct).toBe(0);
      expect(Number.isNaN(g.totalCost)).toBe(false);
      expect(Number.isNaN(g.pct)).toBe(false);
    }
  });

  it('orchestrator ticket is excluded from stage rollup', () => {
    const byTicket = [
      makeEntry('__orchestrator__', 10.0, makeLifecycle({ execution: 10.0 })),
    ];
    const groups = groupByLifecycleStage(byTicket);
    const grandTotal = groups.reduce((s, g) => s + g.totalCost, 0);
    expect(grandTotal).toBe(0);
  });

  it('returns all 6 lifecycle stages in order', () => {
    const groups = groupByLifecycleStage([]);
    expect(groups.map((g) => g.stage)).toEqual(['refine', 'spec', 'execution', 'review', 'verify', 'pr']);
  });

  it('each stage group carries the correct display name and color', () => {
    const groups = groupByLifecycleStage([]);
    const execution = groups.find((g) => g.stage === 'execution')!;
    expect(execution.displayName).toBe('Execution');
    expect(execution.color).toBe('#7b5ea7');
    const verify = groups.find((g) => g.stage === 'verify')!;
    expect(verify.displayName).toBe('Verify');
  });
});
