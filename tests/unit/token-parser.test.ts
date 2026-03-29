import { describe, it, expect } from 'vitest';
import { parseTokenUsage, parsePhaseTokenTotals } from '../../src/main/control-plane/token-parser';

describe('parseTokenUsage', () => {
  it('returns zeros for empty input', () => {
    const result = parseTokenUsage('');
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.session_id).toBeNull();
  });

  it('returns zeros for non-JSON input', () => {
    const result = parseTokenUsage('Hello world\nNot JSON\n');
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
  });

  it('parses result-type message with usage', () => {
    const output = [
      '{"type":"content_block_delta","delta":{"text":"Hello"}}',
      '{"type":"result","usage":{"input_tokens":1500,"output_tokens":800},"session_id":"sess-123"}',
    ].join('\n');

    const result = parseTokenUsage(output);
    expect(result.input_tokens).toBe(1500);
    expect(result.output_tokens).toBe(800);
    expect(result.session_id).toBe('sess-123');
  });

  it('parses message_start with input tokens (bare)', () => {
    const output = '{"type":"message_start","message":{"usage":{"input_tokens":2000}}}\n';
    const result = parseTokenUsage(output);
    expect(result.input_tokens).toBe(2000);
  });

  it('parses message_delta with output tokens (bare)', () => {
    const output = '{"type":"message_delta","usage":{"output_tokens":500}}\n';
    const result = parseTokenUsage(output);
    expect(result.output_tokens).toBe(500);
  });

  it('parses stream_event wrapped message_start', () => {
    const output = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 10783,
            cache_read_input_tokens: 8537,
            output_tokens: 1,
          },
        },
      },
    }) + '\n';
    const result = parseTokenUsage(output);
    expect(result.input_tokens).toBe(2);
  });

  it('parses stream_event wrapped message_delta', () => {
    const output = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        usage: { input_tokens: 2, output_tokens: 10 },
      },
    }) + '\n';
    const result = parseTokenUsage(output);
    expect(result.output_tokens).toBe(10);
  });

  it('parses full stream-json output with stream_event wrappers', () => {
    const lines = [
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: 10783,
              cache_read_input_tokens: 8537,
              output_tokens: 1,
            },
          },
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { text: 'Hello' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { input_tokens: 2, output_tokens: 10 },
        },
      }),
      JSON.stringify({
        type: 'result',
        total_cost_usd: 0.07192225,
        usage: { input_tokens: 2, output_tokens: 10 },
        session_id: 'sess-full',
      }),
    ].join('\n');

    const result = parseTokenUsage(lines);
    expect(result.input_tokens).toBe(2);
    expect(result.output_tokens).toBe(10);
    expect(result.session_id).toBe('sess-full');
  });

  it('accumulates result usage across multiple turns', () => {
    const output = [
      '{"type":"result","usage":{"input_tokens":100,"output_tokens":50},"session_id":"s1"}',
      '{"type":"result","usage":{"input_tokens":200,"output_tokens":150},"session_id":"s2"}',
    ].join('\n');

    const result = parseTokenUsage(output);
    expect(result.input_tokens).toBe(300);
    expect(result.output_tokens).toBe(200);
    expect(result.session_id).toBe('s2');
  });

  it('handles mixed JSON and non-JSON lines', () => {
    const output = [
      'Some plain text log line',
      '{"type":"result","usage":{"input_tokens":500,"output_tokens":300},"session_id":"abc"}',
      'Another plain line',
    ].join('\n');

    const result = parseTokenUsage(output);
    expect(result.input_tokens).toBe(500);
    expect(result.output_tokens).toBe(300);
    expect(result.session_id).toBe('abc');
  });

  it('extracts session_id from non-result messages too', () => {
    const output = '{"type":"assistant","session_id":"sess-456"}\n';
    const result = parseTokenUsage(output);
    expect(result.session_id).toBe('sess-456');
  });

  it('accumulates across many result messages (multi-turn session)', () => {
    const output = [
      '{"type":"result","usage":{"input_tokens":1000,"output_tokens":500},"session_id":"s1"}',
      '{"type":"result","usage":{"input_tokens":800,"output_tokens":300},"session_id":"s1"}',
      '{"type":"result","usage":{"input_tokens":1200,"output_tokens":600},"session_id":"s1"}',
    ].join('\n');

    const result = parseTokenUsage(output);
    expect(result.input_tokens).toBe(3000);
    expect(result.output_tokens).toBe(1400);
  });

  it('includes in-progress turn tokens when no result yet', () => {
    // Simulates polling mid-task: one completed turn + one in-progress
    const output = [
      '{"type":"result","usage":{"input_tokens":500,"output_tokens":200}}',
      '{"type":"message_start","message":{"usage":{"input_tokens":300}}}',
      '{"type":"message_delta","usage":{"output_tokens":100}}',
    ].join('\n');

    const result = parseTokenUsage(output);
    // 500 from result + 300 from in-progress message_start
    expect(result.input_tokens).toBe(800);
    // 200 from result + 100 from in-progress message_delta
    expect(result.output_tokens).toBe(300);
  });

  it('resets in-progress counters when result arrives', () => {
    // message_start/delta followed by result should not double-count
    const output = [
      '{"type":"message_start","message":{"usage":{"input_tokens":400}}}',
      '{"type":"message_delta","usage":{"output_tokens":150}}',
      '{"type":"result","usage":{"input_tokens":400,"output_tokens":150}}',
    ].join('\n');

    const result = parseTokenUsage(output);
    // Only result counts, in-progress reset to 0
    expect(result.input_tokens).toBe(400);
    expect(result.output_tokens).toBe(150);
  });

  it('monotonically increases as log grows (simulates periodic polling)', () => {
    // First poll: one result
    const poll1 = '{"type":"result","usage":{"input_tokens":500,"output_tokens":200}}';
    const r1 = parseTokenUsage(poll1);

    // Second poll: same result + new in-progress turn
    const poll2 = [
      '{"type":"result","usage":{"input_tokens":500,"output_tokens":200}}',
      '{"type":"message_start","message":{"usage":{"input_tokens":300}}}',
    ].join('\n');
    const r2 = parseTokenUsage(poll2);

    // Third poll: two completed results
    const poll3 = [
      '{"type":"result","usage":{"input_tokens":500,"output_tokens":200}}',
      '{"type":"result","usage":{"input_tokens":300,"output_tokens":100}}',
    ].join('\n');
    const r3 = parseTokenUsage(poll3);

    // Tokens should monotonically increase
    expect(r2.input_tokens).toBeGreaterThanOrEqual(r1.input_tokens);
    expect(r3.input_tokens).toBeGreaterThanOrEqual(r2.input_tokens);
    expect(r3.output_tokens).toBeGreaterThanOrEqual(r1.output_tokens);
  });

  it('returns null resolved_model for empty input', () => {
    const result = parseTokenUsage('');
    expect(result.resolved_model).toBeNull();
  });

  it('extracts resolved_model from bare message_start', () => {
    const output = '{"type":"message_start","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":100}}}\n';
    const result = parseTokenUsage(output);
    expect(result.resolved_model).toBe('claude-sonnet-4-20250514');
    expect(result.input_tokens).toBe(100);
  });

  it('extracts resolved_model from stream_event wrapped message_start', () => {
    const output = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-opus-4-20250514',
          usage: { input_tokens: 50 },
        },
      },
    }) + '\n';
    const result = parseTokenUsage(output);
    expect(result.resolved_model).toBe('claude-opus-4-20250514');
  });

  it('uses first model seen when multiple message_start events exist', () => {
    const lines = [
      JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 10 } },
      }),
      JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-opus-4-20250514', usage: { input_tokens: 20 } },
      }),
    ].join('\n');
    const result = parseTokenUsage(lines);
    expect(result.resolved_model).toBe('claude-sonnet-4-20250514');
  });

  it('returns null resolved_model when message_start has no model field', () => {
    const output = '{"type":"message_start","message":{"usage":{"input_tokens":100}}}\n';
    const result = parseTokenUsage(output);
    expect(result.resolved_model).toBeNull();
    expect(result.input_tokens).toBe(100);
  });
});

