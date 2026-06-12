/**
 * Integration tests for the model_args_for_phase bash helper.
 *
 * Sources sandstorm-cli/docker/phase-model-helper.sh and exercises
 * model_args_for_phase() via child_process, verifying that the correct
 * --model args are emitted for every documented edge case:
 *
 *   - Normal phase resolution (execution / review / meta_review)
 *   - 'auto' phase model → no --model flag
 *   - JSON absent → falls back to single task model
 *   - Phase key missing from JSON → falls back to single task model
 *   - Malformed JSON → treated as absent (fallback)
 *   - OpenCode provider/model (contains '/') → falls back + warning logged
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const HELPER_PATH = path.resolve(
  __dirname,
  '../../sandstorm-cli/docker/phase-model-helper.sh'
);

/** Run model_args_for_phase in an isolated bash sub-shell and return stdout. */
function runHelper(opts: {
  phase: string;
  phaseModelsJson?: string;
  taskModel?: string;
}): { stdout: string; stderr: string; exitCode: number } {
  const { phase, phaseModelsJson = '', taskModel = '' } = opts;

  // Inline script: source the helper, set up globals, call the function.
  const script = `
set -euo pipefail

# Stub log_loop so output is predictable
log_loop() { echo "[LOOP] \$1"; }

# Source helper under test
source "${HELPER_PATH}"

# Set globals used by model_args_for_phase
MODEL_ARGS=()
TASK_MODEL="${taskModel}"
if [ -n "${taskModel}" ]; then
  MODEL_ARGS=(--model "${taskModel}")
fi

PHASE_MODELS_JSON='${phaseModelsJson.replace(/'/g, "'\\''")}'

RESOLVED_MODEL_ARGS=()
model_args_for_phase "${phase}"

# Emit results in a parseable form
echo "RESOLVED_COUNT=\${#RESOLVED_MODEL_ARGS[@]}"
for arg in "\${RESOLVED_MODEL_ARGS[@]}"; do
  echo "ARG=\$arg"
done
`;

  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
}

/** Parse the bash output into an args array. */
function parseArgs(stdout: string): string[] {
  const args: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('ARG=')) args.push(line.slice(4));
  }
  return args;
}

describe('model_args_for_phase (shell helper)', () => {
  it('helper file exists', () => {
    expect(fs.existsSync(HELPER_PATH)).toBe(true);
  });

  it('resolves execution phase to --model flag', () => {
    const json = '{"execution":"sonnet","review":"opus","meta_review":"haiku"}';
    const { stdout, exitCode } = runHelper({ phase: 'execution', phaseModelsJson: json });
    expect(exitCode).toBe(0);
    expect(parseArgs(stdout)).toEqual(['--model', 'sonnet']);
  });

  it('resolves review phase to --model flag', () => {
    const json = '{"execution":"haiku","review":"opus","meta_review":"sonnet"}';
    const { stdout, exitCode } = runHelper({ phase: 'review', phaseModelsJson: json });
    expect(exitCode).toBe(0);
    expect(parseArgs(stdout)).toEqual(['--model', 'opus']);
  });

  it('resolves meta_review phase to --model flag', () => {
    const json = '{"execution":"haiku","review":"sonnet","meta_review":"opus"}';
    const { stdout, exitCode } = runHelper({ phase: 'meta_review', phaseModelsJson: json });
    expect(exitCode).toBe(0);
    expect(parseArgs(stdout)).toEqual(['--model', 'opus']);
  });

  it('auto phase model produces empty args (no --model flag)', () => {
    const json = '{"execution":"auto","review":"opus","meta_review":"sonnet"}';
    const { stdout, exitCode } = runHelper({ phase: 'execution', phaseModelsJson: json });
    expect(exitCode).toBe(0);
    expect(parseArgs(stdout)).toEqual([]);
    expect(stdout).toContain('[LOOP] phase=execution model=auto');
  });

  it('falls back to single task model when JSON is absent', () => {
    const { stdout, exitCode } = runHelper({
      phase: 'execution',
      phaseModelsJson: '',
      taskModel: 'opus',
    });
    expect(exitCode).toBe(0);
    expect(parseArgs(stdout)).toEqual(['--model', 'opus']);
    expect(stdout).toContain('task fallback');
  });

  it('falls back to single task model when phase key is missing', () => {
    const json = '{"review":"opus","meta_review":"sonnet"}';
    const { stdout, exitCode } = runHelper({
      phase: 'execution',
      phaseModelsJson: json,
      taskModel: 'haiku',
    });
    expect(exitCode).toBe(0);
    expect(parseArgs(stdout)).toEqual(['--model', 'haiku']);
    expect(stdout).toContain('task fallback');
  });

  it('falls back to single task model when JSON is malformed (tested at runner level)', () => {
    // Note: malformed JSON validation happens in task-runner.sh before calling
    // model_args_for_phase — at that point PHASE_MODELS_JSON is already cleared.
    // Passing malformed JSON directly to the helper results in jq returning empty,
    // which triggers the same fallback path as a missing phase key.
    const { stdout, exitCode } = runHelper({
      phase: 'execution',
      phaseModelsJson: 'not-valid-json',
      taskModel: 'sonnet',
    });
    expect(exitCode).toBe(0);
    expect(parseArgs(stdout)).toEqual(['--model', 'sonnet']);
    expect(stdout).toContain('task fallback');
  });

  it('falls back and logs warning when model contains / (OpenCode provider/model)', () => {
    const json = '{"execution":"openai/gpt-4o","review":"opus","meta_review":"sonnet"}';
    const { stdout, exitCode } = runHelper({
      phase: 'execution',
      phaseModelsJson: json,
      taskModel: 'sonnet',
    });
    expect(exitCode).toBe(0);
    expect(parseArgs(stdout)).toEqual(['--model', 'sonnet']);
    expect(stdout).toContain('WARNING');
    expect(stdout).toContain('openai/gpt-4o');
    expect(stdout).toContain('task fallback');
  });

  it('produces empty RESOLVED_MODEL_ARGS when task model is also absent', () => {
    // No JSON and no task model → MODEL_ARGS is empty → RESOLVED_MODEL_ARGS is empty
    const { stdout, exitCode } = runHelper({ phase: 'execution' });
    expect(exitCode).toBe(0);
    expect(parseArgs(stdout)).toEqual([]);
  });

  it('logs phase=<p> model=<m> for resolved phase', () => {
    const json = '{"execution":"haiku","review":"opus","meta_review":"sonnet"}';
    const { stdout } = runHelper({ phase: 'review', phaseModelsJson: json });
    expect(stdout).toContain('[LOOP] phase=review model=opus');
  });
});
