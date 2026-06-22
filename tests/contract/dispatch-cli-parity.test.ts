/**
 * Contract test: deliverTask must produce the same state files as the
 * `sandstorm task` CLI command (stack.sh task subcommand).
 *
 * The single source of truth for which files are written is STATE_FILES in
 * state-files.ts.  This test verifies that deliverTask writes exactly the set
 * of non-conditional files always, and each conditional file iff the
 * corresponding input is present — matching the CLI's behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LocalRuntime } from '../../src/main/runtime/local';
import { bringUp, deliverTask } from '../../src/main/control-plane/dispatch';
import { STATE_FILES } from './state-files';

const PROJECT_DIR = '/tmp/sandstorm-parity-test';

// Only the pre-task input files produced by stack.sh
const STACK_SH_INPUT_FILES = STATE_FILES.filter(
  (f) => f.producer === 'stack.sh' && f.t0Reachable
);
const REQUIRED_FILES = STACK_SH_INPUT_FILES.filter((f) => !f.conditional);
const CONDITIONAL_FILES = STACK_SH_INPUT_FILES.filter((f) => f.conditional);

function fileBasename(pattern: string): string {
  return path.basename(pattern);
}

describe('dispatch-cli-parity: deliverTask matches stack.sh task subcommand', () => {
  let runtime: LocalRuntime;
  let containerId: string;
  let tmpdir: string;

  beforeEach(async () => {
    runtime = new LocalRuntime();
    await bringUp(runtime, PROJECT_DIR, {
      projectName: 'sandstorm-parity-test',
      composeFiles: [],
    });
    containerId = runtime.getProjectContainerId('sandstorm-parity-test')!;
    tmpdir = runtime.getContainerTmpdir(containerId)!;
  });

  afterEach(() => runtime?.destroy());

  it('writes every non-conditional stack.sh input file', async () => {
    await deliverTask(runtime, containerId, { prompt: 'test task' });
    for (const file of REQUIRED_FILES) {
      const name = fileBasename(file.pattern);
      expect(fs.existsSync(path.join(tmpdir, name)), `${name} must exist`).toBe(true);
    }
  });

  it('does not write conditional files when inputs are absent', async () => {
    await deliverTask(runtime, containerId, { prompt: 'test task' });
    for (const file of CONDITIONAL_FILES) {
      const name = fileBasename(file.pattern);
      expect(fs.existsSync(path.join(tmpdir, name)), `${name} must NOT exist`).toBe(false);
    }
  });

  it('writes all conditional files when all optional inputs are supplied', async () => {
    await deliverTask(runtime, containerId, {
      prompt: 'full task',
      model: 'claude-opus-4-8',
      modelsJson: JSON.stringify({ execution: 'auto', review: 'auto', meta_review: 'auto' }),
      resume: 'session-abc',
      backend: 'claude',
      backendModel: 'claude-sonnet-4-6',
      phaseRoutingJson: JSON.stringify({
        execution: { backend: 'claude', provider: 'anthropic', model: 'auto' },
      }),
    });
    for (const file of CONDITIONAL_FILES) {
      const name = fileBasename(file.pattern);
      expect(fs.existsSync(path.join(tmpdir, name)), `${name} must exist`).toBe(true);
    }
  });

  it('prompt file content matches exactly (B1: no argv truncation)', async () => {
    // Prompt exceeds the Linux MAX_ARG_STRLEN limit (128 KB) — verifies that
    // deliverTask delivers via stdin, never via argv.
    const bigPrompt = 'x'.repeat(200 * 1024);
    await deliverTask(runtime, containerId, { prompt: bigPrompt });
    const written = fs.readFileSync(path.join(tmpdir, 'claude-task-prompt.txt'), 'utf-8');
    expect(written).toBe(bigPrompt);
  });

  it('label matches first line of prompt, max 80 chars (mirrors head -1 | cut -c1-80)', async () => {
    const prompt = 'Short first line\nExtra content that should be ignored';
    await deliverTask(runtime, containerId, { prompt });
    const label = fs.readFileSync(path.join(tmpdir, 'claude-task-label.txt'), 'utf-8');
    expect(label).toBe('Short first line');
  });

  it('label is truncated to 80 chars for long first lines', async () => {
    const longFirstLine = 'B'.repeat(200);
    await deliverTask(runtime, containerId, { prompt: longFirstLine });
    const label = fs.readFileSync(path.join(tmpdir, 'claude-task-label.txt'), 'utf-8');
    expect(label).toHaveLength(80);
    expect(label).toBe('B'.repeat(80));
  });

  it('trigger file is present after deliverTask completes (loop will fire)', async () => {
    await deliverTask(runtime, containerId, { prompt: 'trigger test' });
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-trigger'))).toBe(true);
  });

  it('prompt file exists when trigger is set (ordering invariant)', async () => {
    // After deliverTask the prompt must be on disk — the loop reads it after trigger
    await deliverTask(runtime, containerId, { prompt: 'ordering test' });
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-prompt.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-trigger'))).toBe(true);
  });
});
