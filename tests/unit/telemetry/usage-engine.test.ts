import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { parseJSONLFile, findJSONLFiles, parseTranscriptRoot } from '../../../src/main/telemetry/parser';
import { computeCost } from '../../../src/main/telemetry/pricing';
import {
  aggregateSummary,
  aggregateDaily,
  aggregateByModel,
  aggregateSessions,
} from '../../../src/main/telemetry/aggregator';
import { createUsageEngine } from '../../../src/main/telemetry/usage-engine';

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
    const engine = createUsageEngine('/nonexistent/path');
    const summary = engine.getSummary({ since: '2024-01-01', until: '2024-12-31' });
    expect(summary.tokens.total).toBe(0);
    expect(summary.sessions).toBe(0);
    expect(summary.ticketsShipped).toBeNull();
    expect(summary.costPerTicket).toBeNull();
  });

  it('returns empty arrays for daily/byModel/session when root does not exist', () => {
    const engine = createUsageEngine('/nonexistent/path');
    const range = { since: '2024-01-01', until: '2024-12-31' };
    expect(engine.getDaily(range)).toHaveLength(0);
    expect(engine.getByModel(range)).toHaveLength(0);
    expect(engine.getSessions(range)).toHaveLength(0);
  });

  it('reads from fixture directory end-to-end', () => {
    const engine = createUsageEngine(FIXTURES);
    const range = { since: '2024-01-01', until: '2024-12-31' };
    const summary = engine.getSummary(range);
    expect(summary.sessions).toBeGreaterThan(0);
    expect(summary.tokens.input).toBeGreaterThan(0);
  });
});
