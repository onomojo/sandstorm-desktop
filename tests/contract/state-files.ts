/**
 * Exhaustive state-file contract for the Sandstorm task-runner.
 *
 * Every /tmp/claude-* and /tmp/sandstorm-* file exchanged by task-runner.sh
 * and stack.sh is enumerated here with its producer, consumer, format, and
 * lifecycle metadata.
 *
 * This artifact is the single source of truth for the IPC contract between
 * the host (stack.sh) and the container (task-runner.sh / inner Claude).
 *
 * Dynamic files (numbered suffixes) use a base pattern plus a suffixRange.
 * The actual path for iteration N is:  `${pattern.replace('{N}', N)}`
 *
 * T0-reachable files can be tested without invoking the task-runner main
 * loop.  They are either:
 *   - Written by stack.sh before dispatch (input files), or
 *   - Written by helper functions sourced from the pre-loop section of
 *     task-runner.sh (check_for_stop_and_ask, check_for_token_limit, etc.)
 *
 * T3 covers loop- and verify-written files (marked t0Reachable: false).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileProducer =
  | 'stack.sh'      // host-side dispatch script
  | 'task-runner'   // sandstorm-cli/docker/task-runner.sh
  | 'inner-agent'   // Claude / OpenCode running inside the container
  | 'entrypoint'    // container entrypoint.sh (pre-task-runner setup)

export type FileConsumer =
  | 'task-runner'   // task-runner.sh main loop or helpers
  | 'stack.sh'      // host reads status/output files
  | 'monitor'       // Sandstorm Desktop / external monitors (IPC)
  | 'check-fn'      // helper functions sourced from task-runner.sh

export type FileFormat =
  | 'trigger'       // presence matters; content is ignored (empty or arbitrary)
  | 'text'          // plain UTF-8 text, single value or human-readable prose
  | 'json'          // single valid JSON document
  | 'ndjson'        // newline-delimited JSON (one JSON object per line)
  | 'kvlines'       // key=value lines (e.g. execution_started_at=...)
  | 'numeric'       // bare integer string
  | 'status'        // one of a defined set of status token strings

export type WhenWritten =
  | 'pre-task'      // written by stack.sh before the trigger is set
  | 'task-start'    // written by task-runner at the very start of processing a task
  | 'execution'     // written during the initial execution agent pass
  | 'review'        // written during the review agent pass
  | 'meta-review'   // written during the meta-review agent pass
  | 'verify'        // written during the verify step
  | 'task-end'      // written just before task-runner marks the task complete
  | 'idle'          // written when task-runner is waiting for a trigger
  | 'per-iteration' // written once per loop iteration (numbered suffix)

export interface StateFile {
  /**
   * Exact path (for static files) or glob-like pattern with {N} for dynamic
   * indexed files (e.g. '/tmp/claude-review-verdict-{N}.txt').
   */
  pattern: string

  /** Human-readable description of this file's purpose. */
  description: string

  /** Which process writes this file. */
  producer: FileProducer | FileProducer[]

  /**
   * Which process(es) read this file.
   * 'monitor' means it is polled by Sandstorm Desktop via IPC.
   */
  consumer: FileConsumer | FileConsumer[]

  /** Content format of this file. */
  format: FileFormat

  /** When in the task lifecycle is this file written. */
  whenWritten: WhenWritten

  /**
   * True when this file is only written in some scenarios (e.g. only when
   * a model override is provided, or only on token-limit events).
   */
  conditional: boolean

  /**
   * For files with a numeric suffix {N}, the inclusive range of valid N.
   * Absent for static-path files.
   */
  suffixRange?: { min: number; max: number }

  /**
   * For status files: the exhaustive set of valid values.
   * Absent for non-status files.
   */
  statusValues?: readonly string[]

  /**
   * True if this file can be tested without invoking the task-runner main
   * loop (i.e. it is written by stack.sh or by a pre-loop helper function).
   */
  t0Reachable: boolean
}

