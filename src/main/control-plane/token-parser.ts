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

export interface PhaseTokenTotals {
  input_tokens: number;
  output_tokens: number;
}

export interface TokenStep {
  iteration: number;
  phase: string;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Parse phase token totals from a file written by token-counter.sh.
 * Each line is a JSON object: {"in":N,"out":N}
 * Returns the sum of all lines.
 */
export function parsePhaseTokenTotals(output: string): PhaseTokenTotals {
  let input_tokens = 0;
  let output_tokens = 0;

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      input_tokens += parsed.in ?? 0;
      output_tokens += parsed.out ?? 0;
    } catch {
      // Not JSON — skip
    }
  }

  return { input_tokens, output_tokens };
}

/**
 * Parse per-step token data from files written by token-counter.sh.
 * Each line may include iteration and phase metadata:
 *   {"in":N,"out":N,"iter":I,"phase":"P"}
 * Lines without metadata are treated as iteration 1 with the given default phase.
 *
 * Returns individual steps (one per API turn) grouped by iteration and phase.
 * Multiple API turns within the same iteration+phase are summed into one step.
 */
export function parsePhaseTokenSteps(
  executionOutput: string,
  reviewOutput: string
): TokenStep[] {
  const stepMap = new Map<string, TokenStep>();

  function processLines(output: string, defaultPhase: string): void {
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const iteration = parsed.iter ?? 1;
        const phase = parsed.phase ?? defaultPhase;
        const inTokens = parsed.in ?? 0;
        const outTokens = parsed.out ?? 0;

        if (inTokens === 0 && outTokens === 0) continue;

        const key = `${iteration}:${phase}`;
        const existing = stepMap.get(key);
        if (existing) {
          existing.input_tokens += inTokens;
          existing.output_tokens += outTokens;
        } else {
          stepMap.set(key, { iteration, phase, input_tokens: inTokens, output_tokens: outTokens });
        }
      } catch {
        // Not JSON — skip
      }
    }
  }

  processLines(executionOutput, 'execution');
  processLines(reviewOutput, 'review');

  // Sort by iteration then phase order (execution < review < verify)
  const phaseOrder: Record<string, number> = { execution: 0, review: 1, verify: 2 };
  return Array.from(stepMap.values()).sort((a, b) => {
    if (a.iteration !== b.iteration) return a.iteration - b.iteration;
    return (phaseOrder[a.phase] ?? 99) - (phaseOrder[b.phase] ?? 99);
  });
}

/**
 * Parse token usage from Claude CLI stream-json output.
 * Accumulates token usage across all API turns in a session.
 *
 * Each API call produces: message_start → content blocks → message_delta → result.
 * The `result.usage` contains the token count for that single turn.
 * We SUM all result messages to get the total for the entire session.
 *
 * For in-progress turns (message_start/delta seen but no result yet),
 * we track the partial counts separately and add them to the total.
 */
export function parseTokenUsage(output: string): ParsedTokenUsage {
  // Accumulated totals from completed turns (result messages)
  let resultInputTotal = 0;
  let resultOutputTotal = 0;

  // Partial counts from the current in-progress turn
  let currentTurnInput = 0;
  let currentTurnOutput = 0;

  let sessionId: string | null = null;
  let resolvedModel: string | null = null;

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);

      // result messages: accumulate across all turns
      if (parsed.type === 'result' && parsed.usage) {
        resultInputTotal += parsed.usage.input_tokens ?? 0;
        resultOutputTotal += parsed.usage.output_tokens ?? 0;
        // This result closes the current turn — reset partial tracking
        currentTurnInput = 0;
        currentTurnOutput = 0;
      }

      // Session ID appears on result messages
      if (parsed.session_id) {
        sessionId = parsed.session_id;
      }

      // Unwrap stream_event wrapper: Claude CLI emits
      // { "type": "stream_event", "event": { "type": "message_start", ... } }
      const event = parsed.type === 'stream_event' ? parsed.event : parsed;
      if (!event) continue;

      // message_start: track current (possibly incomplete) turn
      if (event.type === 'message_start' && event.message) {
        if (event.message.model && !resolvedModel) {
          resolvedModel = event.message.model;
        }
        if (event.message.usage) {
          const msgUsage = event.message.usage;
          if (msgUsage.input_tokens) {
            currentTurnInput = msgUsage.input_tokens;
          }
          // Reset output for this new turn
          currentTurnOutput = 0;
        }
      }

      // message_delta: track output for current turn
      if (event.type === 'message_delta' && event.usage) {
        if (event.usage.output_tokens) {
          currentTurnOutput = event.usage.output_tokens;
        }
      }
    } catch {
      // Not JSON — skip
    }
  }

  return {
    input_tokens: resultInputTotal + currentTurnInput,
    output_tokens: resultOutputTotal + currentTurnOutput,
    session_id: sessionId,
    resolved_model: resolvedModel,
  };
}

