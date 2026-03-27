import { describe, it, expect } from 'vitest';
import { parseTokenUsage, parseRateLimit, parseHttpError } from '../../src/main/control-plane/token-parser';

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

describe('parseHttpError', () => {
  // --- No error cases ---

  it('returns null for empty input', () => {
    expect(parseHttpError('')).toBeNull();
  });

  it('returns null for normal output', () => {
    expect(parseHttpError('Task completed successfully')).toBeNull();
    expect(parseHttpError('{"type":"result","usage":{"input_tokens":100}}')).toBeNull();
  });

  it('returns null for content events that discuss errors', () => {
    // Inner Claude discussing rate limits in its output should NOT trigger detection
    const streamOutput = [
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'The rate limit detection needs to be fixed' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'We should handle HTTP 429 errors properly' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'retry after 300 seconds when rate limited' } } }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 50 }, session_id: 'sess-1' }),
    ].join('\n');
    expect(parseHttpError(streamOutput)).toBeNull();
  });

  it('returns null for message_start/message_delta events', () => {
    const output = [
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 100 } } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 50 } }),
    ].join('\n');
    expect(parseHttpError(output)).toBeNull();
  });

  it('returns null for unrelated numbers like "input_tokens: 429"', () => {
    // JSON result with 429 as a token count should not trigger
    const output = '{"type":"result","usage":{"input_tokens":429,"output_tokens":50}}';
    expect(parseHttpError(output)).toBeNull();
  });

  // --- Rate limit (429) detection ---

  it('detects rate_limit_error type in error event', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit');
    expect(result!.status_code).toBe(429);
    expect(result!.reason).toBe('Rate limit exceeded');
  });

  it('detects rate limit in stream_event wrapped error', () => {
    const output = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Too many requests. Retry after 60 seconds' },
      },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit');
    expect(result!.reset_at).toBeTruthy();
  });

  it('detects rate limit in result with error', () => {
    const output = JSON.stringify({
      type: 'result',
      error: { type: 'rate_limit_error', message: 'rate limit exceeded' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit');
  });

  it('detects rate limit by status_code field', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'error', status_code: 429, message: 'Too many requests' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit');
    expect(result!.status_code).toBe(429);
  });

  it('detects rate limit from top-level error object', () => {
    const output = JSON.stringify({
      error: { type: 'rate_limit_error', message: 'You have exceeded your daily token limit' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit');
    expect(result!.reason).toBe('You have exceeded your daily token limit');
  });

  it('extracts ISO timestamp reset time for rate limits', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit. Resets at 2026-03-26T15:30:00Z' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.reset_at).toBe('2026-03-26T15:30:00.000Z');
  });

  it('extracts retry-after seconds for rate limits', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit hit. Retry after 300 seconds' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    const resetTime = new Date(result!.reset_at!).getTime();
    const expected = Date.now() + 300 * 1000;
    expect(Math.abs(resetTime - expected)).toBeLessThan(5000);
  });

  it('extracts retry-after minutes for rate limits', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit. Retry after 5 minutes' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    const resetTime = new Date(result!.reset_at!).getTime();
    const expected = Date.now() + 5 * 60 * 1000;
    expect(Math.abs(resetTime - expected)).toBeLessThan(5000);
  });

  it('extracts "resets in" duration', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded. Resets in 30 minutes' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    const resetTime = new Date(result!.reset_at!).getTime();
    const expected = Date.now() + 30 * 60 * 1000;
    expect(Math.abs(resetTime - expected)).toBeLessThan(5000);
  });

  it('returns null reset_at when no time can be parsed from rate limit', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.reset_at).toBeNull();
  });

  // --- Authentication (401) detection ---

  it('detects authentication_error type', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid API key' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('auth_required');
    expect(result!.status_code).toBe(401);
    expect(result!.reason).toBe('Invalid API key');
    expect(result!.reset_at).toBeNull(); // Auth errors don't have reset times
  });

  it('detects 401 by status_code field', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'error', status_code: 401, message: 'Unauthorized' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('auth_required');
    expect(result!.status_code).toBe(401);
  });

  // --- Server error (500) detection ---

  it('detects api_error type as server_error', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: 'Internal server error' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('server_error');
    expect(result!.status_code).toBe(500);
    expect(result!.reason).toBe('Internal server error');
  });

  it('detects 500 by status_code field', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'error', status_code: 500, message: 'Server error' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('server_error');
    expect(result!.status_code).toBe(500);
  });

  // --- Overloaded (529) detection ---

  it('detects overloaded_error type', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'The API is temporarily overloaded' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('overloaded');
    expect(result!.status_code).toBe(529);
    expect(result!.reason).toBe('The API is temporarily overloaded');
  });

  it('detects 529 by status_code field', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'error', status_code: 529, message: 'Overloaded' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('overloaded');
    expect(result!.status_code).toBe(529);
  });

  // --- Plain text stderr fallback ---

  it('detects 429 from plain-text stderr', () => {
    const result = parseHttpError('HTTP/1.1 429 Too Many Requests');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit');
    expect(result!.status_code).toBe(429);
  });

  it('detects 401 from plain-text stderr', () => {
    const result = parseHttpError('Error: 401 Unauthorized');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('auth_required');
    expect(result!.status_code).toBe(401);
  });

  it('detects 500 from plain-text stderr', () => {
    const result = parseHttpError('Error: 500 Internal Server Error');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('server_error');
    expect(result!.status_code).toBe(500);
  });

  it('detects 529 from plain-text stderr', () => {
    const result = parseHttpError('Error: 529 Overloaded');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('overloaded');
    expect(result!.status_code).toBe(529);
  });

  // --- Edge cases ---

  it('truncates very long reasons', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit ' + 'x'.repeat(300) },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.reason.length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it('handles error with http_status field', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'error', http_status: 429, message: 'Rate limited' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit');
    expect(result!.status_code).toBe(429);
  });

  it('classifies by status code in error message as last resort', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'unknown_error', message: 'Got HTTP 429 from upstream' },
    });
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit');
  });

  it('returns first error found when multiple errors present', () => {
    const output = [
      JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }),
      JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Server error' } }),
    ].join('\n');
    const result = parseHttpError(output);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit'); // First error wins
  });
});