// ---------------------------------------------------------------------------
// Schema — all state files
// ---------------------------------------------------------------------------

export const STATE_FILES: readonly StateFile[] = [

  // ── Stack.sh → task-runner input files ───────────────────────────────────

  {
    pattern: '/tmp/claude-task-trigger',
    description:
      'Presence of this file triggers the task-runner to start a new task. ' +
      'Written by "touch" in stack.sh; deleted by task-runner at task start.',
    producer: 'stack.sh',
    consumer: 'task-runner',
    format: 'trigger',
    whenWritten: 'pre-task',
    conditional: false,
    t0Reachable: true,
  },

  {
    pattern: '/tmp/claude-task-prompt.txt',
    description:
      'Full task prompt text piped into the execution agent. ' +
      'Written by stack.sh; read and deleted by task-runner after dispatch.',
    producer: 'stack.sh',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'pre-task',
    conditional: false,
    t0Reachable: true,
  },

  {
    pattern: '/tmp/claude-task-label.txt',
    description:
      'One-liner label (first 80 chars of prompt) for display in dashboards. ' +
      'Written by stack.sh; consumed by external monitors, not by task-runner.sh itself.',
    producer: 'stack.sh',
    consumer: 'monitor',
    format: 'text',
    whenWritten: 'pre-task',
    conditional: false,
    t0Reachable: true,
  },

  {
    pattern: '/tmp/claude-task-model.txt',
    description:
      'Optional Claude model override (e.g. "claude-opus-4-8"). ' +
      'Written only when --model is passed to stack.sh; deleted after read.',
    producer: 'stack.sh',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'pre-task',
    conditional: true,
    t0Reachable: true,
  },

  {
    pattern: '/tmp/claude-task-models.json',
    description:
      'Optional per-phase model map JSON ({"execution":"...", "review":"..."}). ' +
      'Written only when --models-json is passed to stack.sh; deleted after read.',
    producer: 'stack.sh',
    consumer: 'task-runner',
    format: 'json',
    whenWritten: 'pre-task',
    conditional: true,
    t0Reachable: true,
  },

  {
    pattern: '/tmp/claude-task-resume.txt',
    description:
      'Optional Claude session ID to resume. ' +
      'Written only when --resume is passed to stack.sh; deleted after read.',
    producer: 'stack.sh',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'pre-task',
    conditional: true,
    t0Reachable: true,
  },

  {
    pattern: '/tmp/claude-task-backend.txt',
    description:
      'Optional agent backend selector ("claude" or "opencode"). ' +
      'Written only when --backend is passed to stack.sh; deleted after read.',
    producer: 'stack.sh',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'pre-task',
    conditional: true,
    t0Reachable: true,
  },

  {
    pattern: '/tmp/claude-task-backend-model.txt',
    description:
      'Optional OpenCode provider/model string. ' +
      'Written only when --backend-model is passed to stack.sh; deleted after read.',
    producer: 'stack.sh',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'pre-task',
    conditional: true,
    t0Reachable: true,
  },

  {
    pattern: '/tmp/claude-task-phase-routing.json',
    description:
      'Optional per-phase backend+provider+model routing JSON. ' +
      'Supersedes --backend/--backend-model when present. ' +
      'Written only when --phase-routing-json is passed to stack.sh; deleted after read.',
    producer: 'stack.sh',
    consumer: 'task-runner',
    format: 'json',
    whenWritten: 'pre-task',
    conditional: true,
    t0Reachable: true,
  },

  // ── Task-runner readiness / status files ─────────────────────────────────

  {
    pattern: '/tmp/claude-ready',
    description:
      'Contains the string "ready" when task-runner is idle and waiting for a ' +
      'trigger. Removed at task start, restored on task completion or error.',
    producer: 'task-runner',
    consumer: ['stack.sh', 'monitor'],
    format: 'text',
    whenWritten: 'idle',
    conditional: false,
    statusValues: ['ready'],
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-task.pid',
    description:
      'PID of the task-runner process ($$) written at task start, removed at task end.',
    producer: 'task-runner',
    consumer: ['stack.sh', 'monitor'],
    format: 'numeric',
    whenWritten: 'task-start',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-task.status',
    description:
      'Current task status token. Updated at each lifecycle transition.',
    producer: 'task-runner',
    consumer: ['stack.sh', 'monitor'],
    format: 'status',
    whenWritten: 'task-start',
    conditional: false,
    statusValues: [
      'running',
      'completed',
      'failed',
      'token_limited',
      'needs_human',
      'needs_key',
      'verify_blocked_environmental',
    ],
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-task.exit',
    description:
      'Numeric exit code of the last agent invocation. Written at task end.',
    producer: 'task-runner',
    consumer: ['stack.sh', 'monitor'],
    format: 'numeric',
    whenWritten: 'task-end',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-task.review-iterations',
    description:
      'Running count of total review iterations completed (0 at start, ' +
      'incremented each time a review agent runs).',
    producer: 'task-runner',
    consumer: 'monitor',
    format: 'numeric',
    whenWritten: 'task-start',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-task.verify-retries',
    description:
      'Running count of consecutive verify failures (0 at start, ' +
      'incremented each time verify fails).',
    producer: 'task-runner',
    consumer: 'monitor',
    format: 'numeric',
    whenWritten: 'task-start',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-task-needs-key.txt',
    description:
      'Human-readable message explaining which phase/provider is missing credentials. ' +
      'Written only when a phase credential check fails (needs_key status).',
    producer: 'task-runner',
    consumer: 'monitor',
    format: 'text',
    whenWritten: 'task-start',
    conditional: true,
    t0Reachable: false,
  },

  // ── Execution agent artifacts ─────────────────────────────────────────────

  {
    pattern: '/tmp/claude-raw.log',
    description:
      'Raw NDJSON stream-json output from the execution agent (claude or opencode). ' +
      'Truncated to empty at each task start. Appended during each execution pass.',
    producer: 'task-runner',
    consumer: ['task-runner', 'monitor'],
    format: 'ndjson',
    whenWritten: 'execution',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-task.log',
    description:
      'Formatted (human-readable) output of the execution agent, produced by the ' +
      'jq filter in run_claude. This is what task-output reads.',
    producer: 'task-runner',
    consumer: ['task-runner', 'monitor'],
    format: 'text',
    whenWritten: 'execution',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-tokens-execution',
    description:
      'Cumulative token count for the execution phase (input+output tokens). ' +
      'Written by the token-counter.sh subprocess during run_claude.',
    producer: 'task-runner',
    consumer: 'monitor',
    format: 'numeric',
    whenWritten: 'execution',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-execute-output-{N}.txt',
    description:
      'Outcome marker for execution pass N. ' +
      'First line is EXECUTE_PASS or EXECUTE_FAIL; subsequent lines are the ' +
      'last 50 lines of claude-task.log for that pass. ' +
      'N=0 is the initial execution; N=1..MAX_TOTAL_REVIEW_ITERATIONS are ' +
      'subsequent fix passes (one per review cycle).',
    producer: 'task-runner',
    consumer: 'monitor',
    format: 'text',
    whenWritten: 'per-iteration',
    conditional: false,
    suffixRange: { min: 0, max: 5 },
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-execution-summary.txt',
    description:
      'Snapshot of the last 50 lines of claude-task.log after the initial ' +
      'execution pass.  Used by the meta-review agent to understand what the ' +
      'execution agent did.',
    producer: 'task-runner',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'execution',
    conditional: false,
    t0Reachable: false,
  },

  // ── Phase timing ──────────────────────────────────────────────────────────

  {
    pattern: '/tmp/claude-phase-timing.txt',
    description:
      'ISO 8601 timestamps for each phase boundary, appended progressively. ' +
      'Keys: execution_started_at, execution_finished_at, review_started_at, ' +
      'review_finished_at, verify_started_at, verify_finished_at.',
    producer: 'task-runner',
    consumer: 'monitor',
    format: 'kvlines',
    whenWritten: 'task-start',
    conditional: false,
    t0Reachable: false,
  },

  // ── Review agent artifacts ────────────────────────────────────────────────

  {
    pattern: '/tmp/claude-review-raw.log',
    description:
      'Raw NDJSON stream-json output from the review agent. ' +
      'Overwritten each time a review agent runs.',
    producer: 'task-runner',
    consumer: 'task-runner',
    format: 'ndjson',
    whenWritten: 'review',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-review-task.log',
    description:
      'Formatted (human-readable) output of the review agent. ' +
      'Overwritten each time a review agent runs.',
    producer: 'task-runner',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'review',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-review-prompt.txt',
    description:
      'Temporary file holding the assembled review prompt (template + original task). ' +
      'Created by run_review, deleted immediately after the review agent completes.',
    producer: 'task-runner',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'review',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-review-output.txt',
    description:
      'Copy of claude-review-task.log captured when the review agent returns ' +
      'REVIEW_FAIL or crashes. Used as context for the next execution pass.',
    producer: 'task-runner',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'review',
    conditional: true,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-review-verdict-{N}.txt',
    description:
      'Review verdict for iteration N. ' +
      'Contains "REVIEW_PASS" on pass, or the full review output on fail. ' +
      'N starts at 1 and increments each review cycle up to MAX_TOTAL_REVIEW_ITERATIONS=5.',
    producer: 'task-runner',
    consumer: ['task-runner', 'monitor'],
    format: 'text',
    whenWritten: 'per-iteration',
    conditional: false,
    suffixRange: { min: 1, max: 5 },
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-tokens-review',
    description:
      'Cumulative token count for the review phase. ' +
      'Written by the token-counter.sh subprocess during review agent runs.',
    producer: 'task-runner',
    consumer: 'monitor',
    format: 'numeric',
    whenWritten: 'review',
    conditional: false,
    t0Reachable: false,
  },

  // ── Meta-review agent artifacts ───────────────────────────────────────────

  {
    pattern: '/tmp/claude-meta-review-prompt.txt',
    description:
      'Temporary prompt file for the meta-review agent. ' +
      'Deleted immediately after the meta-review agent completes.',
    producer: 'task-runner',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'meta-review',
    conditional: true,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-meta-review-task.log',
    description:
      'Formatted output of the meta-review agent. ' +
      'Deleted at final task status (copied to claude-meta-review.txt first).',
    producer: 'task-runner',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'meta-review',
    conditional: true,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-meta-review-raw.log',
    description:
      'Raw NDJSON stream from the meta-review agent. ' +
      'Deleted at final task status.',
    producer: 'task-runner',
    consumer: 'task-runner',
    format: 'ndjson',
    whenWritten: 'meta-review',
    conditional: true,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-meta-review.txt',
    description:
      'Persisted copy of the meta-review agent output (guidance prose). ' +
      'Injected into the next execution-agent prompt via inject_meta_review_guidance().',
    producer: 'task-runner',
    consumer: 'task-runner',
    format: 'text',
    whenWritten: 'meta-review',
    conditional: true,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-tokens-meta_review',
    description:
      'Cumulative token count for the meta_review phase. ' +
      'Written by the token-counter.sh subprocess during meta-review agent runs.',
    producer: 'task-runner',
    consumer: 'monitor',
    format: 'numeric',
    whenWritten: 'meta-review',
    conditional: true,
    t0Reachable: false,
  },

  // ── Verify artifacts ──────────────────────────────────────────────────────

  {
    pattern: '/tmp/claude-verify.log',
    description:
      'Complete output of .sandstorm/verify.sh for the most recent verify run. ' +
      'Overwritten on each verify attempt.',
    producer: 'task-runner',
    consumer: ['task-runner', 'monitor'],
    format: 'text',
    whenWritten: 'verify',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-verify-output-{N}.txt',
    description:
      'Numbered verify outcome for outer iteration N. ' +
      'First line is VERIFY_PASS, VERIFY_FAIL, or VERIFY_INFRA; ' +
      'subsequent lines are the last 50 lines of verify output.',
    producer: 'task-runner',
    consumer: 'monitor',
    format: 'text',
    whenWritten: 'per-iteration',
    conditional: false,
    suffixRange: { min: 1, max: 5 },
    t0Reachable: false,
  },

  {
    pattern: '/tmp/claude-verify-environmental.txt',
    description:
      'Written when verify_blocked_environmental is set. ' +
      'Contains a "VERIFY_FAIL_FINGERPRINT: <line>" identifying the ' +
      'infra error that caused the environmental block.',
    producer: 'task-runner',
    consumer: ['stack.sh', 'monitor'],
    format: 'text',
    whenWritten: 'verify',
    conditional: true,
    t0Reachable: false,
  },

  // ── STOP_AND_ASK artifacts ────────────────────────────────────────────────

  {
    pattern: '/tmp/claude-stop-reason.txt',
    description:
      'Reason string extracted from the STOP_AND_ASK: line in the agent output. ' +
      'Written by check_for_stop_and_ask() (a pre-loop helper function).',
    producer: 'task-runner',
    consumer: ['stack.sh', 'monitor'],
    format: 'text',
    whenWritten: 'execution',
    conditional: true,
    t0Reachable: true,
  },

  {
    pattern: '/tmp/claude-stop-questions.json',
    description:
      'Structured JSON array of RefineQuestion objects written by the inner agent ' +
      'to /tmp/claude-stop-questions.json before emitting STOP_AND_ASK. ' +
      'Read by check_for_stop_and_ask() and forwarded to the loop log.',
    producer: 'inner-agent',
    consumer: ['task-runner', 'monitor'],
    format: 'json',
    whenWritten: 'execution',
    conditional: true,
    t0Reachable: true,
  },

  // ── Runtime config files (written by entrypoint / setup) ─────────────────

  {
    pattern: '/tmp/sandstorm-mcp.json',
    description:
      'MCP server configuration passed to claude via --mcp-config. ' +
      'Written by the container entrypoint before task-runner starts.',
    producer: 'entrypoint',
    consumer: 'task-runner',
    format: 'json',
    whenWritten: 'pre-task',
    conditional: false,
    t0Reachable: false,
  },

  {
    pattern: '/tmp/sandstorm-opencode-{provider}.json',
    description:
      'OpenCode provider credentials/config for a specific provider. ' +
      'The {provider} suffix is a provider name (e.g. "anthropic", "openai"). ' +
      'Written by the container entrypoint; checked for presence by ' +
      'check_all_phase_credentials().',
    producer: 'entrypoint',
    consumer: 'task-runner',
    format: 'json',
    whenWritten: 'pre-task',
    conditional: true,
    t0Reachable: false,
  },
]

// ---------------------------------------------------------------------------
// Convenience views
// ---------------------------------------------------------------------------

/** All files that can be tested without invoking the main loop. */
export const T0_REACHABLE = STATE_FILES.filter((f) => f.t0Reachable)

/** All files written (or pre-written) by stack.sh — the host-side inputs. */
export const STACK_INPUT_FILES = STATE_FILES.filter(
  (f) => f.producer === 'stack.sh',
)

/** All files with a dynamic numeric suffix {N}. */
export const DYNAMIC_FILES = STATE_FILES.filter((f) => f.suffixRange != null)

/** All possible status token values for claude-task.status. */
export const TASK_STATUS_VALUES: readonly string[] = STATE_FILES.find(
  (f) => f.pattern === '/tmp/claude-task.status',
)!.statusValues!
