/**
 * byticket-contract.test.ts — cooperation guard for ByTicketEntry shape and byTicket IPC contract.
 *
 * These tests are independent of data source. Any future field-drop or re-point on
 * ByTicketEntry or the byTicket engine signature will fail here before it can silently
 * break downstream consumers (#522, #523).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { createUsageEngine, clearUsageCache } from '../../../src/main/telemetry/usage-engine';
import type { ByTicketEntry, LifecycleCosts, DateRange } from '../../../src/main/telemetry/types';

// ---------------------------------------------------------------------------
// ByTicketEntry shape contract
// ---------------------------------------------------------------------------

describe('ByTicketEntry shape contract', () => {
  it('has exactly the 7 canonical fields', () => {
    const expected = ['ticketId', 'model', 'cost', 'tokens', 'cacheHit', 'lifecycle', 'unpriced'].sort();

    // Construct a minimal conforming object to verify the type at runtime
    const row: ByTicketEntry = {
      ticketId: 'TEST-1',
      model: 'claude-sonnet-4-5',
      cost: 1.5,
      tokens: { input: 100, output: 50, cacheCreate: 0, cacheRead: 0, total: 150 },
      cacheHit: 0,
      lifecycle: null,
      unpriced: false,
    };

    expect(Object.keys(row).sort()).toEqual(expected);
  });

  it('tokens sub-object has exactly 5 fields', () => {
    const row: ByTicketEntry = {
      ticketId: 'TEST-2',
      model: null,
      cost: 0,
      tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
      cacheHit: 0,
      lifecycle: null,
      unpriced: false,
    };
    expect(Object.keys(row.tokens).sort()).toEqual(
      ['cacheCreate', 'cacheRead', 'input', 'output', 'total'].sort()
    );
  });

  it('lifecycle is null or has exactly the 6 stage fields', () => {
    const nullLifecycle: ByTicketEntry = {
      ticketId: 'TEST-3', model: null, cost: 0,
      tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
      cacheHit: 0, lifecycle: null, unpriced: false,
    };
    expect(nullLifecycle.lifecycle).toBeNull();

    const lc: LifecycleCosts = { refine: 0.1, spec: 0.2, execution: 0.5, review: 0.1, verify: 0, pr: 0.1 };
    const withLifecycle: ByTicketEntry = { ...nullLifecycle, ticketId: 'TEST-4', lifecycle: lc };
    expect(withLifecycle.lifecycle).not.toBeNull();
    expect(Object.keys(withLifecycle.lifecycle!).sort()).toEqual(
      ['execution', 'pr', 'refine', 'review', 'spec', 'verify'].sort()
    );
  });

  it('unpriced field exists and is boolean', () => {
    const row: ByTicketEntry = {
      ticketId: 'TEST-5', model: null, cost: 0,
      tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
      cacheHit: 0, lifecycle: null, unpriced: true,
    };
    expect(typeof row.unpriced).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// UsageEngine.getByTicket range contract
// ---------------------------------------------------------------------------

describe('UsageEngine.getByTicket accepts DateRange', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byticket-contract-'));
    clearUsageCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearUsageCache();
  });

  function writeTranscript(dir: string, model: string, timestamp: string, sessionId: string) {
    const entry = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      timestamp,
      sessionId,
    });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), entry + '\n');
  }

  function writeManifest(stackRoot: string, stackId: string, ticket: string) {
    fs.writeFileSync(stackRoot + '.manifest.json', JSON.stringify({
      stackId, ticket, project: 'p', createdAt: '2024-01-01T00:00:00.000Z',
    }));
  }

  it('getByTicket signature accepts a DateRange argument', () => {
    // Type-level check: calling getByTicket with a DateRange must compile and run
    const engine = createUsageEngine(['/nonexistent']);
    const range: DateRange = { since: '2024-01-01', until: '2024-12-31' };
    expect(() => engine.getByTicket(range)).not.toThrow();
    expect(Array.isArray(engine.getByTicket(range))).toBe(true);
  });

  it('filters entries outside the range — only in-range cost returned', () => {
    const stackRoot = path.join(tmpDir, 'stack-range');
    fs.mkdirSync(stackRoot);
    writeManifest(stackRoot, 'stack-range', 'TICKET-R');

    // In-range entry: Jan 15 2024
    writeTranscript(stackRoot, 'claude-sonnet-4-5', '2024-01-15T10:00:00.000Z', 'sess-in');
    // Out-of-range entry: Feb 1 2024
    writeTranscript(stackRoot, 'claude-sonnet-4-5', '2024-02-01T10:00:00.000Z', 'sess-out');

    const engine = createUsageEngine([stackRoot]);
    const narrow: DateRange = { since: '2024-01-01', until: '2024-01-31' };
    const all: DateRange = { since: '2000-01-01', until: '2099-12-31' };

    const narrowRows = engine.getByTicket(narrow);
    const allRows = engine.getByTicket(all);

    const narrowTicket = narrowRows.find((r) => r.ticketId === 'TICKET-R');
    const allTicket = allRows.find((r) => r.ticketId === 'TICKET-R');

    expect(narrowTicket).toBeDefined();
    expect(allTicket).toBeDefined();
    // All-time cost must be higher (includes both entries)
    expect(allTicket!.cost).toBeGreaterThan(narrowTicket!.cost);
  });

  it('range: all-time returns all entries', () => {
    const stackRoot = path.join(tmpDir, 'stack-all');
    fs.mkdirSync(stackRoot);
    writeManifest(stackRoot, 'stack-all', 'TICKET-ALL');

    writeTranscript(stackRoot, 'claude-sonnet-4-5', '2020-01-01T00:00:00.000Z', 'sess-old');
    writeTranscript(stackRoot, 'claude-sonnet-4-5', '2024-06-01T00:00:00.000Z', 'sess-new');

    const engine = createUsageEngine([stackRoot]);
    const allRows = engine.getByTicket({ since: '2000-01-01', until: '2099-12-31' });

    const ticket = allRows.find((r) => r.ticketId === 'TICKET-ALL');
    expect(ticket).toBeDefined();
    expect(ticket!.tokens.input).toBe(200); // both entries (100 each)
  });

  it('emitted rows satisfy the 7-field canonical contract', () => {
    const stackRoot = path.join(tmpDir, 'stack-contract');
    fs.mkdirSync(stackRoot);
    writeManifest(stackRoot, 'stack-contract', 'TICKET-C');
    writeTranscript(stackRoot, 'claude-sonnet-4-5', '2024-03-01T10:00:00.000Z', 'sess-c');

    const engine = createUsageEngine([stackRoot]);
    const rows = engine.getByTicket({ since: '2024-01-01', until: '2024-12-31' });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['cacheHit', 'cost', 'lifecycle', 'model', 'ticketId', 'tokens', 'unpriced'].sort()
      );
      expect(typeof row.ticketId).toBe('string');
      expect(typeof row.unpriced).toBe('boolean');
    }
  });
});
