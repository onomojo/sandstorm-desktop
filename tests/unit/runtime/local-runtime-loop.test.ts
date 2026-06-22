import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LocalRuntime } from '../../../src/main/runtime/local';

const PROJECT_DIR = '/tmp/sandstorm-test-project-dir';

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('waitFor timed out')); return; }
      setTimeout(check, 20);
    };
    check();
  });
}

describe('LocalRuntime — local loop', () => {
  let runtime: LocalRuntime;

  beforeEach(() => {
    runtime = new LocalRuntime();
  });

  afterEach(() => {
    runtime.destroy();
  });

  it('composeUp writes claude-ready=ready in the container tmpdir', async () => {
    await runtime.composeUp(PROJECT_DIR, { projectName: 'loop-ready', composeFiles: [] });
    const id = runtime.getProjectContainerId('loop-ready')!;
    const tmpdir = runtime.getContainerTmpdir(id)!;

    await waitFor(() => fs.existsSync(path.join(tmpdir, 'claude-ready')));
    const content = fs.readFileSync(path.join(tmpdir, 'claude-ready'), 'utf8');
    expect(content.trim()).toBe('ready');
  });

  it('exec rewrites /tmp/ paths to the per-container tmpdir', async () => {
    await runtime.composeUp(PROJECT_DIR, { projectName: 'loop-rewrite', composeFiles: [] });
    const id = runtime.getProjectContainerId('loop-rewrite')!;
    const tmpdir = runtime.getContainerTmpdir(id)!;
    const hostPath = '/tmp/claude-task-prompt.txt';

    if (fs.existsSync(hostPath)) fs.unlinkSync(hostPath);

    const result = await runtime.exec(id, ['sh', '-c', 'echo "fake prompt" > /tmp/claude-task-prompt.txt']);
    expect(result.exitCode).toBe(0);

    expect(fs.existsSync(path.join(tmpdir, 'claude-task-prompt.txt'))).toBe(true);
    expect(fs.existsSync(hostPath)).toBe(false);
  });

  it('TMPDIR env var is set to the container tmpdir in exec', async () => {
    await runtime.composeUp(PROJECT_DIR, { projectName: 'loop-tmpdir-env', composeFiles: [] });
    const id = runtime.getProjectContainerId('loop-tmpdir-env')!;
    const tmpdir = runtime.getContainerTmpdir(id)!;

    const result = await runtime.exec(id, ['sh', '-c', 'echo $TMPDIR']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(tmpdir);
  });

  it('trigger causes loop to produce status=completed and exit=0', async () => {
    await runtime.composeUp(PROJECT_DIR, { projectName: 'loop-trigger', composeFiles: [] });
    const id = runtime.getProjectContainerId('loop-trigger')!;
    const tmpdir = runtime.getContainerTmpdir(id)!;

    await waitFor(() => fs.existsSync(path.join(tmpdir, 'claude-ready')));

    // Write a prompt then drop the trigger
    await runtime.exec(id, ['sh', '-c', 'echo "a prompt" > /tmp/claude-task-prompt.txt']);
    await runtime.exec(id, ['touch', '/tmp/claude-task-trigger']);

    await waitFor(() => {
      try {
        return fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim() === 'completed';
      } catch { return false; }
    });

    expect(fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim()).toBe('completed');
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task.exit'), 'utf8').trim()).toBe('0');
    expect(fs.readFileSync(path.join(tmpdir, 'claude-ready'), 'utf8').trim()).toBe('ready');
  });

  it('exec writes never touch the host /tmp for claude-* files', async () => {
    await runtime.composeUp(PROJECT_DIR, { projectName: 'loop-no-host', composeFiles: [] });
    const id = runtime.getProjectContainerId('loop-no-host')!;
    const hostLabel = '/tmp/claude-task-label.txt';

    if (fs.existsSync(hostLabel)) fs.unlinkSync(hostLabel);

    await runtime.exec(id, ['sh', '-c', 'echo "label" > /tmp/claude-task-label.txt']);
    await runtime.exec(id, ['touch', '/tmp/claude-task-trigger']);

    // Wait a beat to ensure any writes would have landed
    await new Promise((r) => setTimeout(r, 100));

    expect(fs.existsSync(hostLabel)).toBe(false);
  });

  it('two concurrent containers are fully isolated', async () => {
    await runtime.composeUp(PROJECT_DIR, { projectName: 'loop-iso-a', composeFiles: [] });
    await runtime.composeUp(PROJECT_DIR, { projectName: 'loop-iso-b', composeFiles: [] });

    const idA = runtime.getProjectContainerId('loop-iso-a')!;
    const idB = runtime.getProjectContainerId('loop-iso-b')!;
    const tmpdirA = runtime.getContainerTmpdir(idA)!;
    const tmpdirB = runtime.getContainerTmpdir(idB)!;

    expect(tmpdirA).not.toBe(tmpdirB);

    await waitFor(() =>
      fs.existsSync(path.join(tmpdirA, 'claude-ready')) &&
      fs.existsSync(path.join(tmpdirB, 'claude-ready'))
    );

    // Write prompt only to A, trigger only A
    await runtime.exec(idA, ['sh', '-c', 'echo "prompt-a" > /tmp/claude-task-prompt.txt']);
    await runtime.exec(idA, ['touch', '/tmp/claude-task-trigger']);

    await waitFor(() => {
      try {
        return fs.readFileSync(path.join(tmpdirA, 'claude-task.status'), 'utf8').trim() === 'completed';
      } catch { return false; }
    });

    // A produced output
    expect(fs.readFileSync(path.join(tmpdirA, 'claude-task.status'), 'utf8').trim()).toBe('completed');
    expect(fs.readFileSync(path.join(tmpdirA, 'claude-task-prompt.txt'), 'utf8').trim()).toBe('prompt-a');

    // B is untouched by A's writes
    expect(fs.existsSync(path.join(tmpdirB, 'claude-task-prompt.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmpdirB, 'claude-task.status'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpdirB, 'claude-ready'), 'utf8').trim()).toBe('ready');
  });

  it('composeDown stops the loop and removes the tmpdir', async () => {
    await runtime.composeUp(PROJECT_DIR, { projectName: 'loop-down', composeFiles: [] });
    const id = runtime.getProjectContainerId('loop-down')!;
    const tmpdir = runtime.getContainerTmpdir(id)!;

    await waitFor(() => fs.existsSync(path.join(tmpdir, 'claude-ready')));
    expect(fs.existsSync(tmpdir)).toBe(true);

    await runtime.composeDown(PROJECT_DIR, { projectName: 'loop-down', composeFiles: [] });

    expect(fs.existsSync(tmpdir)).toBe(false);

    const containers = await runtime.listContainers({ name: 'loop-down' });
    expect(containers).toHaveLength(0);

    // Let enough time pass to confirm no residual timer fires (would crash on missing tmpdir)
    await new Promise((r) => setTimeout(r, 150));
  });

  it('loop handles a second trigger after the first completes', async () => {
    await runtime.composeUp(PROJECT_DIR, { projectName: 'loop-multi', composeFiles: [] });
    const id = runtime.getProjectContainerId('loop-multi')!;
    const tmpdir = runtime.getContainerTmpdir(id)!;

    await waitFor(() => fs.existsSync(path.join(tmpdir, 'claude-ready')));

    // First trigger
    await runtime.exec(id, ['touch', '/tmp/claude-task-trigger']);
    await waitFor(() => {
      try {
        return fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim() === 'completed';
      } catch { return false; }
    });

    // Loop should have restored ready
    await waitFor(() => fs.existsSync(path.join(tmpdir, 'claude-ready')));

    // Clear first-round status before dropping the trigger so the loop
    // cannot process the trigger and write completed before we delete it
    fs.unlinkSync(path.join(tmpdir, 'claude-task.status'));
    // Second trigger
    await runtime.exec(id, ['touch', '/tmp/claude-task-trigger']);

    await waitFor(() => {
      try {
        return fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim() === 'completed';
      } catch { return false; }
    });

    expect(fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim()).toBe('completed');
  });
});
