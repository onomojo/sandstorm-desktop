import { describe, it, expect } from 'vitest';
import { computeLifecycleSplit, LIFECYCLE_STAGES } from '../../../src/main/telemetry/lifecycle-split';

const STAGES = LIFECYCLE_STAGES;

describe('computeLifecycleSplit', () => {
  // --- Sum invariant ---

  it('sum invariant: all stage values sum to cost exactly', () => {
    const result = computeLifecycleSplit(10.5, { execution: 3, review: 1 });
    expect(result).not.toBeNull();
    const sum = STAGES.reduce((s, stage) => s + result![stage], 0);
    expect(Math.abs(sum - 10.5)).toBeLessThan(1e-10);
  });

  it('sum invariant: holds for small fractional cost with varied weights', () => {
    const cost = 0.001234;
    const result = computeLifecycleSplit(cost, { refine: 2, spec: 3, execution: 7, review: 5, pr: 1 });
    expect(result).not.toBeNull();
    const sum = STAGES.reduce((s, stage) => s + result![stage], 0);
    expect(Math.abs(sum - cost)).toBeLessThan(1e-10);
  });

  it('sum invariant: holds when a single stage has all weight', () => {
    const cost = 7.77;
    const result = computeLifecycleSplit(cost, { execution: 100 });
    expect(result).not.toBeNull();
    const sum = STAGES.reduce((s, stage) => s + result![stage], 0);
    expect(Math.abs(sum - cost)).toBeLessThan(1e-10);
  });

  // --- Six keys always present ---

  it('six keys always present: only execution+review weights given', () => {
    const result = computeLifecycleSplit(5.0, { execution: 3, review: 1 });
    expect(result).not.toBeNull();
    expect(Object.keys(result!).sort()).toEqual(STAGES.slice().sort());
    expect(result!.refine).toBe(0);
    expect(result!.spec).toBe(0);
    expect(result!.verify).toBe(0);
    expect(result!.pr).toBe(0);
  });

  it('six keys always present: all stages have weights', () => {
    const result = computeLifecycleSplit(1.0, { refine: 1, spec: 1, execution: 1, review: 1, pr: 1 });
    expect(result).not.toBeNull();
    expect(Object.keys(result!).sort()).toEqual(STAGES.slice().sort());
  });

  // --- Skipped stage → 0 ---

  it('skipped stage: missing refine weight → lifecycle.refine === 0', () => {
    const result = computeLifecycleSplit(10.0, { execution: 5, review: 5 });
    expect(result).not.toBeNull();
    expect(result!.refine).toBe(0);
  });

  it('skipped stage: all of refine/spec/pr absent → those are 0', () => {
    const result = computeLifecycleSplit(4.0, { execution: 3, review: 1 });
    expect(result).not.toBeNull();
    expect(result!.refine).toBe(0);
    expect(result!.spec).toBe(0);
    expect(result!.pr).toBe(0);
  });

  // --- verify always 0 ---

  it('verify is always 0 regardless of weight input', () => {
    const result = computeLifecycleSplit(8.0, { execution: 4, review: 4, verify: 999 });
    expect(result).not.toBeNull();
    expect(result!.verify).toBe(0);
  });

  it('verify is 0 even when it is the only weight given', () => {
    const result = computeLifecycleSplit(5.0, { verify: 100 });
    // verify is forced to 0, total effective weight is 0, cost > 0 → null
    expect(result).toBeNull();
  });

  // --- Zero-cost ticket ---

  it('zero cost returns all-zero object', () => {
    const result = computeLifecycleSplit(0, { execution: 10, review: 5 });
    expect(result).not.toBeNull();
    for (const stage of STAGES) {
      expect(result![stage]).toBe(0);
    }
  });

  it('zero cost with no weights returns all-zero object', () => {
    const result = computeLifecycleSplit(0, {});
    expect(result).not.toBeNull();
    for (const stage of STAGES) {
      expect(result![stage]).toBe(0);
    }
  });

  // --- No-signal ticket → null ---

  it('nonzero cost with all weights absent returns null', () => {
    expect(computeLifecycleSplit(5.0, {})).toBeNull();
  });

  it('nonzero cost with all weights zero returns null', () => {
    expect(computeLifecycleSplit(5.0, { execution: 0, review: 0 })).toBeNull();
  });

  it('nonzero cost with only verify weight (forced to 0) returns null', () => {
    expect(computeLifecycleSplit(3.0, { verify: 50 })).toBeNull();
  });

  // --- Proportionality ---

  it('execution 3× review: lifecycle.execution === 3 × lifecycle.review', () => {
    const cost = 8.0;
    const result = computeLifecycleSplit(cost, { execution: 9, review: 3 });
    expect(result).not.toBeNull();
    expect(result!.execution).toBeCloseTo(result!.review * 3, 10);
  });

  it('proportionality with multiple stages', () => {
    const cost = 12.0;
    const result = computeLifecycleSplit(cost, { refine: 1, spec: 2, execution: 6, review: 3 });
    expect(result).not.toBeNull();
    const total = 1 + 2 + 6 + 3;
    expect(result!.refine).toBeCloseTo(cost * (1 / total), 8);
    expect(result!.spec).toBeCloseTo(cost * (2 / total), 8);
    expect(result!.execution).toBeCloseTo(cost * (6 / total), 8);
    expect(result!.review).toBeCloseTo(cost * (3 / total), 8);
  });

  // --- Residual rule ---

  it('residual is assigned to the largest-weight stage', () => {
    // With floating point, sum may drift; largest stage should absorb the residual
    const cost = 1.0 / 3.0; // 0.333...
    const result = computeLifecycleSplit(cost, { execution: 1 });
    expect(result).not.toBeNull();
    const sum = STAGES.reduce((s, stage) => s + result![stage], 0);
    expect(Math.abs(sum - cost)).toBeLessThan(1e-10);
    expect(result!.execution).toBeCloseTo(cost, 10);
  });
});

