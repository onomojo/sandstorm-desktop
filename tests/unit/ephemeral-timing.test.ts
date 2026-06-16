import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  appendEphemeralTiming,
  type EphemeralTimingRecord,
} from '../../src/main/agent/ephemeral-timing';

describe('appendEphemeralTiming', () => {
  let tmpDir: string;
  let sinkPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-ephemeral-timing-'));
    sinkPath = path.join(tmpDir, 'timing.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readRecords(): EphemeralTimingRecord[] {
    if (!fs.existsSync(sinkPath)) return [];
    return fs
      .readFileSync(sinkPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EphemeralTimingRecord);
  }

  function sampleRecord(partial: Partial<EphemeralTimingRecord> = {}): EphemeralTimingRecord {
    const now = Date.now();
    return {
      ts: new Date(now).toISOString(),
      spawnedAt: now - 5000,
      firstChunkAt: now - 2000,
      closedAt: now,
      elapsedMs: 5000,
      exitCode: 0,
      promptChars: 1234,
      turnCount: 3,
      tokens: 1500,
      cancelled: false,
      ...partial,
    };
  }

  it('creates the file on first write and appends a valid JSON line', () => {
    expect(fs.existsSync(sinkPath)).toBe(false);
    appendEphemeralTiming(sinkPath, sampleRecord());
    expect(fs.existsSync(sinkPath)).toBe(true);
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0].promptChars).toBe(1234);
    expect(records[0].turnCount).toBe(3);
    expect(records[0].cancelled).toBe(false);
  });

  it('appends multiple records as separate JSONL lines', () => {
    appendEphemeralTiming(sinkPath, sampleRecord({ turnCount: 1 }));
    appendEphemeralTiming(sinkPath, sampleRecord({ turnCount: 2 }));
    appendEphemeralTiming(sinkPath, sampleRecord({ turnCount: 5 }));
    const records = readRecords();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.turnCount)).toEqual([1, 2, 5]);
  });

  it('writes firstChunkAt as null when no chunks were received', () => {
    appendEphemeralTiming(sinkPath, sampleRecord({ firstChunkAt: null }));
    const records = readRecords();
    expect(records[0].firstChunkAt).toBeNull();
  });

  it('includes cancelled flag correctly', () => {
    appendEphemeralTiming(sinkPath, sampleRecord({ cancelled: true, exitCode: null }));
    const records = readRecords();
    expect(records[0].cancelled).toBe(true);
    expect(records[0].exitCode).toBeNull();
  });

  it('includes errorMessage when provided', () => {
    appendEphemeralTiming(sinkPath, sampleRecord({ errorMessage: 'spawn ENOENT' }));
    const records = readRecords();
    expect(records[0].errorMessage).toBe('spawn ENOENT');
  });

  it('omits errorMessage key when not provided', () => {
    appendEphemeralTiming(sinkPath, sampleRecord());
    const records = readRecords();
    expect('errorMessage' in records[0]).toBe(false);
  });

  it('round-trips the tokens field correctly', () => {
    appendEphemeralTiming(sinkPath, sampleRecord({ tokens: 4200 }));
    const records = readRecords();
    expect(records[0].tokens).toBe(4200);
  });

  it('swallows write errors silently', () => {
    expect(() => appendEphemeralTiming('/no/such/dir/timing.jsonl', sampleRecord())).not.toThrow();
  });

  it('writes all required fields', () => {
    const rec = sampleRecord();
    appendEphemeralTiming(sinkPath, rec);
    const records = readRecords();
    const r = records[0];
    expect(typeof r.ts).toBe('string');
    expect(typeof r.spawnedAt).toBe('number');
    expect(typeof r.closedAt).toBe('number');
    expect(typeof r.elapsedMs).toBe('number');
    expect(typeof r.promptChars).toBe('number');
    expect(typeof r.turnCount).toBe('number');
    expect(typeof r.tokens).toBe('number');
    expect(typeof r.cancelled).toBe('boolean');
  });
});
