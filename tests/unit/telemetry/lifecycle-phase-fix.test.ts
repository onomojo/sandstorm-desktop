/**
 * lifecycle-phase-fix.test.ts
 *
 * Tests for issue #603: lifecycle phase split correctness after fixing
 * - unit mismatch (turnCount vs tokens)
 * - execution/review backfill from tasks columns (D2)
 * - all five LLM stages populated when data is present
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { aggregateByTicket } from '../../../src/main/telemetry/aggregator';
import type {
  StepWeightRow,
  EphemeralWeightRecord,
  TaskPhaseWeightRow,
} from '../../../src/main/telemetry/aggregator';
import type { RawUsageEntry } from '../../../src/main/telemetry/parser';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-fix-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(sid: string, stackId: string | null, input = 1000, output = 500): RawUsageEntry {
  return {
    sessionId: sid,
    stackId,
    model: 'claude-sonnet-4-5',
    input,
    output,
    cacheCreate: 0,
    cacheRead: 0,
    timestamp: '2024-03-01T10:00:00.000Z',
  };
}

function makeManifest(dir: string, stackId: string, ticket: string): void {
  fs.writeFileSync(dir + '.manifest.json', JSON.stringify({
    stackId, ticket, project: 'p', createdAt: '2024-01-01T00:00:00.000Z',
  }));
}

function stackDir(name: string): string {
  const d = path.join(tmpDir, name);
  fs.mkdirSync(d);
  return d;
}

// ---------------------------------------------------------------------------
// 1. Regression: all five LLM stages > 0 when data present
// ---------------------------------------------------------------------------

describe('Regression: all five LLM stages populated', () => {
  it('execution, review, refine, spec, pr all > 0 when each has token data', () => {
    const sd = stackDir('stack-all');
    makeManifest(sd, 'stack-all', 'T-ALL');

    const stepWeights: StepWeightRow[] = [
      { ticket: 'T-ALL', phase: 'execution', totalTokens: 10000 },
      { ticket: 'T-ALL', phase: 'review', totalTokens: 4000 },
    ];
    const ephemeralRecords: EphemeralWeightRecord[] = [
      { ticketId: 'T-ALL', stage: 'refine', tokens: 3000 },
      { ticketId: 'T-ALL', stage: 'spec', tokens: 2000 },
      { ticketId: 'T-ALL', stage: 'pr', tokens: 1000 },
    ];

    const result = aggregateByTicket([makeEntry('s1', 'stack-all')], [sd], stepWeights, ephemeralRecords);
    const row = result.find((r) => r.ticketId === 'T-ALL');
    expect(row).toBeDefined();
    expect(row!.lifecycle).not.toBeNull();

    const lc = row!.lifecycle!;
    expect(lc.execution).toBeGreaterThan(0);
    expect(lc.review).toBeGreaterThan(0);
    expect(lc.refine).toBeGreaterThan(0);
    expect(lc.spec).toBeGreaterThan(0);
    expect(lc.pr).toBeGreaterThan(0);
    expect(lc.verify).toBe(0); // always 0 by design
  });
});

// ---------------------------------------------------------------------------
// 2. Unit normalization: token-heavy execution doesn't swamp token-light refine
// ---------------------------------------------------------------------------

describe('Unit normalization: single token unit prevents swamping', () => {
  it('refine is not rounded to $0 when it has real token signal', () => {
    const sd = stackDir('stack-norm');
    makeManifest(sd, 'stack-norm', 'T-NORM');

    // execution: 10000 tokens, refine: 500 tokens
    // With old turnCount system (refine turnCount=5), turnCount was swamped by 10000
    // With new token unit, refine gets 500/(10000+500) ≈ 4.76% of cost
    const stepWeights: StepWeightRow[] = [
      { ticket: 'T-NORM', phase: 'execution', totalTokens: 10000 },
    ];
    const ephemeralRecords: EphemeralWeightRecord[] = [
      { ticketId: 'T-NORM', stage: 'refine', tokens: 500 },
    ];

    const result = aggregateByTicket([makeEntry('s1', 'stack-norm')], [sd], stepWeights, ephemeralRecords);
    const row = result.find((r) => r.ticketId === 'T-NORM');
    expect(row!.lifecycle).not.toBeNull();

    const lc = row!.lifecycle!;
    // refine should get ~4.76% of cost — must be > 0
    expect(lc.refine).toBeGreaterThan(0);
    // execution gets ~95.24%, must be >> refine
    expect(lc.execution).toBeGreaterThan(lc.refine * 10);
  });
});

// ---------------------------------------------------------------------------
// 3. Sum invariant: lifecycle sums to cost for mixed-stage input
// ---------------------------------------------------------------------------

describe('Sum invariant', () => {
  it('sum(lifecycle) === cost within tolerance for all five stages populated', () => {
    const sd = stackDir('stack-sum');
    makeManifest(sd, 'stack-sum', 'T-SUM');

    const stepWeights: StepWeightRow[] = [
      { ticket: 'T-SUM', phase: 'execution', totalTokens: 8000 },
      { ticket: 'T-SUM', phase: 'review', totalTokens: 3000 },
    ];
    const ephemeralRecords: EphemeralWeightRecord[] = [
      { ticketId: 'T-SUM', stage: 'refine', tokens: 1500 },
      { ticketId: 'T-SUM', stage: 'spec', tokens: 2000 },
      { ticketId: 'T-SUM', stage: 'pr', tokens: 500 },
    ];

    const result = aggregateByTicket([makeEntry('s1', 'stack-sum')], [sd], stepWeights, ephemeralRecords);
    const row = result.find((r) => r.ticketId === 'T-SUM');
    expect(row!.lifecycle).not.toBeNull();

    const lc = row!.lifecycle!;
    const lcSum = lc.refine + lc.spec + lc.execution + lc.review + lc.verify + lc.pr;
    expect(Math.abs(lcSum - row!.cost)).toBeLessThan(1e-10);
  });
});

// ---------------------------------------------------------------------------
// 4. No-signal stage stays 0 for ticket with no stack run
// ---------------------------------------------------------------------------

describe('No-signal stages stay 0', () => {
  it('ticket with only host-side refinement keeps execution/review/pr at 0', () => {
    // Host-only ticket: no stackId, so ends up in orchestrator bucket
    // We test a ticket with only ephemeral refine/spec data (no execution/review)
    const sd = stackDir('stack-host');
    makeManifest(sd, 'stack-host', 'T-HOST');

    const ephemeralRecords: EphemeralWeightRecord[] = [
      { ticketId: 'T-HOST', stage: 'refine', tokens: 2000 },
      { ticketId: 'T-HOST', stage: 'spec', tokens: 1000 },
    ];

    const result = aggregateByTicket([makeEntry('s1', 'stack-host')], [sd], [], ephemeralRecords);
    const row = result.find((r) => r.ticketId === 'T-HOST');
    expect(row!.lifecycle).not.toBeNull();

    const lc = row!.lifecycle!;
    expect(lc.execution).toBe(0);
    expect(lc.review).toBe(0);
    expect(lc.pr).toBe(0);
    expect(lc.refine).toBeGreaterThan(0);
    expect(lc.spec).toBeGreaterThan(0);
  });

  it('ticket with no weights at all → lifecycle null', () => {
    const sd = stackDir('stack-none');
    makeManifest(sd, 'stack-none', 'T-NONE');

    const result = aggregateByTicket([makeEntry('s1', 'stack-none')], [sd]);
    const row = result.find((r) => r.ticketId === 'T-NONE');
    expect(row!.lifecycle).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Backfill (D2): getTaskPhaseTokensByTicket-style data as fallback
// ---------------------------------------------------------------------------

describe('Backfill D2: task phase weights as fallback for execution/review', () => {
  it('uses taskPhaseWeights when stepWeights absent for a phase', () => {
    const sd = stackDir('stack-bf');
    makeManifest(sd, 'stack-bf', 'T-BF');

    // No stepWeights at all — backfill should provide execution and review
    const taskPhaseWeights: TaskPhaseWeightRow[] = [
      { ticket: 'T-BF', phase: 'execution', totalTokens: 7000 },
      { ticket: 'T-BF', phase: 'review', totalTokens: 3000 },
    ];

    const result = aggregateByTicket([makeEntry('s1', 'stack-bf')], [sd], [], [], taskPhaseWeights);
    const row = result.find((r) => r.ticketId === 'T-BF');
    expect(row!.lifecycle).not.toBeNull();

    const lc = row!.lifecycle!;
    expect(lc.execution).toBeGreaterThan(0);
    expect(lc.review).toBeGreaterThan(0);
    // Proportions: 7000:3000 → execution ≈ 7/10 of total lifecycle
    expect(lc.execution).toBeCloseTo(lc.review * (7000 / 3000), 6);
  });

  it('uses stepWeights when both stepWeights and taskPhaseWeights present — no double-count', () => {
    const sd = stackDir('stack-both');
    makeManifest(sd, 'stack-both', 'T-BOTH');

    const stepWeights: StepWeightRow[] = [
      { ticket: 'T-BOTH', phase: 'execution', totalTokens: 5000 },
    ];
    const taskPhaseWeights: TaskPhaseWeightRow[] = [
      { ticket: 'T-BOTH', phase: 'execution', totalTokens: 9000 }, // should NOT be used
      { ticket: 'T-BOTH', phase: 'review', totalTokens: 2000 },    // should be used (no step weight)
    ];

    const result = aggregateByTicket([makeEntry('s1', 'stack-both')], [sd], stepWeights, [], taskPhaseWeights);
    const row = result.find((r) => r.ticketId === 'T-BOTH');
    expect(row!.lifecycle).not.toBeNull();

    const lc = row!.lifecycle!;
    // execution uses stepWeight (5000), not backfill (9000)
    // review uses backfill (2000) since no step weight
    // Total weights = 5000 + 2000 = 7000
    // execution fraction: 5000/7000 ≈ 0.714
    // review fraction: 2000/7000 ≈ 0.286
    const totalWeight = 5000 + 2000;
    expect(lc.execution).toBeCloseTo(row!.cost * (5000 / totalWeight), 6);
    expect(lc.review).toBeCloseTo(row!.cost * (2000 / totalWeight), 6);
  });

  it('per-phase fallback: stepWeight present for execution but absent for review', () => {
    const sd = stackDir('stack-mixed');
    makeManifest(sd, 'stack-mixed', 'T-MX');

    const stepWeights: StepWeightRow[] = [
      { ticket: 'T-MX', phase: 'execution', totalTokens: 6000 },
      // no review step weight
    ];
    const taskPhaseWeights: TaskPhaseWeightRow[] = [
      { ticket: 'T-MX', phase: 'execution', totalTokens: 99000 }, // ignored — step present
      { ticket: 'T-MX', phase: 'review', totalTokens: 2000 },     // used — no step weight
    ];

    const result = aggregateByTicket([makeEntry('s1', 'stack-mixed')], [sd], stepWeights, [], taskPhaseWeights);
    const row = result.find((r) => r.ticketId === 'T-MX');
    const lc = row!.lifecycle!;

    // execution = step weight 6000; review = backfill 2000
    expect(lc.execution).toBeCloseTo(row!.cost * (6000 / 8000), 6);
    expect(lc.review).toBeCloseTo(row!.cost * (2000 / 8000), 6);
  });

  it('sum invariant holds with mixed step + backfill weights', () => {
    const sd = stackDir('stack-bfsum');
    makeManifest(sd, 'stack-bfsum', 'T-BFSUM');

    const stepWeights: StepWeightRow[] = [
      { ticket: 'T-BFSUM', phase: 'execution', totalTokens: 5000 },
    ];
    const taskPhaseWeights: TaskPhaseWeightRow[] = [
      { ticket: 'T-BFSUM', phase: 'review', totalTokens: 2000 },
    ];
    const ephemeralRecords: EphemeralWeightRecord[] = [
      { ticketId: 'T-BFSUM', stage: 'refine', tokens: 800 },
    ];

    const result = aggregateByTicket([makeEntry('s1', 'stack-bfsum')], [sd], stepWeights, ephemeralRecords, taskPhaseWeights);
    const row = result.find((r) => r.ticketId === 'T-BFSUM');
    const lc = row!.lifecycle!;

    const lcSum = lc.refine + lc.spec + lc.execution + lc.review + lc.verify + lc.pr;
    expect(Math.abs(lcSum - row!.cost)).toBeLessThan(1e-10);
  });
});
