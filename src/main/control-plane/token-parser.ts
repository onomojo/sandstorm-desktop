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
  resolved_model: string | null;
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
  let resolvedModel: string | null = null;

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

      // message_start contains input token count and model
      if (event.type === 'message_start' && event.message) {
        if (event.message.model && !resolvedModel) {
          resolvedModel = event.message.model;
        }
        if (event.message.usage) {
          const msgUsage = event.message.usage;
          if (msgUsage.input_tokens) {
            inputTokens = msgUsage.input_tokens;
          }
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

  return { input_tokens: inputTokens, output_tokens: outputTokens, session_id: sessionId, resolved_model: resolvedModel };
}

