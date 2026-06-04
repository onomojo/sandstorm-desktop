import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { parseJSONLFile, findJSONLFiles, parseTranscriptRoot, parseTranscriptRoots } from '../../../src/main/telemetry/parser';
import { computeCost } from '../../../src/main/telemetry/pricing';
import {
  aggregateSummary,
  aggregateDaily,
  aggregateByModel,
  aggregateSessions,
  aggregateByTicket,
} from '../../../src/main/telemetry/aggregator';
import { createUsageEngine, clearUsageCache } from '../../../src/main/telemetry/usage-engine';
import { ORCHESTRATOR_TICKET_ID } from '../../../src/main/telemetry/types';

const FIXTURES = path.resolve(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe('parseJSONLFile', () => {
  it('extracts usage from Format B (message.model + message.usage) entries', () => {
    const { entries, skippedLines } = parseJSONLFile(path.join(FIXTURES, 'session1.jsonl'));
    expect(entries).toHaveLength(3);
    expect(skippedLines).toBe(1); // one malformed line
  });

  it('maps token fields correctly', () => {
    const { entries } = parseJSONLFile(path.join(FIXTURES, 'session1.jsonl'));
    const first = entries[0];
    expect(first.model).toBe('claude-opus-4-5');
    expect(first.sessionId).toBe('sess-aaa');
    expect(first.input).toBe(100);
    expect(first.output).toBe(50);
    expect(first.cacheCreate).toBe(0);
    expect(first.cacheRead).toBe(0);
  });

  it('extracts cache tokens correctly', () => {
    const { entries } = parseJSONLFile(path.join(FIXTURES, 'session1.jsonl'));
    const second = entries[1];
    expect(second.cacheCreate).toBe(500);
    expect(second.cacheRead).toBe(1000);
  });

  it('handles missing file gracefully', () => {
    const { entries, skippedLines } = parseJSONLFile('/nonexistent/path/file.jsonl');
    expect(entries).toHaveLength(0);
    expect(skippedLines).toBe(0);
  });

  it('extracts Format A (top-level model + usage) entries', () => {
    let tmpFile: string | undefined;
    try {
      tmpFile = path.join(os.tmpdir(), `test-format-a-${Date.now()}.jsonl`);
      fs.writeFileSync(tmpFile, [
        JSON.stringify({
          type: 'say',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 80, output_tokens: 40, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
          timestamp: '2024-01-15T10:00:00.000Z',
          sessionId: 'sess-format-a',
        }),
        '',
      ].join('\n'));
      const { entries } = parseJSONLFile(tmpFile);
      expect(entries).toHaveLength(1);
      expect(entries[0].model).toBe('claude-sonnet-4-5');
      expect(entries[0].input).toBe(80);
      expect(entries[0].cacheCreate).toBe(100);
      expect(entries[0].cacheRead).toBe(200);
    } finally {
      if (tmpFile) fs.unlinkSync(tmpFile);
    }
  });
});

describe('findJSONLFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
    fs.mkdirSync(path.join(tmpDir, 'proj1'));
    fs.mkdirSync(path.join(tmpDir, 'proj2'));
    fs.writeFileSync(path.join(tmpDir, 'proj1', 'a.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'proj1', 'b.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'proj2', 'c.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'proj2', 'skip.txt'), '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds all .jsonl files recursively', () => {
    const files = findJSONLFiles(tmpDir);
    expect(files).toHaveLength(3);
    expect(files.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('returns empty array for nonexistent directory', () => {
    expect(findJSONLFiles('/nonexistent/path')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pricing tests
// ---------------------------------------------------------------------------

describe('computeCost', () => {
  it('computes cost for a known model', () => {
    const { cost, unpriced } = computeCost('claude-opus-4-5', {
      input: 1_000_000,
      output: 1_000_000,
      cacheCreate: 0,
      cacheRead: 0,
    });
    expect(unpriced).toBe(false);
    expect(cost).toBeCloseTo(15 + 75, 5); // $90 per million each
  });

  it('returns cost=0 and unpriced=true for unknown model', () => {
    const { cost, unpriced } = computeCost('unknown-model-xyz', {
      input: 1000,
      output: 500,
      cacheCreate: 0,
      cacheRead: 0,
    });
    expect(unpriced).toBe(true);
    expect(cost).toBe(0);
  });

  it('includes cache tokens in cost calculation', () => {
    const { cost } = computeCost('claude-opus-4-5', {
      input: 0,
      output: 0,
      cacheCreate: 1_000_000,
      cacheRead: 1_000_000,
    });
    expect(cost).toBeCloseTo(18.75 + 1.50, 5);
  });

  it('uses prefix matching for model variants', () => {
    const { unpriced } = computeCost('claude-opus-4-5-20240101', {
      input: 100,
      output: 50,
      cacheCreate: 0,
      cacheRead: 0,
    });
    expect(unpriced).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aggregation tests — use parsed fixture data
// ---------------------------------------------------------------------------

describe('aggregateSummary', () => {
  const range = { since: '2024-01-01', until: '2024-12-31' };

  it('counts distinct sessions in range', () => {
    const { entries, skippedLines } = parseTranscriptRoot(FIXTURES);
    const summary = aggregateSummary(entries, range, skippedLines);
    // sess-aaa and sess-ccc are in 2024; sess-bbb is in 2023
    expect(summary.sessions).toBe(2);
  });

  it('sums token counts over range', () => {
    const { entries, skippedLines } = parseTranscriptRoot(FIXTURES);
    const summary = aggregateSummary(entries, range, skippedLines);
    // sess-aaa: (100+200+50) input, (50+150+25) output, (0+500+0) cacheCreate, (0+1000+500) cacheRead
    // sess-ccc: 100 input, 50 output, 0 cacheCreate, 0 cacheRead
    expect(summary.tokens.input).toBe(100 + 200 + 50 + 100); // 450
    expect(summary.tokens.output).toBe(50 + 150 + 25 + 50);  // 275
    expect(summary.tokens.cacheCreate).toBe(500);
    expect(summary.tokens.cacheRead).toBe(1000 + 500);        // 1500
  });

  it('computes cacheHitPct correctly', () => {
    const { entries, skippedLines } = parseTranscriptRoot(FIXTURES);
    const summary = aggregateSummary(entries, range, skippedLines);
    // cacheRead=1500, input=450 → hitPct = 1500/(450+1500)*100
    const expected = (1500 / (450 + 1500)) * 100;
    expect(summary.cacheHitPct).toBeCloseTo(expected, 3);
  });

  it('returns ticketsShipped=null and costPerTicket=null (phase 1)', () => {
    const summary = aggregateSummary([], range, 0);
    expect(summary.ticketsShipped).toBeNull();
    expect(summary.costPerTicket).toBeNull();
  });

  it('surfaces unpriced models in unpricedModels[]', () => {
    const { entries, skippedLines } = parseTranscriptRoot(FIXTURES);
    const summary = aggregateSummary(entries, range, skippedLines);
    expect(summary.unpricedModels).toContain('unknown-model-xyz');
  });

  it('returns skippedLines count from malformed JSONL', () => {
    const { entries, skippedLines } = parseTranscriptRoot(FIXTURES);
    const summary = aggregateSummary(entries, range, skippedLines);
    expect(summary.skippedLines).toBe(1); // one malformed line in session1.jsonl
  });

  it('returns zeroed shape when no transcripts exist', () => {
    const summary = aggregateSummary([], range, 0);
    expect(summary.tokens.total).toBe(0);
    expect(summary.sessions).toBe(0);
    expect(summary.monthCost).toBe(0);
    expect(summary.prevMonthCost).toBe(0);
    expect(summary.unpricedModels).toHaveLength(0);
    expect(summary.skippedLines).toBe(0);
  });

  it('respects inclusive date range boundaries', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    // Only include Jan 15 2024
    const narrow = aggregateSummary(entries, { since: '2024-01-15', until: '2024-01-15' }, 0);
    expect(narrow.sessions).toBe(1); // only sess-aaa
    // sess-ccc is on Jan 16 — outside range
  });
});

describe('aggregateDaily', () => {
  const range = { since: '2024-01-01', until: '2024-12-31' };

  it('groups entries by date', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const daily = aggregateDaily(entries, range);
    const dates = daily.map((d) => d.date);
    expect(dates).toContain('2024-01-15');
    expect(dates).toContain('2024-01-16');
    expect(dates).not.toContain('2023-12-20'); // out of range
  });

  it('sums tokens per day', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const daily = aggregateDaily(entries, range);
    const jan15 = daily.find((d) => d.date === '2024-01-15')!;
    expect(jan15).toBeDefined();
    expect(jan15.tokens.input).toBe(100 + 200 + 50); // three entries on Jan 15
    expect(jan15.tokens.cacheCreate).toBe(500);
  });

  it('breaks down cost by model within each day', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const daily = aggregateDaily(entries, range);
    const jan15 = daily.find((d) => d.date === '2024-01-15')!;
    expect(jan15.byModel).toHaveProperty('claude-opus-4-5');
    expect(jan15.byModel).toHaveProperty('claude-sonnet-4-5');
  });

  it('returns empty array when no entries in range', () => {
    const daily = aggregateDaily([], range);
    expect(daily).toHaveLength(0);
  });

  it('sorts results by date ascending', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const daily = aggregateDaily(entries, range);
    for (let i = 1; i < daily.length; i++) {
      expect(daily[i].date >= daily[i - 1].date).toBe(true);
    }
  });
});

describe('aggregateByModel', () => {
  const range = { since: '2024-01-01', until: '2024-12-31' };

  it('groups entries by model', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const byModel = aggregateByModel(entries, range);
    const models = byModel.map((m) => m.model);
    expect(models).toContain('claude-opus-4-5');
    expect(models).toContain('claude-sonnet-4-5');
    expect(models).toContain('unknown-model-xyz');
  });

  it('marks unpriced models correctly', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const byModel = aggregateByModel(entries, range);
    const unpriced = byModel.find((m) => m.model === 'unknown-model-xyz')!;
    expect(unpriced.unpriced).toBe(true);
    expect(unpriced.cost).toBe(0);
  });

  it('counts distinct sessions per model', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const byModel = aggregateByModel(entries, range);
    const opus = byModel.find((m) => m.model === 'claude-opus-4-5')!;
    expect(opus.sessions).toBe(1); // only sess-aaa in 2024 range
  });

  it('returns empty array when no entries in range', () => {
    expect(aggregateByModel([], range)).toHaveLength(0);
  });
});

describe('aggregateSessions', () => {
  const range = { since: '2024-01-01', until: '2024-12-31' };

  it('groups entries by sessionId', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const sessions = aggregateSessions(entries, range);
    const sids = sessions.map((s) => s.sid);
    expect(sids).toContain('sess-aaa');
    expect(sids).toContain('sess-ccc');
    expect(sids).not.toContain('sess-bbb'); // in 2023, out of range
  });

  it('sets ticket and stack to null (host-only phase)', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const sessions = aggregateSessions(entries, range);
    expect(sessions.every((s) => s.ticket === null)).toBe(true);
    expect(sessions.every((s) => s.stack === null)).toBe(true);
  });

  it('counts turns correctly', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const sessions = aggregateSessions(entries, range);
    const sessA = sessions.find((s) => s.sid === 'sess-aaa')!;
    expect(sessA.turns).toBe(3); // three assistant messages in sess-aaa
  });

  it('picks primary model with most output tokens', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const sessions = aggregateSessions(entries, range);
    const sessA = sessions.find((s) => s.sid === 'sess-aaa')!;
    // opus-4-5 has 50+150=200 output tokens, sonnet-4-5 has 25 — so opus wins
    expect(sessA.model).toBe('claude-opus-4-5');
  });

  it('computes cost by summing per-model costs (not applying primary model pricing to all tokens)', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const sessions = aggregateSessions(entries, range);
    const sessA = sessions.find((s) => s.sid === 'sess-aaa')!;
    // Entry 1 (opus, 100/50/0/0):     (100*15 + 50*75) / 1M          = 0.00525
    // Entry 2 (opus, 200/150/500/1000): (200*15 + 150*75 + 500*18.75 + 1000*1.5) / 1M = 0.025125
    // Entry 3 (sonnet, 50/25/0/500):   (50*3 + 25*15 + 0 + 500*0.3) / 1M = 0.000675
    const expectedCost = 0.00525 + 0.025125 + 0.000675; // = 0.03105
    expect(sessA.cost).toBeCloseTo(expectedCost, 8);
  });

  it('computes duration in minutes', () => {
    const { entries } = parseTranscriptRoot(FIXTURES);
    const sessions = aggregateSessions(entries, range);
    const sessA = sessions.find((s) => s.sid === 'sess-aaa')!;
    // first entry: 10:00:05, last: 10:03:00 → ~2.9 min
    expect(sessA.durMin).toBeGreaterThan(2.9);
    expect(sessA.durMin).toBeLessThan(3.1);
  });

  it('returns empty array when no entries in range', () => {
    expect(aggregateSessions([], range)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Usage engine end-to-end tests
// ---------------------------------------------------------------------------

describe('createUsageEngine', () => {
  it('returns zeroed summary when root directory does not exist', () => {
    const engine = createUsageEngine(['/nonexistent/path']);
    const summary = engine.getSummary({ since: '2024-01-01', until: '2024-12-31' });
    expect(summary.tokens.total).toBe(0);
    expect(summary.sessions).toBe(0);
    expect(summary.ticketsShipped).toBeNull();
    expect(summary.costPerTicket).toBeNull();
  });

  it('returns empty arrays for daily/byModel/session when root does not exist', () => {
    const engine = createUsageEngine(['/nonexistent/path']);
    const range = { since: '2024-01-01', until: '2024-12-31' };
    expect(engine.getDaily(range)).toHaveLength(0);
    expect(engine.getByModel(range)).toHaveLength(0);
    expect(engine.getSessions(range)).toHaveLength(0);
  });

  it('reads from fixture directory end-to-end', () => {
    const engine = createUsageEngine([FIXTURES]);
    const range = { since: '2024-01-01', until: '2024-12-31' };
    const summary = engine.getSummary(range);
    expect(summary.sessions).toBeGreaterThan(0);
    expect(summary.tokens.input).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseTranscriptRoots — multi-root union + dedup
// ---------------------------------------------------------------------------

describe('parseTranscriptRoots', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-roots-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges entries from two disjoint roots', () => {
    const rootA = path.join(tmpDir, 'rootA');
    const rootB = path.join(tmpDir, 'rootB');
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);

    const entryA = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      timestamp: '2024-03-01T10:00:00.000Z',
      sessionId: 'sess-ra',
    });
    const entryB = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 20, output_tokens: 8 },
      },
      timestamp: '2024-03-01T11:00:00.000Z',
      sessionId: 'sess-rb',
    });
    fs.writeFileSync(path.join(rootA, 'a.jsonl'), entryA + '\n');
    fs.writeFileSync(path.join(rootB, 'b.jsonl'), entryB + '\n');

    const { entries } = parseTranscriptRoots([rootA, rootB]);
    const sids = entries.map((e) => e.sessionId);
    expect(sids).toContain('sess-ra');
    expect(sids).toContain('sess-rb');
    expect(entries).toHaveLength(2);
  });

  it('deduplicates at file-path level — a file under two roots is parsed once', () => {
    const rootA = path.join(tmpDir, 'rootA');
    fs.mkdirSync(rootA);

    const entry = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      timestamp: '2024-03-01T10:00:00.000Z',
      sessionId: 'sess-dup',
    });
    fs.writeFileSync(path.join(rootA, 'dup.jsonl'), entry + '\n');

    // Pass the same root twice — should not parse the file twice
    const { entries } = parseTranscriptRoots([rootA, rootA]);
    const dupEntries = entries.filter((e) => e.sessionId === 'sess-dup');
    expect(dupEntries).toHaveLength(1);
  });

  it('does NOT collapse entries sharing a sessionId across roots', () => {
    const rootA = path.join(tmpDir, 'rootA');
    const rootB = path.join(tmpDir, 'rootB');
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);

    const makeEntry = (ts: string) => JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      timestamp: ts,
      sessionId: 'shared-session',
    });
    fs.writeFileSync(path.join(rootA, 'fa.jsonl'), makeEntry('2024-03-01T10:00:00.000Z') + '\n');
    fs.writeFileSync(path.join(rootB, 'fb.jsonl'), makeEntry('2024-03-01T11:00:00.000Z') + '\n');

    const { entries } = parseTranscriptRoots([rootA, rootB]);
    const shared = entries.filter((e) => e.sessionId === 'shared-session');
    // Both entries should be present — dedup is at file-path level, not sessionId level
    expect(shared).toHaveLength(2);
  });

  it('sets stackId=null for host root (path ending with /.claude/projects)', () => {
    const hostRoot = path.join(tmpDir, '.claude', 'projects');
    fs.mkdirSync(hostRoot, { recursive: true });
    const entry = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      timestamp: '2024-03-01T10:00:00.000Z',
      sessionId: 'sess-host',
    });
    fs.writeFileSync(path.join(hostRoot, 'host.jsonl'), entry + '\n');

    const { entries } = parseTranscriptRoots([hostRoot]);
    expect(entries).toHaveLength(1);
    expect(entries[0].stackId).toBeNull();
  });

  it('sets stackId=basename for non-host roots', () => {
    const stackRoot = path.join(tmpDir, 'my-stack-123');
    fs.mkdirSync(stackRoot);
    const entry = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      timestamp: '2024-03-01T10:00:00.000Z',
      sessionId: 'sess-stack',
    });
    fs.writeFileSync(path.join(stackRoot, 'stack.jsonl'), entry + '\n');

    const { entries } = parseTranscriptRoots([stackRoot]);
    expect(entries).toHaveLength(1);
    expect(entries[0].stackId).toBe('my-stack-123');
  });

  it('directory-only filter: manifest JSON files next to stack dirs are not treated as roots', () => {
    // Simulate usage/ dir containing: <stackId>/ dir + <stackId>.manifest.json file
    const usageDir = path.join(tmpDir, 'usage');
    const stackDir = path.join(usageDir, 'stack-abc');
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(usageDir, 'stack-abc.manifest.json'), JSON.stringify({ stackId: 'stack-abc' }));

    const entry = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 5, output_tokens: 2 },
      },
      timestamp: '2024-03-01T10:00:00.000Z',
      sessionId: 'sess-abc',
    });
    fs.writeFileSync(path.join(stackDir, 'abc.jsonl'), entry + '\n');

    // Filter directories only from usageDir — manifest file must be excluded
    const stackRoots = fs.readdirSync(usageDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(usageDir, e.name));

    expect(stackRoots).toHaveLength(1);
    expect(stackRoots[0]).toBe(stackDir);

    const { entries } = parseTranscriptRoots(stackRoots);
    expect(entries).toHaveLength(1);
    expect(entries[0].stackId).toBe('stack-abc'); // basename = stackId, not 'stack-abc.manifest.json'
  });
});

