import { describe, it, expect } from 'vitest';
import { parseTokenUsage, parseRateLimit } from '../../src/main/control-plane/token-parser';

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

  it('takes the last result usage (cumulative)', () => {
    const output = [
      '{"type":"result","usage":{"input_tokens":100,"output_tokens":50},"session_id":"s1"}',
      '{"type":"result","usage":{"input_tokens":200,"output_tokens":150},"session_id":"s2"}',
    ].join('\n');

    const result = parseTokenUsage(output);
    expect(result.input_tokens).toBe(200);
    expect(result.output_tokens).toBe(150);
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
});

describe('parseRateLimit', () => {
  it('returns null for normal output', () => {
    expect(parseRateLimit('Task completed successfully')).toBeNull();
    expect(parseRateLimit('{"type":"result","usage":{"input_tokens":100}}')).toBeNull();
  });

  it('detects rate limit keywords', () => {
    expect(parseRateLimit('Error: rate limit exceeded')).not.toBeNull();
    expect(parseRateLimit('Error: too many requests')).not.toBeNull();
    expect(parseRateLimit('HTTP 429 Too Many Requests')).not.toBeNull();
    expect(parseRateLimit('status 429 returned')).not.toBeNull();
    expect(parseRateLimit('Usage limit exceeded for today')).not.toBeNull();
    expect(parseRateLimit('billing limit reached')).not.toBeNull();
  });

  it('does not false-positive on bare 429 in unrelated content', () => {
    expect(parseRateLimit('input_tokens: 429')).toBeNull();
    expect(parseRateLimit('line 429: some code')).toBeNull();
  });

  it('does not false-positive on rate limit keywords in agent conversation content', () => {
    // Inner Claude discussing rate limits in its output should NOT trigger detection
    const streamOutput = [
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'The rate limit detection needs to be fixed' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'We should handle HTTP 429 errors properly' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'retry after 300 seconds when rate limited' } } }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 50 }, session_id: 'sess-1' }),
    ].join('\n');
    expect(parseRateLimit(streamOutput)).toBeNull();
  });

  it('does not false-positive on rate limit keywords in message_start events', () => {
    const output = [
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 100 } } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 50 } }),
    ].join('\n');
    expect(parseRateLimit(output)).toBeNull();
  });

  it('detects rate limit in error-typed JSON lines', () => {
    const output = [
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'working...' } } }),
      JSON.stringify({ type: 'error', error: { message: 'Rate limit exceeded. Retry after 60 seconds' } }),
    ].join('\n');
    const result = parseRateLimit(output);
    expect(result).not.toBeNull();
    expect(result!.reset_at).toBeTruthy();
  });

  it('detects rate limit in result-typed JSON with error info', () => {
    const output = JSON.stringify({ type: 'result', error: { message: 'rate limit exceeded' } });
    const result = parseRateLimit(output);
    expect(result).not.toBeNull();
  });

  it('extracts retry-after seconds', () => {
    const result = parseRateLimit('Rate limit hit. Retry after 300 seconds');
    expect(result).not.toBeNull();
    expect(result!.reset_at).toBeTruthy();

    const resetTime = new Date(result!.reset_at!).getTime();
    const expected = Date.now() + 300 * 1000;
    // Allow 5 second tolerance
    expect(Math.abs(resetTime - expected)).toBeLessThan(5000);
  });

  it('extracts retry-after minutes', () => {
    const result = parseRateLimit('Rate limit. Retry after 5 minutes');
    expect(result).not.toBeNull();

    const resetTime = new Date(result!.reset_at!).getTime();
    const expected = Date.now() + 5 * 60 * 1000;
    expect(Math.abs(resetTime - expected)).toBeLessThan(5000);
  });

  it('extracts ISO timestamp from resets-at', () => {
    const result = parseRateLimit('Rate limit. Resets at 2026-03-26T15:30:00Z');
    expect(result).not.toBeNull();
    expect(result!.reset_at).toBe('2026-03-26T15:30:00.000Z');
  });

  it('extracts "resets in" duration', () => {
    const result = parseRateLimit('Rate limit exceeded. Resets in 30 minutes');
    expect(result).not.toBeNull();

    const resetTime = new Date(result!.reset_at!).getTime();
    const expected = Date.now() + 30 * 60 * 1000;
    expect(Math.abs(resetTime - expected)).toBeLessThan(5000);
  });

  it('returns null reset_at when no time can be parsed', () => {
    const result = parseRateLimit('rate limit exceeded');
    expect(result).not.toBeNull();
    expect(result!.reset_at).toBeNull();
  });

  it('extracts reason from JSON error', () => {
    const output = '{"error":{"message":"You have exceeded your daily token limit"}}';
    const result = parseRateLimit(output);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('You have exceeded your daily token limit');
  });

  it('extracts reason from plain text', () => {
    const result = parseRateLimit('Error: Rate limit exceeded for this organization');
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('Rate limit');
  });

  it('truncates very long reasons', () => {
    const longMsg = 'Rate limit ' + 'x'.repeat(300);
    const result = parseRateLimit(longMsg);
    expect(result).not.toBeNull();
    expect(result!.reason.length).toBeLessThanOrEqual(203); // 200 + "..."
  });
});
