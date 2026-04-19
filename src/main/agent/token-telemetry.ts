/**
 * Per-turn token telemetry for the outer Claude orchestrator (#262 tactic A).
 *
 * Pure, electron-free module. Writes JSON Lines to a caller-supplied path so
 * tests can target a temp file without any mocking. The production wiring
 * lives in claude-backend.ts.
 *
 * Schema (one line per completed user-message cycle):
 *   {
 *     "ts": ISO-8601,
 *     "tabId": string,
 *     "projectDir": string | undefined,
 *     "turn_index": number (0-based within a session),
 *     "seconds_since_prev_turn": number | null (null on the first turn),
 *     "input_tokens": number,
 *     "output_tokens": number,
 *     "cache_creation_input_tokens": number,
 *     "cache_read_input_tokens": number,
 *     "sub_turn_count": number (count of type:"assistant" events = API calls in the tool-use chain),
 *     "tool_calls": [{ "name": string, "tool_result_bytes": number }]
 *   }
 *
 * Off by default. Opt in with the env var `SANDSTORM_TOKEN_TELEMETRY=1`.
 */

import { appendFileSync } from 'fs';

export interface ToolCallRecord {
  /** MCP tool name invoked by the model (e.g. "get_diff", "dispatch_task"). */
  name: string;
  /** UTF-8 byte length of the tool_result text returned to the model. */
  tool_result_bytes: number;
}

export interface TokenTelemetryEvent {
  ts: string;
  tabId: string;
  projectDir?: string;
  turn_index: number;
  seconds_since_prev_turn: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /**
   * Number of type:"assistant" events emitted by the CLI between the user
   * message being written to stdin and the type:"result" that produced this
   * telemetry line. Each assistant event corresponds to one API response, so
   * this is the sub-API-call count for a tool-use chain. `1` means "direct
   * reply, no tool use"; `>= 2` means the model ran tools.
   */
  sub_turn_count: number;
  /**
   * Ordered list of MCP tool calls made during this cycle. Each entry pairs
   * the tool name (captured from content_block_start) with the UTF-8 byte
   * length of the tool_result the bridge returned.
   */
  tool_calls: ToolCallRecord[];
}

export interface TokenTelemetryOptions {
  /** Absolute path to the JSONL sink. */
  filePath: string;
  /** When false, `record()` is a no-op. */
  enabled: boolean;
}

export class TokenTelemetry {
  private enabled: boolean;
  private readonly filePath: string;

  constructor(opts: TokenTelemetryOptions) {
    this.enabled = opts.enabled;
    this.filePath = opts.filePath;
  }

  /** True when telemetry is accepting records (not disabled, not marked dead). */
  get active(): boolean {
    return this.enabled;
  }

  record(event: TokenTelemetryEvent): void {
    if (!this.enabled) return;
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + '\n');
    } catch {
      // Best effort — if the sink becomes unwritable, disable rather than
      // letting telemetry failures break the orchestrator.
      this.enabled = false;
    }
  }

  /** Stop accepting further records. Subsequent `record()` calls are no-ops. */
  close(): void {
    this.enabled = false;
  }
}

/**
 * Read the telemetry opt-in flag from an environment bag. Default off — the
 * flag must be explicitly set to `1` to enable. Any other value (including
 * `true`, `yes`, etc.) is ignored to keep the contract precise.
 */
export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SANDSTORM_TOKEN_TELEMETRY === '1';
}
