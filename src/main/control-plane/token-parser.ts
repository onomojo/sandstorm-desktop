/**
 * Parses token usage and rate limit information from Claude CLI stream-json output.
 *
 * The Claude CLI with `--output-format stream-json` emits JSON lines including:
 * - `{ "type": "result", "result": { ... }, "session_id": "...", "usage": { "input_tokens": N, "output_tokens": N } }`
 * - Rate limit errors in stderr or result messages
 */

export interface ParsedTokenUsage {
  input_tokens: number;
  output_tokens: number;
  session_id: string | null;
}

export interface ParsedRateLimit {
  reset_at: string | null;  // ISO timestamp
  reason: string;
}

/**
 * Parse token usage from Claude CLI stream-json output.
 * Scans all lines for usage data and accumulates totals.
 * Returns the last session_id seen.
 */
export function parseTokenUsage(output: string): ParsedTokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId: string | null = null;

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);

      // The final "result" message contains cumulative usage for the turn
      if (parsed.type === 'result' && parsed.usage) {
        inputTokens = parsed.usage.input_tokens ?? inputTokens;
        outputTokens = parsed.usage.output_tokens ?? outputTokens;
      }

      // Session ID appears on result messages
      if (parsed.session_id) {
        sessionId = parsed.session_id;
      }

      // Unwrap stream_event wrapper: Claude CLI emits
      // { "type": "stream_event", "event": { "type": "message_start", ... } }
      const event = parsed.type === 'stream_event' ? parsed.event : parsed;
      if (!event) continue;

      // message_start contains input token count
      if (event.type === 'message_start' && event.message?.usage) {
        const msgUsage = event.message.usage;
        if (msgUsage.input_tokens) {
          inputTokens = msgUsage.input_tokens;
        }
      }

      // message_delta contains output token count at end of message
      if (event.type === 'message_delta' && event.usage) {
        if (event.usage.output_tokens) {
          outputTokens = event.usage.output_tokens;
        }
      }
    } catch {
      // Not JSON — skip
    }
  }

  return { input_tokens: inputTokens, output_tokens: outputTokens, session_id: sessionId };
}

/**
 * Detect rate limit errors from Claude CLI output (stdout + stderr).
 * Returns null if no rate limit detected.
 *
 * IMPORTANT: Only checks error/system lines — NOT conversation content.
 * The raw log contains everything the inner Claude writes, so matching
 * patterns like "rate limit" against the full text causes false positives
 * when the agent discusses rate limiting in its own output.
 */
export function parseRateLimit(output: string): ParsedRateLimit | null {
  const rateLimitPatterns = [
    /rate.?limit/i,
    /usage.?limit/i,
    /too many requests/i,
    /(?:HTTP|status|code)\s*429/i,
    /exceeded.*(?:token|request|daily|hourly).*(?:limit|quota)/i,
    /billing.*limit/i,
    /capacity.*exceeded/i,
  ];

  // Extract only error-relevant lines, skipping conversation content.
  // In stream-json, content_block_delta events carry the agent's text output —
  // these must be excluded to avoid false positives.
  const errorLines = extractErrorLines(output);
  if (errorLines.length === 0) return null;

  const errorText = errorLines.join('\n');
  const isRateLimited = rateLimitPatterns.some((pattern) => pattern.test(errorText));
  if (!isRateLimited) return null;

  const resetAt = parseResetTime(errorText);

  return {
    reset_at: resetAt,
    reason: extractRateLimitReason(errorText),
  };
}

/**
 * Extract only error-relevant lines from Claude CLI output.
 * Skips content_block_delta (agent text), content_block_start,
 * and other content-carrying events.
 */
function extractErrorLines(output: string): string[] {
  const errorLines: string[] = [];
  // Content event types whose text should be ignored
  const contentTypes = new Set([
    'content_block_delta',
    'content_block_start',
    'content_block_stop',
    'message_start',
    'message_delta',
    'message_stop',
  ]);

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);

      // Skip content events (agent conversation text)
      const eventType = parsed.type === 'stream_event'
        ? parsed.event?.type
        : parsed.type;
      if (eventType && contentTypes.has(eventType)) continue;

      // Include error objects and result messages (which may contain error info)
      if (parsed.error || parsed.type === 'error' || parsed.type === 'result') {
        errorLines.push(trimmed);
      }
    } catch {
      // Non-JSON line (plain text from stderr) — always include
      errorLines.push(trimmed);
    }
  }

  return errorLines;
}

/**
 * Try to extract the rate limit reset time from error output.
 */
function parseResetTime(output: string): string | null {
  // Pattern: "resets at <ISO timestamp>" or "retry after <seconds>"
  const isoMatch = output.match(/resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
  if (isoMatch) {
    const ts = isoMatch[1].endsWith('Z') ? isoMatch[1] : isoMatch[1] + 'Z';
    return new Date(ts).toISOString();
  }

  // Pattern: "retry after <N> seconds/minutes/hours"
  const retryMatch = output.match(/retry\s+(?:after\s+)?(\d+)\s*(seconds?|minutes?|hours?|s|m|h)/i);
  if (retryMatch) {
    const value = parseInt(retryMatch[1], 10);
    const unit = retryMatch[2].toLowerCase();
    let ms = value * 1000;
    if (unit.startsWith('m')) ms = value * 60 * 1000;
    if (unit.startsWith('h')) ms = value * 3600 * 1000;
    return new Date(Date.now() + ms).toISOString();
  }

  // Pattern: "in <N> minutes/hours"
  const inMatch = output.match(/(?:resets?|available)\s+in\s+(\d+)\s*(seconds?|minutes?|hours?|s|m|h)/i);
  if (inMatch) {
    const value = parseInt(inMatch[1], 10);
    const unit = inMatch[2].toLowerCase();
    let ms = value * 1000;
    if (unit.startsWith('m')) ms = value * 60 * 1000;
    if (unit.startsWith('h')) ms = value * 3600 * 1000;
    return new Date(Date.now() + ms).toISOString();
  }

  // No recognizable time pattern — return null; callers should apply their own default
  return null;
}

/**
 * Extract a human-readable rate limit reason from the output.
 */
function extractRateLimitReason(output: string): string {
  // Try to find the most relevant error line
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for JSON error messages
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.error?.message) return parsed.error.message;
      if (parsed.message && typeof parsed.message === 'string') return parsed.message;
    } catch {
      // Not JSON
    }

    // Check for plain-text rate limit messages
    if (/rate.?limit|usage.?limit|too many|429|exceeded|billing|capacity/i.test(trimmed)) {
      return trimmed.length > 200 ? trimmed.substring(0, 200) + '...' : trimmed;
    }
  }

  return 'Rate limit exceeded';
}
