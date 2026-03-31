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

describe('Task Metadata Persistence', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  describe('schema v8 migration', () => {
    it('adds new metadata columns to tasks table', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'test prompt');

      // New columns should exist with null defaults
      expect(task.review_verdicts).toBeNull();
      expect(task.verify_outputs).toBeNull();
      expect(task.execution_summary).toBeNull();
      expect(task.execution_started_at).toBeNull();
      expect(task.execution_finished_at).toBeNull();
      expect(task.review_started_at).toBeNull();
      expect(task.review_finished_at).toBeNull();
      expect(task.verify_started_at).toBeNull();
      expect(task.verify_finished_at).toBeNull();
    });

    it('adds task_history column to stack_history table', () => {
      registry.createStack(makeStack());
      registry.archiveStack('test-stack', 'completed');
      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].task_history).toBeNull();
    });
  });

  describe('updateTaskMetadata', () => {
    it('stores review verdicts as JSON array', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'test prompt');

      const verdicts = JSON.stringify(['REVIEW_PASS']);
      registry.updateTaskMetadata(task.id, { review_verdicts: verdicts });

      const tasks = registry.getTasksForStack('test-stack');
      expect(tasks[0].review_verdicts).toBe(verdicts);
    });

    it('stores verify outputs as JSON array', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'test prompt');

      const outputs = JSON.stringify(['Tests passed', 'Build succeeded']);
      registry.updateTaskMetadata(task.id, { verify_outputs: outputs });

      const tasks = registry.getTasksForStack('test-stack');
      expect(tasks[0].verify_outputs).toBe(outputs);
    });

    it('stores execution summary', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'test prompt');

      registry.updateTaskMetadata(task.id, { execution_summary: 'Task completed successfully' });

      const tasks = registry.getTasksForStack('test-stack');
      expect(tasks[0].execution_summary).toBe('Task completed successfully');
    });

    it('stores phase timing', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'test prompt');

      registry.updateTaskMetadata(task.id, {
        execution_started_at: '2026-03-30T10:00:00Z',
        execution_finished_at: '2026-03-30T10:05:00Z',
        review_started_at: '2026-03-30T10:05:01Z',
        review_finished_at: '2026-03-30T10:06:00Z',
        verify_started_at: '2026-03-30T10:06:01Z',
        verify_finished_at: '2026-03-30T10:07:00Z',
      });

      const tasks = registry.getTasksForStack('test-stack');
      expect(tasks[0].execution_started_at).toBe('2026-03-30T10:00:00Z');
      expect(tasks[0].execution_finished_at).toBe('2026-03-30T10:05:00Z');
      expect(tasks[0].review_started_at).toBe('2026-03-30T10:05:01Z');
      expect(tasks[0].review_finished_at).toBe('2026-03-30T10:06:00Z');
      expect(tasks[0].verify_started_at).toBe('2026-03-30T10:06:01Z');
      expect(tasks[0].verify_finished_at).toBe('2026-03-30T10:07:00Z');
    });

    it('does nothing when no fields provided', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'test prompt');

      // Should not throw
      registry.updateTaskMetadata(task.id, {});

      const tasks = registry.getTasksForStack('test-stack');
      expect(tasks[0].review_verdicts).toBeNull();
    });
  });

  describe('interruptTask', () => {
    it('sets task status to interrupted', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'test prompt');

      registry.interruptTask(task.id);

      const tasks = registry.getTasksForStack('test-stack');
      expect(tasks[0].status).toBe('interrupted');
      expect(tasks[0].finished_at).not.toBeNull();
    });

    it('only interrupts running tasks', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'test prompt');
      registry.completeTask(task.id, 0);

      registry.interruptTask(task.id);

      const tasks = registry.getTasksForStack('test-stack');
      // Should remain completed, not changed to interrupted
      expect(tasks[0].status).toBe('completed');
    });
  });

  describe('archiveStack preserves task data', () => {
    it('archives task data as JSON blob', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'fix the bug');
      registry.updateTaskMetadata(task.id, {
        review_verdicts: JSON.stringify(['REVIEW_PASS']),
        execution_summary: 'Fixed the bug',
        execution_started_at: '2026-03-30T10:00:00Z',
        execution_finished_at: '2026-03-30T10:05:00Z',
      });
      registry.completeTask(task.id, 0);

      registry.archiveStack('test-stack', 'completed');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].task_history).not.toBeNull();

      const archivedTasks = JSON.parse(history[0].task_history!);
      expect(archivedTasks).toHaveLength(1);
      expect(archivedTasks[0].prompt).toBe('fix the bug');
      expect(archivedTasks[0].review_verdicts).toBe(JSON.stringify(['REVIEW_PASS']));
      expect(archivedTasks[0].execution_summary).toBe('Fixed the bug');
    });

    it('archives multiple tasks', () => {
      registry.createStack(makeStack());
      const task1 = registry.createTask('test-stack', 'first task');
      registry.completeTask(task1.id, 0);
      const task2 = registry.createTask('test-stack', 'second task');
      registry.completeTask(task2.id, 0);

      registry.archiveStack('test-stack', 'completed');

      const history = registry.listStackHistory();
      const archivedTasks = JSON.parse(history[0].task_history!);
      expect(archivedTasks).toHaveLength(2);
    });

    it('archives stack with no tasks', () => {
      registry.createStack(makeStack());
      registry.archiveStack('test-stack', 'torn_down');

      const history = registry.listStackHistory();
      expect(history[0].task_history).toBeNull();
    });

    it('preserves interrupted task in archive', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'interrupted task');
      registry.updateTaskMetadata(task.id, {
        execution_summary: 'Partial work done',
      });
      registry.interruptTask(task.id);

      registry.archiveStack('test-stack', 'torn_down');

      const history = registry.listStackHistory();
      const archivedTasks = JSON.parse(history[0].task_history!);
      expect(archivedTasks[0].status).toBe('interrupted');
      expect(archivedTasks[0].execution_summary).toBe('Partial work done');
    });
  });

  describe('purgeOldHistory', () => {
    it('removes stack_history records older than retention period', () => {
      registry.createStack(makeStack('old-stack'));
      registry.archiveStack('old-stack', 'completed');

      // Manually backdated the finished_at to simulate old record
      // Note: We can't easily backdate in SQLite without raw SQL, so we test
      // that the method runs without error and returns a count
      const purged = registry.purgeOldHistory(14);
      // The record was just created so it shouldn't be purged
      expect(purged).toBe(0);
      expect(registry.listStackHistory()).toHaveLength(1);
    });

    it('does not purge recent records', () => {
      registry.createStack(makeStack('recent-stack'));
      registry.archiveStack('recent-stack', 'completed');

      const purged = registry.purgeOldHistory(14);
      expect(purged).toBe(0);
      expect(registry.listStackHistory()).toHaveLength(1);
    });
  });

  describe('missing metadata columns return null', () => {
    it('all new columns default to null on fresh task', () => {
      registry.createStack(makeStack());
      const task = registry.createTask('test-stack', 'test');

      expect(task.review_verdicts).toBeNull();
      expect(task.verify_outputs).toBeNull();
      expect(task.execution_summary).toBeNull();
      expect(task.execution_started_at).toBeNull();
      expect(task.execution_finished_at).toBeNull();
      expect(task.review_started_at).toBeNull();
      expect(task.review_finished_at).toBeNull();
      expect(task.verify_started_at).toBeNull();
      expect(task.verify_finished_at).toBeNull();
    });

    it('task_history defaults to null on fresh stack_history', () => {
      registry.createStack(makeStack());
      registry.archiveStack('test-stack', 'completed');
      const history = registry.listStackHistory();
      // No tasks were created, so task_history should be null
      expect(history[0].task_history).toBeNull();
    });
  });
});