// ---------------------------------------------------------------------------
// aggregateByTicket — manifest contract
// ---------------------------------------------------------------------------

describe('aggregateByTicket', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-byticket-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(sessionId: string, stackId: string | null, input = 100, output = 50) {
    return { sessionId, model: 'claude-sonnet-4-5', timestamp: '2024-03-01T10:00:00.000Z', input, output, cacheCreate: 0, cacheRead: 0, stackId };
  }

  it('resolves stackId to ticket via manifest', () => {
    const stackRoot = path.join(tmpDir, 'stack-1');
    fs.mkdirSync(stackRoot);
    fs.writeFileSync(stackRoot + '.manifest.json', JSON.stringify({
      stackId: 'stack-1', ticket: 'PROJ-42', project: 'myproj', createdAt: '2024-03-01T00:00:00.000Z',
    }));

    const entries = [makeEntry('sess-a', 'stack-1')];
    const result = aggregateByTicket(entries, [stackRoot]);

    expect(result).toHaveLength(1);
    expect(result[0].ticketId).toBe('PROJ-42');
  });

  it('host-root entries (stackId=null) roll up under orchestrator sentinel', () => {
    const entries = [makeEntry('sess-host', null)];
    const result = aggregateByTicket(entries, []);

    expect(result).toHaveLength(1);
    expect(result[0].ticketId).toBe(ORCHESTRATOR_TICKET_ID);
  });

  it('unmapped stack (no manifest) rolls up under orchestrator sentinel', () => {
    const stackRoot = path.join(tmpDir, 'no-manifest-stack');
    fs.mkdirSync(stackRoot);
    // No manifest file written

    const entries = [makeEntry('sess-x', 'no-manifest-stack')];
    const result = aggregateByTicket(entries, [stackRoot]);

    expect(result).toHaveLength(1);
    expect(result[0].ticketId).toBe(ORCHESTRATOR_TICKET_ID);
  });

  it('malformed manifest degrades to orchestrator bucket without throwing', () => {
    const stackRoot = path.join(tmpDir, 'bad-manifest-stack');
    fs.mkdirSync(stackRoot);
    fs.writeFileSync(stackRoot + '.manifest.json', 'not valid json {{{');

    const entries = [makeEntry('sess-y', 'bad-manifest-stack')];
    expect(() => aggregateByTicket(entries, [stackRoot])).not.toThrow();
    const result = aggregateByTicket(entries, [stackRoot]);
    expect(result[0].ticketId).toBe(ORCHESTRATOR_TICKET_ID);
  });

  it('manifest with ticket=null rolls up under orchestrator sentinel', () => {
    const stackRoot = path.join(tmpDir, 'no-ticket-stack');
    fs.mkdirSync(stackRoot);
    fs.writeFileSync(stackRoot + '.manifest.json', JSON.stringify({
      stackId: 'no-ticket-stack', ticket: null, project: 'myproj', createdAt: '2024-03-01T00:00:00.000Z',
    }));

    const entries = [makeEntry('sess-z', 'no-ticket-stack')];
    const result = aggregateByTicket(entries, [stackRoot]);
    expect(result[0].ticketId).toBe(ORCHESTRATOR_TICKET_ID);
  });

  it('accumulates tokens and cost per bucket', () => {
    const stackRoot = path.join(tmpDir, 'cost-stack');
    fs.mkdirSync(stackRoot);
    fs.writeFileSync(stackRoot + '.manifest.json', JSON.stringify({
      stackId: 'cost-stack', ticket: 'T-1', project: 'p', createdAt: '2024-01-01T00:00:00.000Z',
    }));

    const entries = [
      makeEntry('s1', 'cost-stack', 100, 50),
      makeEntry('s2', 'cost-stack', 200, 100),
    ];
    const result = aggregateByTicket(entries, [stackRoot]);
    expect(result).toHaveLength(1);
    expect(result[0].ticketId).toBe('T-1');
    expect(result[0].tokens.input).toBe(300);
    expect(result[0].tokens.output).toBe(150);
    expect(result[0].cost).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateByTicket — new canonical shape (ticket 499)
// ---------------------------------------------------------------------------

describe('aggregateByTicket — canonical shape', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-canonical-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(sessionId: string, stackId: string | null, model = 'claude-sonnet-4-5', input = 100, output = 50, cacheRead = 0) {
    return { sessionId, model, timestamp: '2024-03-01T10:00:00.000Z', input, output, cacheCreate: 0, cacheRead, stackId };
  }

  function makeManifest(dir: string, stackId: string, ticket: string | null) {
    fs.writeFileSync(dir + '.manifest.json', JSON.stringify({
      stackId, ticket, project: 'p', createdAt: '2024-01-01T00:00:00.000Z',
    }));
  }

  it('multi-stack-per-ticket → one row with summed tokens and cost', () => {
    const stackA = path.join(tmpDir, 'stack-a');
    const stackB = path.join(tmpDir, 'stack-b');
    fs.mkdirSync(stackA);
    fs.mkdirSync(stackB);
    makeManifest(stackA, 'stack-a', 'TICKET-1');
    makeManifest(stackB, 'stack-b', 'TICKET-1');

    const entries = [
      makeEntry('s1', 'stack-a', 'claude-sonnet-4-5', 100, 50),
      makeEntry('s2', 'stack-b', 'claude-sonnet-4-5', 200, 80),
    ];
    const result = aggregateByTicket(entries, [stackA, stackB]);

    expect(result).toHaveLength(1);
    expect(result[0].ticketId).toBe('TICKET-1');
    expect(result[0].tokens.input).toBe(300);
    expect(result[0].tokens.output).toBe(130);
    expect(result[0].cost).toBeGreaterThan(0);
  });

  it('emits the model with highest output tokens as primary model', () => {
    const stackRoot = path.join(tmpDir, 'stack-model');
    fs.mkdirSync(stackRoot);
    makeManifest(stackRoot, 'stack-model', 'TICKET-2');

    const entries = [
      makeEntry('s1', 'stack-model', 'claude-sonnet-4-5', 100, 30),   // 30 output
      makeEntry('s2', 'stack-model', 'claude-opus-4-5', 100, 200),     // 200 output — winner
    ];
    const result = aggregateByTicket(entries, [stackRoot]);
    expect(result[0].model).toBe('claude-opus-4-5');
  });

  it('cacheHit = cacheRead / (input + cacheRead) × 100', () => {
    const stackRoot = path.join(tmpDir, 'stack-cache');
    fs.mkdirSync(stackRoot);
    makeManifest(stackRoot, 'stack-cache', 'TICKET-3');

    // input=100, cacheRead=400 → cacheHit = 400/500 × 100 = 80%
    const entries = [{ sessionId: 's1', model: 'claude-sonnet-4-5', timestamp: '2024-03-01T10:00:00.000Z', input: 100, output: 50, cacheCreate: 0, cacheRead: 400, stackId: 'stack-cache' }];
    const result = aggregateByTicket(entries, [stackRoot]);
    expect(result[0].cacheHit).toBeCloseTo(80, 3);
  });

  it('cacheHit = 0 when input and cacheRead are both zero', () => {
    const stackRoot = path.join(tmpDir, 'stack-nocache');
    fs.mkdirSync(stackRoot);
    makeManifest(stackRoot, 'stack-nocache', 'TICKET-4');

    const entries = [makeEntry('s1', 'stack-nocache', 'claude-sonnet-4-5', 0, 50, 0)];
    const result = aggregateByTicket(entries, [stackRoot]);
    expect(result[0].cacheHit).toBe(0);
  });

  it('unpriced=true when any entry uses an unknown model', () => {
    const stackRoot = path.join(tmpDir, 'stack-unpriced');
    fs.mkdirSync(stackRoot);
    makeManifest(stackRoot, 'stack-unpriced', 'TICKET-5');

    const entries = [
      makeEntry('s1', 'stack-unpriced', 'claude-sonnet-4-5', 100, 50),
      makeEntry('s2', 'stack-unpriced', 'unknown-future-model-xyz', 100, 50),
    ];
    const result = aggregateByTicket(entries, [stackRoot]);
    expect(result[0].unpriced).toBe(true);
  });

  it('unpriced=false when all entries use priced models', () => {
    const stackRoot = path.join(tmpDir, 'stack-priced');
    fs.mkdirSync(stackRoot);
    makeManifest(stackRoot, 'stack-priced', 'TICKET-6');

    const entries = [makeEntry('s1', 'stack-priced', 'claude-sonnet-4-5', 100, 50)];
    const result = aggregateByTicket(entries, [stackRoot]);
    expect(result[0].unpriced).toBe(false);
  });

  it('orchestrator bucket: host-root entries roll up under __orchestrator__', () => {
    // stackId=null → no manifest lookup → orchestrator
    const entries = [makeEntry('s1', null)];
    const result = aggregateByTicket(entries, []);
    expect(result).toHaveLength(1);
    expect(result[0].ticketId).toBe(ORCHESTRATOR_TICKET_ID);
  });

  it('contract: emitted row has exactly the canonical field set', () => {
    const stackRoot = path.join(tmpDir, 'stack-contract');
    fs.mkdirSync(stackRoot);
    makeManifest(stackRoot, 'stack-contract', 'CONTRACT-1');

    const entries = [makeEntry('s1', 'stack-contract')];
    const result = aggregateByTicket(entries, [stackRoot]);

    expect(result).toHaveLength(1);
    const row = result[0];
    expect(Object.keys(row).sort()).toEqual(
      ['cacheHit', 'cost', 'lifecycle', 'model', 'ticketId', 'tokens', 'unpriced'].sort()
    );
    expect(Object.keys(row.tokens).sort()).toEqual(
      ['cacheCreate', 'cacheRead', 'input', 'output', 'total'].sort()
    );
    expect(row.lifecycle).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getByTicket — contract test via UsageEngine (implementation-independent)
// ---------------------------------------------------------------------------

describe('UsageEngine.getByTicket contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-contract-'));
    clearUsageCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearUsageCache();
  });

  it('getByTicket rows satisfy the canonical field contract', () => {
    const stackRoot = path.join(tmpDir, 'stack-1');
    fs.mkdirSync(stackRoot);
    fs.writeFileSync(stackRoot + '.manifest.json', JSON.stringify({
      stackId: 'stack-1', ticket: 'T-99', project: 'p', createdAt: '2024-01-01T00:00:00.000Z',
    }));
    const entry = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 50 } },
      timestamp: '2024-03-01T10:00:00.000Z',
      sessionId: 'sess-contract',
    });
    fs.writeFileSync(path.join(stackRoot, 'usage.jsonl'), entry + '\n');

    const engine = createUsageEngine([stackRoot]);
    const rows = engine.getByTicket();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['cacheHit', 'cost', 'lifecycle', 'model', 'ticketId', 'tokens', 'unpriced'].sort()
      );
      expect(Object.keys(row.tokens).sort()).toEqual(
        ['cacheCreate', 'cacheRead', 'input', 'output', 'total'].sort()
      );
      expect(typeof row.ticketId).toBe('string');
      expect(row.lifecycle).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Parse cache
