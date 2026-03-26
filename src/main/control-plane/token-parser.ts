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

      // Also check nested message usage (message_start events)
      if (parsed.type === 'message_start' && parsed.message?.usage) {
        // message_start contains input token count
        const msgUsage = parsed.message.usage;
        if (msgUsage.input_tokens) {
          inputTokens = msgUsage.input_tokens;
        }
      }

      // message_delta contains output token count at end of message
      if (parsed.type === 'message_delta' && parsed.usage) {
        if (parsed.usage.output_tokens) {
          outputTokens = parsed.usage.output_tokens;
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
 */
export function parseRateLimit(output: string): ParsedRateLimit | null {
  // Common rate limit patterns from Claude CLI / API
  const rateLimitPatterns = [
    /rate.?limit/i,
    /usage.?limit/i,
    /too many requests/i,
    /(?:HTTP|status|code)\s*429/i,
    /exceeded.*(?:token|request|daily|hourly).*(?:limit|quota)/i,
    /billing.*limit/i,
    /capacity.*exceeded/i,
  ];

  const isRateLimited = rateLimitPatterns.some((pattern) => pattern.test(output));
  if (!isRateLimited) return null;

  // Try to extract reset time
  const resetAt = parseResetTime(output);

  return {
    reset_at: resetAt,
    reason: extractRateLimitReason(output),
  };
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