describe('parsePhaseTokenTotals', () => {
  it('returns zeros for empty input', () => {
    const result = parsePhaseTokenTotals('');
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
  });

  it('returns zeros for non-JSON input', () => {
    const result = parsePhaseTokenTotals('not json\nstill not json\n');
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
  });

  it('parses a single token line', () => {
    const result = parsePhaseTokenTotals('{"in":1500,"out":800}\n');
    expect(result.input_tokens).toBe(1500);
    expect(result.output_tokens).toBe(800);
  });

  it('sums multiple token lines', () => {
    const output = [
      '{"in":1000,"out":500}',
      '{"in":2000,"out":1000}',
      '{"in":500,"out":200}',
    ].join('\n');

    const result = parsePhaseTokenTotals(output);
    expect(result.input_tokens).toBe(3500);
    expect(result.output_tokens).toBe(1700);
  });

  it('handles mixed valid and invalid lines', () => {
    const output = [
      '{"in":1000,"out":500}',
      'not json',
      '{"in":2000,"out":1000}',
    ].join('\n');

    const result = parsePhaseTokenTotals(output);
    expect(result.input_tokens).toBe(3000);
    expect(result.output_tokens).toBe(1500);
  });

  it('handles missing fields with defaults', () => {
    const result = parsePhaseTokenTotals('{"in":1000}\n');
    expect(result.input_tokens).toBe(1000);
    expect(result.output_tokens).toBe(0);
  });

  it('handles empty lines gracefully', () => {
    const output = '{"in":500,"out":200}\n\n\n{"in":300,"out":100}\n';
    const result = parsePhaseTokenTotals(output);
    expect(result.input_tokens).toBe(800);
    expect(result.output_tokens).toBe(300);
  });
});
