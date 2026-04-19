import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  TokenTelemetry,
  isTelemetryEnabled,
  type TokenTelemetryEvent,
} from '../../src/main/agent/token-telemetry';

/**
 * Pure-function tests for #262 tactic A (per-turn token telemetry). No
 * mocking — the module is deliberately electron-free so tests target a real
 * temp file.
 */
describe('TokenTelemetry (#262 tactic A)', () => {
  let tmpDir: string;
  let sinkPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-token-telemetry-'));
    sinkPath = path.join(tmpDir, 'telemetry.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function sampleEvent(partial: Partial<TokenTelemetryEvent> = {}): TokenTelemetryEvent {
    return {
      ts: '2026-04-18T00:00:00.000Z',
      tabId: 't-1',
      projectDir: '/proj',
      turn_index: 0,
      seconds_since_prev_turn: null,
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 30000,
      cache_read_input_tokens: 0,
      sub_turn_count: 1,
      tool_calls: [],
      ...partial,
    };
  }

  function readEvents(): TokenTelemetryEvent[] {
    if (!fs.existsSync(sinkPath)) return [];
    return fs
      .readFileSync(sinkPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TokenTelemetryEvent);
  }

  it('writes no file when disabled', () => {
    const tel = new TokenTelemetry({ filePath: sinkPath, enabled: false });
    tel.record(sampleEvent());
    tel.close();
    expect(fs.existsSync(sinkPath)).toBe(false);
    expect(tel.active).toBe(false);
  });

  it('writes one JSONL line per recorded event when enabled', () => {
    const tel = new TokenTelemetry({ filePath: sinkPath, enabled: true });
    expect(tel.active).toBe(true);
    tel.record(sampleEvent({ turn_index: 0 }));
    tel.record(sampleEvent({ turn_index: 1, seconds_since_prev_turn: 612 }));
    tel.record(sampleEvent({ turn_index: 2, seconds_since_prev_turn: 15 }));
    tel.close();

    const events = readEvents();
    expect(events).toHaveLength(3);
    expect(events[0].turn_index).toBe(0);
    expect(events[0].seconds_since_prev_turn).toBeNull();
    expect(events[1].turn_index).toBe(1);
    expect(events[1].seconds_since_prev_turn).toBe(612);
    expect(events[2].turn_index).toBe(2);
    expect(events[2].seconds_since_prev_turn).toBe(15);
  });

  it('preserves all token-accounting fields verbatim', () => {
    const tel = new TokenTelemetry({ filePath: sinkPath, enabled: true });
    tel.record(
      sampleEvent({
        input_tokens: 1234,
        output_tokens: 56,
        cache_creation_input_tokens: 28_000,
        cache_read_input_tokens: 2_000,
      })
    );
    tel.close();

    const [event] = readEvents();
    expect(event.input_tokens).toBe(1234);
    expect(event.output_tokens).toBe(56);
    expect(event.cache_creation_input_tokens).toBe(28_000);
    expect(event.cache_read_input_tokens).toBe(2_000);
  });

  it('round-trips sub_turn_count and tool_calls (#262 sub-turn instrumentation)', () => {
    const tel = new TokenTelemetry({ filePath: sinkPath, enabled: true });
    tel.record(
      sampleEvent({
        turn_index: 0,
        sub_turn_count: 5,
        tool_calls: [
          { name: 'list_stacks', tool_result_bytes: 512 },
          { name: 'get_task_status', tool_result_bytes: 180 },
          { name: 'get_diff', tool_result_bytes: 42_000 },
          { name: 'dispatch_task', tool_result_bytes: 120 },
        ],
      })
    );
    tel.close();

    const [event] = readEvents();
    expect(event.sub_turn_count).toBe(5);
    expect(event.tool_calls).toHaveLength(4);
    expect(event.tool_calls[2]).toEqual({
      name: 'get_diff',
      tool_result_bytes: 42_000,
    });
  });

  it('round-trips an empty tool_calls list and sub_turn_count=1 for a direct reply', () => {
    const tel = new TokenTelemetry({ filePath: sinkPath, enabled: true });
    tel.record(sampleEvent({ sub_turn_count: 1, tool_calls: [] }));
    tel.close();

    const [event] = readEvents();
    expect(event.sub_turn_count).toBe(1);
    expect(event.tool_calls).toEqual([]);
  });

  it('appends to an existing file rather than truncating', () => {
    fs.writeFileSync(sinkPath, JSON.stringify(sampleEvent({ turn_index: 99 })) + '\n', 'utf-8');
    const tel = new TokenTelemetry({ filePath: sinkPath, enabled: true });
    tel.record(sampleEvent({ turn_index: 0 }));
    tel.close();

    const events = readEvents();
    expect(events.length).toBe(2);
    expect(events[0].turn_index).toBe(99);
    expect(events[1].turn_index).toBe(0);
  });

  it('records the projectDir when set and omits it when undefined', () => {
    const tel = new TokenTelemetry({ filePath: sinkPath, enabled: true });
    tel.record(sampleEvent({ projectDir: '/abs/proj' }));
    tel.record(sampleEvent({ projectDir: undefined }));
    tel.close();

    const events = readEvents();
    expect(events[0].projectDir).toBe('/abs/proj');
    expect(events[1].projectDir).toBeUndefined();
  });

  it('record after close is a no-op (no crash, no write)', () => {
    const tel = new TokenTelemetry({ filePath: sinkPath, enabled: true });
    tel.record(sampleEvent({ turn_index: 0 }));
    tel.close();
    expect(tel.active).toBe(false);
    // This must not throw
    tel.record(sampleEvent({ turn_index: 1 }));

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].turn_index).toBe(0);
  });

  it('gracefully handles an unwritable file path by becoming inactive', () => {
    const unwritable = path.join(tmpDir, 'does-not-exist-dir', 'telemetry.jsonl');
    const tel = new TokenTelemetry({ filePath: unwritable, enabled: true });
    // First record fails internally (parent dir missing); must not throw
    expect(() => tel.record(sampleEvent())).not.toThrow();
    // After the first write-error the instance self-disables
    expect(tel.active).toBe(false);
    // Further records are also no-ops
    expect(() => tel.record(sampleEvent())).not.toThrow();
    expect(fs.existsSync(unwritable)).toBe(false);
    tel.close();
  });
});

describe('isTelemetryEnabled (#262 tactic A)', () => {
  it('returns true when the env var is exactly "1"', () => {
    expect(isTelemetryEnabled({ SANDSTORM_TOKEN_TELEMETRY: '1' })).toBe(true);
  });

  it('returns false when the env var is unset', () => {
    expect(isTelemetryEnabled({})).toBe(false);
  });

  it('returns false for truthy-looking but non-"1" values', () => {
    expect(isTelemetryEnabled({ SANDSTORM_TOKEN_TELEMETRY: 'true' })).toBe(false);
    expect(isTelemetryEnabled({ SANDSTORM_TOKEN_TELEMETRY: 'yes' })).toBe(false);
    expect(isTelemetryEnabled({ SANDSTORM_TOKEN_TELEMETRY: 'on' })).toBe(false);
    expect(isTelemetryEnabled({ SANDSTORM_TOKEN_TELEMETRY: '0' })).toBe(false);
    expect(isTelemetryEnabled({ SANDSTORM_TOKEN_TELEMETRY: '' })).toBe(false);
  });
});