describe('parseRateLimit (backwards compatibility)', () => {
  it('returns null for normal output', () => {
    expect(parseRateLimit('Task completed successfully')).toBeNull();
    expect(parseRateLimit('{"type":"result","usage":{"input_tokens":100}}')).toBeNull();
  });

  it('detects rate limit from structured error event', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded. Retry after 60 seconds' },
    });
    const result = parseRateLimit(output);
    expect(result).not.toBeNull();
    expect(result!.reset_at).toBeTruthy();
    expect(result!.reason).toContain('Rate limit');
  });

  it('returns null for non-rate-limit errors (401, 500, 529)', () => {
    expect(parseRateLimit(JSON.stringify({
      type: 'error', error: { type: 'authentication_error', message: 'Invalid key' },
    }))).toBeNull();

    expect(parseRateLimit(JSON.stringify({
      type: 'error', error: { type: 'api_error', message: 'Server error' },
    }))).toBeNull();

    expect(parseRateLimit(JSON.stringify({
      type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' },
    }))).toBeNull();
  });

  it('does not false-positive on agent conversation content', () => {
    const streamOutput = [
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'The rate limit detection needs to be fixed' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'We should handle HTTP 429 errors properly' } } }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 50 }, session_id: 'sess-1' }),
    ].join('\n');
    expect(parseRateLimit(streamOutput)).toBeNull();
  });

  it('extracts reason from JSON error', () => {
    const output = JSON.stringify({
      error: { type: 'rate_limit_error', message: 'You have exceeded your daily token limit' },
    });
    const result = parseRateLimit(output);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('You have exceeded your daily token limit');
  });

  it('extracts ISO timestamp from resets-at', () => {
    const output = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit. Resets at 2026-03-26T15:30:00Z' },
    });
    const result = parseRateLimit(output);
    expect(result).not.toBeNull();
    expect(result!.reset_at).toBe('2026-03-26T15:30:00.000Z');
  });
});