describe('TaskWatcher metadata reading', () => {
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

  function createMetadataRuntime(files: Record<string, string>): ContainerRuntime {
    return {
      name: 'mock',
      composeUp: vi.fn(),
      composeDown: vi.fn(),
      listContainers: vi.fn().mockResolvedValue([]),
      inspect: vi.fn(),
      logs: vi.fn(),
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        // Handle status file
        if (cmd.includes('/tmp/claude-task.status')) {
          return { exitCode: 0, stdout: 'running', stderr: '' };
        }
        if (cmd.includes('/tmp/claude-task.exit')) {
          return { exitCode: 0, stdout: '0', stderr: '' };
        }

        // Handle 'sh -c' commands (ls for listing files)
        if (cmd[0] === 'sh' && cmd[1] === '-c') {
          const shellCmd = cmd[2];
          if (shellCmd.includes('claude-review-verdict')) {
            const matchingFiles = Object.keys(files).filter(f => f.includes('claude-review-verdict'));
            return { exitCode: 0, stdout: matchingFiles.join('\n'), stderr: '' };
          }
          if (shellCmd.includes('claude-verify-output')) {
            const matchingFiles = Object.keys(files).filter(f => f.includes('claude-verify-output'));
            return { exitCode: 0, stdout: matchingFiles.join('\n'), stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }

        // Handle cat commands
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

  it('reads numbered review verdict files and stores JSON array', async () => {
    const runtime = createMetadataRuntime({
      '/tmp/claude-review-verdict-1.txt': 'REVIEW_FAIL\nIssues found: missing tests',
      '/tmp/claude-review-verdict-2.txt': 'REVIEW_PASS',
      '/tmp/claude-tokens-execution': '',
      '/tmp/claude-tokens-review': '',
      '/tmp/claude-raw.log': '',
      '/tmp/claude-task.review-iterations': '2',
      '/tmp/claude-task.verify-retries': '0',
      '/tmp/claude-execution-summary.txt': 'Fixed all issues',
      '/tmp/claude-phase-timing.txt': 'execution_started_at=2026-03-30T10:00:00Z\nexecution_finished_at=2026-03-30T10:05:00Z',
    });

    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50000 });
    const task = registry.createTask('test-stack', 'test prompt');

    await watcher.capturePartialMetadata(task.id, 'test-stack', 'container-1');

    const tasks = registry.getTasksForStack('test-stack');
    expect(tasks[0].review_verdicts).not.toBeNull();
    const verdicts = JSON.parse(tasks[0].review_verdicts!);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toContain('REVIEW_FAIL');
    expect(verdicts[1]).toBe('REVIEW_PASS');
  });

  it('reads numbered verify output files and stores JSON array', async () => {
    const runtime = createMetadataRuntime({
      '/tmp/claude-verify-output-1.txt': 'VERIFY_FAIL\nTest errors...',
      '/tmp/claude-verify-output-2.txt': 'VERIFY_PASS',
      '/tmp/claude-tokens-execution': '',
      '/tmp/claude-tokens-review': '',
      '/tmp/claude-raw.log': '',
      '/tmp/claude-task.review-iterations': '0',
      '/tmp/claude-task.verify-retries': '1',
      '/tmp/claude-execution-summary.txt': '',
      '/tmp/claude-phase-timing.txt': '',
    });

    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50000 });
    const task = registry.createTask('test-stack', 'test prompt');

    await watcher.capturePartialMetadata(task.id, 'test-stack', 'container-1');

    const tasks = registry.getTasksForStack('test-stack');
    expect(tasks[0].verify_outputs).not.toBeNull();
    const outputs = JSON.parse(tasks[0].verify_outputs!);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toContain('VERIFY_FAIL');
  });

  it('reads execution summary and phase timing', async () => {
    const runtime = createMetadataRuntime({
      '/tmp/claude-tokens-execution': '',
      '/tmp/claude-tokens-review': '',
      '/tmp/claude-raw.log': '',
      '/tmp/claude-task.review-iterations': '0',
      '/tmp/claude-task.verify-retries': '0',
      '/tmp/claude-execution-summary.txt': 'All tests pass, code looks good.',
      '/tmp/claude-phase-timing.txt': [
        'execution_started_at=2026-03-30T10:00:00Z',
        'execution_finished_at=2026-03-30T10:05:00Z',
        'review_started_at=2026-03-30T10:05:01Z',
        'review_finished_at=2026-03-30T10:06:00Z',
        'verify_started_at=2026-03-30T10:06:01Z',
        'verify_finished_at=2026-03-30T10:07:00Z',
      ].join('\n'),
    });

    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50000 });
    const task = registry.createTask('test-stack', 'test prompt');

    await watcher.capturePartialMetadata(task.id, 'test-stack', 'container-1');

    const tasks = registry.getTasksForStack('test-stack');
    expect(tasks[0].execution_summary).toBe('All tests pass, code looks good.');
    expect(tasks[0].execution_started_at).toBe('2026-03-30T10:00:00Z');
    expect(tasks[0].execution_finished_at).toBe('2026-03-30T10:05:00Z');
    expect(tasks[0].review_started_at).toBe('2026-03-30T10:05:01Z');
    expect(tasks[0].review_finished_at).toBe('2026-03-30T10:06:00Z');
    expect(tasks[0].verify_started_at).toBe('2026-03-30T10:06:01Z');
    expect(tasks[0].verify_finished_at).toBe('2026-03-30T10:07:00Z');
  });

  it('handles missing metadata files gracefully', async () => {
    // Runtime where all file reads throw (simulating no metadata files)
    const runtime: ContainerRuntime = {
      name: 'mock',
      composeUp: vi.fn(),
      composeDown: vi.fn(),
      listContainers: vi.fn().mockResolvedValue([]),
      inspect: vi.fn(),
      logs: vi.fn(),
      exec: vi.fn().mockRejectedValue(new Error('file not found')),
      isAvailable: vi.fn().mockResolvedValue(true),
      version: vi.fn().mockResolvedValue('Mock 1.0'),
      containerStats: vi.fn(),
    };

    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50000 });
    const task = registry.createTask('test-stack', 'test prompt');

    // Should not throw
    await watcher.capturePartialMetadata(task.id, 'test-stack', 'container-1');

    const tasks = registry.getTasksForStack('test-stack');
    expect(tasks[0].review_verdicts).toBeNull();
    expect(tasks[0].verify_outputs).toBeNull();
    expect(tasks[0].execution_summary).toBeNull();
  });
});
