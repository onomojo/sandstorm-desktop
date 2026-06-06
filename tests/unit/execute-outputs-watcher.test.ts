import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { ContainerRuntime } from '../../src/main/runtime/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function makeStack(id: string = 'test-stack') {
  return {
    id,
    project: 'proj',
    project_dir: '/proj',
    ticket: null as string | null,
    branch: null as string | null,
    description: null as string | null,
    status: 'building' as const,
    runtime: 'docker' as const,
  };
}

function createMetadataRuntime(files: Record<string, string>): ContainerRuntime {
  return {
    name: 'mock',
    composeUp: vi.fn(),
    composeDown: vi.fn(),
    listContainers: vi.fn().mockResolvedValue([]),
    inspect: vi.fn(),
    logs: vi.fn(),
    exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
      if (cmd.includes('/tmp/claude-task.status')) {
        return { exitCode: 0, stdout: 'running', stderr: '' };
      }
      if (cmd.includes('/tmp/claude-task.exit')) {
        return { exitCode: 0, stdout: '0', stderr: '' };
      }
      if (cmd[0] === 'sh' && cmd[1] === '-c') {
        const shellCmd = cmd[2] as string;
        if (shellCmd.includes('claude-review-verdict')) {
          const matchingFiles = Object.keys(files).filter((f) => f.includes('claude-review-verdict'));
          return { exitCode: 0, stdout: matchingFiles.join('\n'), stderr: '' };
        }
        if (shellCmd.includes('claude-verify-output')) {
          const matchingFiles = Object.keys(files).filter((f) => f.includes('claude-verify-output'));
          return { exitCode: 0, stdout: matchingFiles.join('\n'), stderr: '' };
        }
        if (shellCmd.includes('claude-execute-output')) {
          const matchingFiles = Object.keys(files).filter((f) => f.includes('claude-execute-output'));
          return { exitCode: 0, stdout: matchingFiles.join('\n'), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd[0] === 'cat' && cmd[1]) {
        const content = files[cmd[1]];
        if (content !== undefined) {
          return { exitCode: 0, stdout: content, stderr: '' };
        }
        throw new Error(`File not found: ${cmd[1]}`);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
    containerStats: vi.fn(),
  };
}

describe('TaskWatcher execute_outputs reading', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    registry.createStack(makeStack());
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  it('reads numbered execute output files and stores JSON array', async () => {
    const runtime = createMetadataRuntime({
      '/tmp/claude-execute-output-0.txt': 'EXECUTE_PASS\nInitial execute success',
      '/tmp/claude-execute-output-1.txt': 'EXECUTE_FAIL\nFix attempt failed',
      '/tmp/claude-tokens-execution': '',
      '/tmp/claude-tokens-review': '',
      '/tmp/claude-raw.log': '',
      '/tmp/claude-task.review-iterations': '2',
      '/tmp/claude-task.verify-retries': '0',
      '/tmp/claude-execution-summary.txt': '',
      '/tmp/claude-phase-timing.txt': '',
    });

    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50000 });
    const task = registry.createTask('test-stack', 'test prompt');
    await watcher.capturePartialMetadata(task.id, 'test-stack', 'container-1');

    const tasks = registry.getTasksForStack('test-stack');
    expect(tasks[0].execute_outputs).not.toBeNull();
    const outputs = JSON.parse(tasks[0].execute_outputs!);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toContain('EXECUTE_PASS');
    expect(outputs[1]).toContain('EXECUTE_FAIL');
  });

  it('stores execute outputs sorted by filename (numeric order)', async () => {
    const runtime = createMetadataRuntime({
      '/tmp/claude-execute-output-0.txt': 'EXECUTE_PASS\nIteration 0',
      '/tmp/claude-execute-output-1.txt': 'EXECUTE_FAIL\nIteration 1',
      '/tmp/claude-execute-output-2.txt': 'EXECUTE_FAIL\nIteration 2',
      '/tmp/claude-tokens-execution': '',
      '/tmp/claude-tokens-review': '',
      '/tmp/claude-raw.log': '',
      '/tmp/claude-task.review-iterations': '3',
      '/tmp/claude-task.verify-retries': '0',
      '/tmp/claude-execution-summary.txt': '',
      '/tmp/claude-phase-timing.txt': '',
    });

    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50000 });
    const task = registry.createTask('test-stack', 'test prompt');
    await watcher.capturePartialMetadata(task.id, 'test-stack', 'container-1');

    const tasks = registry.getTasksForStack('test-stack');
    const outputs = JSON.parse(tasks[0].execute_outputs!);
    expect(outputs[0]).toContain('Iteration 0');
    expect(outputs[1]).toContain('Iteration 1');
    expect(outputs[2]).toContain('Iteration 2');
  });

  it('gracefully handles missing execute output files (returns null)', async () => {
    const runtime = createMetadataRuntime({
      '/tmp/claude-tokens-execution': '',
      '/tmp/claude-tokens-review': '',
      '/tmp/claude-raw.log': '',
      '/tmp/claude-task.review-iterations': '0',
      '/tmp/claude-task.verify-retries': '0',
      '/tmp/claude-execution-summary.txt': '',
      '/tmp/claude-phase-timing.txt': '',
    });

    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50000 });
    const task = registry.createTask('test-stack', 'test prompt');
    await watcher.capturePartialMetadata(task.id, 'test-stack', 'container-1');

    const tasks = registry.getTasksForStack('test-stack');
    expect(tasks[0].execute_outputs).toBeNull();
  });

  it('updateTaskMetadata round-trips execute_outputs column', async () => {
    const task = registry.createTask('test-stack', 'test prompt');
    const outputs = JSON.stringify(['EXECUTE_PASS\nok', 'EXECUTE_FAIL\nerr']);
    registry.updateTaskMetadata(task.id, { execute_outputs: outputs });
    const tasks = registry.getTasksForStack('test-stack');
    expect(tasks[0].execute_outputs).toBe(outputs);
  });
});
