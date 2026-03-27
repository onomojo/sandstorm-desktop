/**
 * Parses token usage and HTTP error information from Claude CLI stream-json output.
 *
 * The Claude CLI with `--output-format stream-json` emits JSON lines including:
 * - `{ "type": "result", "result": { ... }, "session_id": "...", "usage": { "input_tokens": N, "output_tokens": N } }`
 * - Structured error events with HTTP status codes (429, 401, 500, 529)
 */

export interface ParsedTokenUsage {
  input_tokens: number;
  output_tokens: number;
  session_id: string | null;
}

export type HttpErrorType = 'rate_limit' | 'auth_required' | 'server_error' | 'overloaded';

export interface ParsedHttpError {
  type: HttpErrorType;
  status_code: number;
  reset_at: string | null;  // ISO timestamp (for rate limits)
  reason: string;
}

/** Kept for backwards compatibility — maps to the rate_limit case of ParsedHttpError */
export interface ParsedRateLimit {
  reset_at: string | null;
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
 * Detect HTTP errors from Claude CLI stream-json output by parsing structured
 * error events. Returns null if no error detected.
 *
 * Looks for structured error objects in the stream-json output that contain
 * HTTP status codes or error type identifiers. This approach is immune to
 * false positives from agent conversation content because it only inspects
 * parsed error event fields, never free-text content.
 *
 * Detected error types:
 * - 429 / rate_limit_error → rate_limit
 * - 401 / authentication_error → auth_required
 * - 500 / api_error → server_error
 * - 529 / overloaded_error → overloaded
 */
export function parseHttpError(output: string): ParsedHttpError | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);
      const error = extractErrorObject(parsed);
      if (!error) continue;

      const classification = classifyError(error);
      if (!classification) continue;

      const reason = error.message
        || error.error_message
        || classification.defaultReason;
      const truncatedReason = reason.length > 200 ? reason.substring(0, 200) + '...' : reason;

      return {
        type: classification.type,
        status_code: classification.statusCode,
        reset_at: classification.type === 'rate_limit' ? parseResetTime(trimmed) : null,
        reason: truncatedReason,
      };
    } catch {
      // Non-JSON line — check for plain-text HTTP status patterns from stderr
      const statusMatch = trimmed.match(/\b(401|429|500|529)\b/);
      if (statusMatch) {
        const code = parseInt(statusMatch[1], 10);
        const classification = classifyStatusCode(code);
        if (classification) {
          return {
            type: classification.type,
            status_code: code,
            reset_at: classification.type === 'rate_limit' ? parseResetTime(trimmed) : null,
            reason: trimmed.length > 200 ? trimmed.substring(0, 200) + '...' : trimmed,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Backwards-compatible wrapper: returns ParsedRateLimit for 429 errors only.
 * Used by existing code that only cares about rate limits.
 */
export function parseRateLimit(output: string): ParsedRateLimit | null {
  const error = parseHttpError(output);
  if (!error || error.type !== 'rate_limit') return null;
  return { reset_at: error.reset_at, reason: error.reason };
}

// --- Internal helpers ---

interface ErrorFields {
  type?: string;
  message?: string;
  error_message?: string;
  status_code?: number;
  http_status?: number;
}

interface Classification {
  type: HttpErrorType;
  statusCode: number;
  defaultReason: string;
}

/**
 * Extract the error object from a parsed JSON line, handling various
 * envelope formats (stream_event wrapper, top-level error, result with error).
 */
function extractErrorObject(parsed: Record<string, unknown>): ErrorFields | null {
  // Direct error event: { "type": "error", "error": { ... } }
  if (parsed.type === 'error' && parsed.error && typeof parsed.error === 'object') {
    return parsed.error as ErrorFields;
  }

  // stream_event wrapper: { "type": "stream_event", "event": { "type": "error", "error": { ... } } }
  if (parsed.type === 'stream_event' && parsed.event && typeof parsed.event === 'object') {
    const event = parsed.event as Record<string, unknown>;
    if (event.type === 'error' && event.error && typeof event.error === 'object') {
      return event.error as ErrorFields;
    }
  }

  // Result with error: { "type": "result", "error": { ... } }
  if (parsed.type === 'result' && parsed.error && typeof parsed.error === 'object') {
    return parsed.error as ErrorFields;
  }

  // Top-level error fields (e.g. { "error": { "type": "rate_limit_error", ... } })
  if (parsed.error && typeof parsed.error === 'object' && !parsed.type) {
    return parsed.error as ErrorFields;
  }

  return null;
}

/**
 * Classify an error by its type string and/or status code.
 */
function classifyError(error: ErrorFields): Classification | null {
  const errorType = error.type?.toLowerCase() ?? '';
  const statusCode = error.status_code ?? error.http_status;

  // Classify by error type string first (most reliable)
  if (errorType.includes('rate_limit') || errorType === 'rate_limit_error') {
    return { type: 'rate_limit', statusCode: statusCode ?? 429, defaultReason: 'Rate limit exceeded' };
  }
  if (errorType.includes('authentication') || errorType === 'authentication_error') {
    return { type: 'auth_required', statusCode: statusCode ?? 401, defaultReason: 'Authentication required' };
  }
  if (errorType.includes('overloaded') || errorType === 'overloaded_error') {
    return { type: 'overloaded', statusCode: statusCode ?? 529, defaultReason: 'API overloaded' };
  }
  if (errorType.includes('api_error') || errorType === 'api_error') {
    return { type: 'server_error', statusCode: statusCode ?? 500, defaultReason: 'Server error' };
  }

  // Fall back to status code classification
  if (statusCode) {
    return classifyStatusCode(statusCode);
  }

  // Check error message for status code mentions as last resort
  const message = error.message ?? error.error_message ?? '';
  const msgStatusMatch = message.match(/\b(401|429|500|529)\b/);
  if (msgStatusMatch) {
    return classifyStatusCode(parseInt(msgStatusMatch[1], 10));
  }

  return null;
}

function classifyStatusCode(code: number): Classification | null {
  switch (code) {
    case 429: return { type: 'rate_limit', statusCode: 429, defaultReason: 'Rate limit exceeded' };
    case 401: return { type: 'auth_required', statusCode: 401, defaultReason: 'Authentication required' };
    case 500: return { type: 'server_error', statusCode: 500, defaultReason: 'Server error' };
    case 529: return { type: 'overloaded', statusCode: 529, defaultReason: 'API overloaded' };
    default: return null;
  }
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