// ---------------------------------------------------------------------------
// aggregateByTicket — lifecycle plumbing integration
// ---------------------------------------------------------------------------

import { describe as d2, it as it2, expect as expect2, beforeEach as be2, afterEach as ae2 } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { aggregateByTicket } from '../../../src/main/telemetry/aggregator';
import type { StepWeightRow, EphemeralWeightRecord } from '../../../src/main/telemetry/aggregator';

d2('aggregateByTicket lifecycle plumbing', () => {
  let tmpDir: string;

  be2(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-agg-')); });
  ae2(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const makeEntry = (sid: string, stackId: string | null, model = 'claude-sonnet-4-5', input = 1000, output = 500) => ({
    sessionId: sid,
    stackId,
    model,
    input,
    output,
    cacheCreate: 0,
    cacheRead: 0,
    timestamp: '2024-03-01T10:00:00.000Z',
  });

  const makeManifest = (dir: string, stackId: string, ticket: string) => {
    fs.writeFileSync(dir + '.manifest.json', JSON.stringify({ stackId, ticket, project: 'p', createdAt: '2024-01-01T00:00:00.000Z' }));
  };

  it2('no weights → lifecycle null for nonzero-cost ticket', () => {
    const stackDir = path.join(tmpDir, 'stack-nw');
    fs.mkdirSync(stackDir);
    makeManifest(stackDir, 'stack-nw', 'T-1');

    const result = aggregateByTicket([makeEntry('s1', 'stack-nw')], [stackDir]);
    const row = result.find((r) => r.ticketId === 'T-1');
    expect(row).toBeDefined();
    expect2(row!.lifecycle).toBeNull();
  });

  it2('step weights → lifecycle populated, verify always 0', () => {
    const stackDir = path.join(tmpDir, 'stack-sw');
    fs.mkdirSync(stackDir);
    makeManifest(stackDir, 'stack-sw', 'T-2');

    const stepWeights: StepWeightRow[] = [
      { ticket: 'T-2', phase: 'execution', totalTokens: 300 },
      { ticket: 'T-2', phase: 'review', totalTokens: 100 },
    ];

    const result = aggregateByTicket([makeEntry('s1', 'stack-sw')], [stackDir], stepWeights);
    const row = result.find((r) => r.ticketId === 'T-2');
    expect(row).toBeDefined();
    expect2(row!.lifecycle).not.toBeNull();
    expect2(row!.lifecycle!.verify).toBe(0);

    // Sum must equal cost
    const lc = row!.lifecycle!;
    const sum = lc.refine + lc.spec + lc.execution + lc.review + lc.verify + lc.pr;
    expect2(Math.abs(sum - row!.cost)).toBeLessThan(1e-10);
  });

  it2('ephemeral record feeds spec weight into lifecycle', () => {
    const stackDir = path.join(tmpDir, 'stack-ep');
    fs.mkdirSync(stackDir);
    makeManifest(stackDir, 'stack-ep', 'T-3');

    const ephemeralRecords: EphemeralWeightRecord[] = [
      { ticketId: 'T-3', stage: 'spec', turnCount: 5 },
    ];

    const result = aggregateByTicket([makeEntry('s1', 'stack-ep')], [stackDir], [], ephemeralRecords);
    const row = result.find((r) => r.ticketId === 'T-3');
    expect(row).toBeDefined();
    expect2(row!.lifecycle).not.toBeNull();
    expect2(row!.lifecycle!.spec).toBeGreaterThan(0);
    expect2(row!.lifecycle!.verify).toBe(0);
  });

  it2('multi-stack ticket: step weights sum across stacks', () => {
    const stackDir1 = path.join(tmpDir, 'stack-ms1');
    const stackDir2 = path.join(tmpDir, 'stack-ms2');
    fs.mkdirSync(stackDir1);
    fs.mkdirSync(stackDir2);
    makeManifest(stackDir1, 'stack-ms1', 'T-4');
    makeManifest(stackDir2, 'stack-ms2', 'T-4');

    const stepWeights: StepWeightRow[] = [
      { ticket: 'T-4', phase: 'execution', totalTokens: 200 },
      { ticket: 'T-4', phase: 'execution', totalTokens: 400 }, // second stack
      { ticket: 'T-4', phase: 'review', totalTokens: 100 },
    ];

    const entries = [
      makeEntry('s1', 'stack-ms1'),
      makeEntry('s2', 'stack-ms2'),
    ];
    const result = aggregateByTicket(entries, [stackDir1, stackDir2], stepWeights);
    const row = result.find((r) => r.ticketId === 'T-4');
    expect(row).toBeDefined();
    expect2(row!.lifecycle).not.toBeNull();
    const lc = row!.lifecycle!;
    const sum = lc.refine + lc.spec + lc.execution + lc.review + lc.verify + lc.pr;
    expect2(Math.abs(sum - row!.cost)).toBeLessThan(1e-10);
    // execution weight 600 vs review 100 → execution should be ~6× review
    expect2(lc.execution).toBeCloseTo(lc.review * 6, 6);
  });

  it2('orchestrator bucket always has lifecycle null', () => {
    const result = aggregateByTicket([makeEntry('s1', null)], []);
    const row = result.find((r) => r.ticketId === '__orchestrator__');
    expect(row).toBeDefined();
    // Orchestrator has no step or ephemeral weights → lifecycle null
    expect2(row!.lifecycle).toBeNull();
  });
});