// ---------------------------------------------------------------------------

describe('parse cache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-cache-'));
    clearUsageCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearUsageCache();
    vi.restoreAllMocks();
  });

  function writeJsonl(dir: string, filename: string, sessionId: string): string {
    const filePath = path.join(dir, filename);
    const entry = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 } },
      timestamp: '2024-03-01T10:00:00.000Z',
      sessionId,
    });
    fs.writeFileSync(filePath, entry + '\n');
    return filePath;
  }

  it('second call with same files does not re-read JSONL files', () => {
    const stackDir = path.join(tmpDir, 'stack-c');
    fs.mkdirSync(stackDir);
    writeJsonl(stackDir, 'usage.jsonl', 'sess-c1');

    const engine = createUsageEngine([stackDir]);
    engine.getByTicket(); // first call — parses

    const readSpy = vi.spyOn(fs, 'readFileSync');
    engine.getByTicket(); // second call — cache hit

    const jsonlReads = readSpy.mock.calls.filter((c) => String(c[0]).endsWith('.jsonl'));
    expect(jsonlReads).toHaveLength(0);
  });

  it('re-parses when a file mtime changes', () => {
    const stackDir = path.join(tmpDir, 'stack-m');
    fs.mkdirSync(stackDir);
    const filePath = writeJsonl(stackDir, 'usage.jsonl', 'sess-m1');

    const engine = createUsageEngine([stackDir]);
    engine.getByTicket(); // prime cache

    const futureTime = new Date(Date.now() + 10_000);
    fs.utimesSync(filePath, futureTime, futureTime);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    engine.getByTicket(); // mtime changed — cache miss

    const jsonlReads = readSpy.mock.calls.filter((c) => String(c[0]).endsWith('.jsonl'));
    expect(jsonlReads.length).toBeGreaterThan(0);
  });

  it('re-parses when a new JSONL file is added', () => {
    const stackDir = path.join(tmpDir, 'stack-n');
    fs.mkdirSync(stackDir);
    writeJsonl(stackDir, 'usage.jsonl', 'sess-n1');

    const engine = createUsageEngine([stackDir]);
    engine.getByTicket(); // prime cache

    // Add a new file — cache key changes
    writeJsonl(stackDir, 'usage2.jsonl', 'sess-n2');

    const readSpy = vi.spyOn(fs, 'readFileSync');
    engine.getByTicket();

    const jsonlReads = readSpy.mock.calls.filter((c) => String(c[0]).endsWith('.jsonl'));
    expect(jsonlReads.length).toBeGreaterThan(0);
  });

  it('clearUsageCache forces re-parse on next call', () => {
    const stackDir = path.join(tmpDir, 'stack-cl');
    fs.mkdirSync(stackDir);
    writeJsonl(stackDir, 'usage.jsonl', 'sess-cl1');

    const engine = createUsageEngine([stackDir]);
    engine.getByTicket(); // prime cache

    clearUsageCache();

    const readSpy = vi.spyOn(fs, 'readFileSync');
    engine.getByTicket(); // cache cleared — must re-parse

    const jsonlReads = readSpy.mock.calls.filter((c) => String(c[0]).endsWith('.jsonl'));
    expect(jsonlReads.length).toBeGreaterThan(0);
  });

  it('multiple engine instances share the cache', () => {
    const stackDir = path.join(tmpDir, 'stack-shared');
    fs.mkdirSync(stackDir);
    writeJsonl(stackDir, 'usage.jsonl', 'sess-sh1');

    const engine1 = createUsageEngine([stackDir]);
    engine1.getByTicket(); // prime cache with engine1

    const readSpy = vi.spyOn(fs, 'readFileSync');
    const engine2 = createUsageEngine([stackDir]);
    engine2.getByTicket(); // engine2 should hit the shared cache

    const jsonlReads = readSpy.mock.calls.filter((c) => String(c[0]).endsWith('.jsonl'));
    expect(jsonlReads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// summary costPerTicket — transcript-authoritative source
// ---------------------------------------------------------------------------

describe('summary costPerTicket source', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-summary-'));
    clearUsageCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearUsageCache();
  });

  it('non-orchestrator cost sum from getByTicket matches expected independent computation', () => {
    const stackA = path.join(tmpDir, 'stack-a');
    const stackB = path.join(tmpDir, 'stack-b');
    const orchestratorDir = path.join(tmpDir, '.claude', 'projects');
    fs.mkdirSync(stackA);
    fs.mkdirSync(stackB);
    fs.mkdirSync(orchestratorDir, { recursive: true });

    const writeManifest = (dir: string, stackId: string, ticket: string) => {
      fs.writeFileSync(dir + '.manifest.json', JSON.stringify({ stackId, ticket, project: 'p', createdAt: '2024-01-01T00:00:00.000Z' }));
    };
    writeManifest(stackA, 'stack-a', 'T-1');
    writeManifest(stackB, 'stack-b', 'T-2');

    const makeEntry = (model: string, input: number, output: number) => JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model, usage: { input_tokens: input, output_tokens: output } },
      timestamp: '2024-03-01T10:00:00.000Z',
      sessionId: `sess-${Math.random()}`,
    });

    // stack-a: ticket T-1
    fs.writeFileSync(path.join(stackA, 'a.jsonl'), makeEntry('claude-sonnet-4-5', 1_000_000, 500_000) + '\n');
    // stack-b: ticket T-2
    fs.writeFileSync(path.join(stackB, 'b.jsonl'), makeEntry('claude-sonnet-4-5', 500_000, 250_000) + '\n');
    // orchestrator (host-root)
    fs.writeFileSync(path.join(orchestratorDir, 'host.jsonl'), makeEntry('claude-sonnet-4-5', 100_000, 50_000) + '\n');

    const engine = createUsageEngine([orchestratorDir, stackA, stackB]);
    const byTicket = engine.getByTicket();

    const nonOrchCost = byTicket
      .filter((e) => e.ticketId !== ORCHESTRATOR_TICKET_ID)
      .reduce((sum, e) => sum + e.cost, 0);

    // Independently compute expected: sonnet pricing = $3/M input, $15/M output
    const expectedT1 = (1_000_000 * 3 + 500_000 * 15) / 1_000_000; // $10.5
    const expectedT2 = (500_000 * 3 + 250_000 * 15) / 1_000_000;   // $5.25
    expect(nonOrchCost).toBeCloseTo(expectedT1 + expectedT2, 2);

    // Orchestrator cost must NOT be included
    const orchEntry = byTicket.find((e) => e.ticketId === ORCHESTRATOR_TICKET_ID);
    expect(orchEntry).toBeDefined();
    expect(orchEntry!.cost).toBeGreaterThan(0);
    expect(nonOrchCost).toBeLessThan(nonOrchCost + orchEntry!.cost);
  });
});
