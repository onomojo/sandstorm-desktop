/**
 * Unit tests for StackManager.autoResolveConflicts internals.
 *
 * Stubs dispatchTask, awaitTaskCompletion, push, createStack, teardownStack,
 * and execFileAsync (via child_process.execFile mock) to verify orchestration
 * invariants without real Docker or gh CLI.
 *
 * Covers:
 * - gateApproved: true is passed to dispatchTask (both reuse and recreate paths)
 * - push skipped when task exit_code is non-zero
 * - push skipped when awaitTaskCompletion times out
 * - teardown only when auto-created (not on pre-existing stack)
 * - recreate path when stack is absent (stack torn down)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { SandstormError, ErrorCode } from '../../src/main/errors';
import type { Task } from '../../src/main/control-plane/registry';

// ---------------------------------------------------------------------------
// Hoist the gh mock so it's available in the vi.mock factory.
// execFileAsync = promisify(execFile); to intercept it we set
// [util.promisify.custom] on the mocked execFile, so promisify picks it up.
// ---------------------------------------------------------------------------
const { mockGhFn } = vi.hoisted(() => {
  const mockGhFn = vi.fn<[], Promise<{ stdout: string; stderr: string }>>();
  return { mockGhFn };
});

vi.mock('child_process', async () => {
  const util = await import('util');
  const execFile = vi.fn();
  (execFile as any)[util.promisify.custom] = mockGhFn;
  return {
    execFile,
    execSync: vi.fn().mockReturnValue('abc123sha'),
    spawn: vi.fn(),
  };
});

import { StackManager } from '../../src/main/control-plane/stack-manager';
import { Registry } from '../../src/main/control-plane/registry';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import type { ContainerRuntime } from '../../src/main/runtime/types';
import { makeFakeContainerRuntime } from '../helpers/fake-container-runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTempDb(): string {
  return path.join(
    os.tmpdir(),
    `sm-autoresolve-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function createMockRuntime(): ContainerRuntime {
  return makeFakeContainerRuntime();
}

const TICKET = 'T-1';
const PROJECT_DIR = '/proj';
const BRANCH = 'feat/T-1';
const PR_NUMBER = 42;
const PR_URL = 'https://github.com/org/repo/pull/42';

function makeTerminalTask(exit_code: number): Task {
  return {
    id: 101,
    stack_id: 'stack-1',
    status: exit_code === 0 ? 'completed' : 'failed',
    exit_code,
    prompt: '',
    model: null,
    resolved_model: null,
    warnings: null,
    session_id: null,
    input_tokens: 0,
    output_tokens: 0,
    execution_input_tokens: 0,
    execution_output_tokens: 0,
    review_input_tokens: 0,
    review_output_tokens: 0,
    review_iterations: 0,
    verify_retries: 0,
    review_verdicts: null,
    verify_outputs: null,
    execution_summary: null,
    execution_started_at: null,
    execution_finished_at: null,
    review_started_at: null,
    review_finished_at: null,
    verify_started_at: null,
    verify_finished_at: null,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    resumed_at: null,
  };
}

function ghViewJson(mergeable: string, baseRefName = 'main') {
  return {
    stdout: JSON.stringify({ mergeable, mergeStateStatus: 'DIRTY', baseRefName }),
    stderr: '',
  };
}

function ghListJson(mergeable: string, baseRefName = 'main') {
  return {
    stdout: JSON.stringify([{ number: PR_NUMBER, mergeable, mergeStateStatus: 'DIRTY', baseRefName }]),
    stderr: '',
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('StackManager.autoResolveConflicts internals', () => {
  let registry: Registry;
  let portAllocator: PortAllocator;
  let taskWatcher: TaskWatcher;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;

  let dispatchTaskSpy: ReturnType<typeof vi.spyOn>;
  let awaitTaskCompletionSpy: ReturnType<typeof vi.spyOn>;
  let pushSpy: ReturnType<typeof vi.spyOn>;
  let createStackSpy: ReturnType<typeof vi.spyOn>;
  let teardownStackSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    portAllocator = new PortAllocator(registry, [40000, 40099]);
    taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');

    mockGhFn.mockReset();

    dispatchTaskSpy = vi.spyOn(manager, 'dispatchTask').mockResolvedValue({ id: 101, stack_id: 'stack-1', status: 'running' });
    awaitTaskCompletionSpy = vi.spyOn(manager, 'awaitTaskCompletion').mockResolvedValue(makeTerminalTask(0));
    pushSpy = vi.spyOn(manager, 'push').mockResolvedValue({ stdout: '', stderr: '' });
    createStackSpy = vi.spyOn(manager, 'createStack');
    teardownStackSpy = vi.spyOn(manager, 'teardownStack').mockResolvedValue(undefined);
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Live stack path: stack exists and has pr_number
  // ==========================================================================
  describe('live stack path', () => {
    beforeEach(() => {
      registry.createStack({
        id: 'stack-1',
        project: 'test',
        project_dir: PROJECT_DIR,
        ticket: TICKET,
        branch: BRANCH,
        description: null,
        status: 'pr_created',
        runtime: 'docker',
      });
      registry.setPullRequest('stack-1', PR_URL, PR_NUMBER);
      mockGhFn.mockResolvedValue(ghViewJson('CONFLICTING'));
    });

    it('passes gateApproved: true to dispatchTask', async () => {
      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(dispatchTaskSpy).toHaveBeenCalledWith(
        'stack-1',
        expect.any(String),
        undefined,
        expect.objectContaining({ gateApproved: true, executionTouchpoint: 'merge_conflict' })
      );
    });

    it('includes baseRefName from gh response in the dispatch prompt', async () => {
      mockGhFn.mockResolvedValue(ghViewJson('CONFLICTING', 'develop'));

      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      const [, prompt] = dispatchTaskSpy.mock.calls[0] as [string, string, ...unknown[]];
      expect(prompt).toContain('develop');
    });

    it('pushes and returns resolved when task exit_code is 0', async () => {
      const result = await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(pushSpy).toHaveBeenCalledOnce();
      expect(result).toEqual({ status: 'resolved' });
    });

    it('skips push and returns failed when task exit_code is non-zero', async () => {
      awaitTaskCompletionSpy.mockResolvedValue(makeTerminalTask(1));

      const result = await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(pushSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'failed' });
    });

    it('skips push and throws when awaitTaskCompletion times out', async () => {
      awaitTaskCompletionSpy.mockRejectedValue(
        new SandstormError(ErrorCode.TASK_DISPATCH_FAILED, 'Auto-resolve timed out waiting for task completion')
      );

      await expect(manager.autoResolveConflicts(TICKET, PROJECT_DIR)).rejects.toThrow('timed out');
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('does not teardown a pre-existing stack on success', async () => {
      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(teardownStackSpy).not.toHaveBeenCalled();
    });

    it('does not teardown a pre-existing stack when task fails', async () => {
      awaitTaskCompletionSpy.mockResolvedValue(makeTerminalTask(1));

      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(teardownStackSpy).not.toHaveBeenCalled();
    });

    it('does not teardown a pre-existing stack when awaitTaskCompletion times out', async () => {
      awaitTaskCompletionSpy.mockRejectedValue(
        new SandstormError(ErrorCode.TASK_DISPATCH_FAILED, 'Auto-resolve timed out waiting for task completion')
      );

      await expect(manager.autoResolveConflicts(TICKET, PROJECT_DIR)).rejects.toThrow();
      expect(teardownStackSpy).not.toHaveBeenCalled();
    });

    it('does not dispatch and returns no_conflicts when PR is MERGEABLE', async () => {
      mockGhFn.mockResolvedValue(ghViewJson('MERGEABLE'));

      const result = await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(dispatchTaskSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'no_conflicts' });
    });

    it('does not dispatch and returns unknown_state when PR is UNKNOWN', async () => {
      mockGhFn.mockResolvedValue(ghViewJson('UNKNOWN'));

      const result = await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(dispatchTaskSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'unknown_state' });
    });
  });

  // ==========================================================================
  // Recreate path: stack was torn down, found only in history
  // ==========================================================================
  describe('recreate path (stack absent)', () => {
    beforeEach(() => {
      // Seed history by creating a stack, archiving it, then deleting it from live stacks
      registry.createStack({
        id: 'old-stack',
        project: 'test',
        project_dir: PROJECT_DIR,
        ticket: TICKET,
        branch: BRANCH,
        description: null,
        status: 'pr_created',
        runtime: 'docker',
      });
      registry.archiveStack('old-stack', 'torn_down');
      registry.deleteStack('old-stack');

      // gh pr list response for the torn-down case
      mockGhFn.mockResolvedValue(ghListJson('CONFLICTING'));

      // createStack spy: insert a stack with 'up' status so the build-wait loop
      // exits immediately on the first registry.getStack check.
      createStackSpy.mockImplementation((opts) => {
        return registry.createStack({
          id: opts.name,
          project: 'test',
          project_dir: opts.projectDir,
          ticket: opts.ticket ?? null,
          branch: opts.branch ?? null,
          description: opts.description ?? null,
          status: 'up',
          runtime: opts.runtime ?? 'docker',
        });
      });
    });

    it('calls createStack when no live stack exists', async () => {
      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(createStackSpy).toHaveBeenCalledOnce();
    });

    it('passes gateApproved: true to dispatchTask on the recreate path', async () => {
      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(dispatchTaskSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        undefined,
        expect.objectContaining({ gateApproved: true, executionTouchpoint: 'merge_conflict' })
      );
    });

    it('tears down the recreated stack after successful resolution', async () => {
      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(teardownStackSpy).toHaveBeenCalledOnce();
    });

    it('tears down the recreated stack even when task fails (finally block)', async () => {
      awaitTaskCompletionSpy.mockResolvedValue(makeTerminalTask(1));

      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(teardownStackSpy).toHaveBeenCalledOnce();
    });

    it('tears down the recreated stack even when awaitTaskCompletion times out', async () => {
      awaitTaskCompletionSpy.mockRejectedValue(
        new SandstormError(ErrorCode.TASK_DISPATCH_FAILED, 'Auto-resolve timed out waiting for task completion')
      );

      await expect(manager.autoResolveConflicts(TICKET, PROJECT_DIR)).rejects.toThrow();
      expect(teardownStackSpy).toHaveBeenCalledOnce();
    });

    it('skips push when task exit_code is non-zero on recreate path', async () => {
      awaitTaskCompletionSpy.mockResolvedValue(makeTerminalTask(1));

      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('does not call createStack when gh reports MERGEABLE (early exit before recreate)', async () => {
      mockGhFn.mockResolvedValue(ghListJson('MERGEABLE'));

      const result = await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      expect(createStackSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'no_conflicts' });
    });

    it('throws STACK_NOT_FOUND when no history record exists for the ticket', async () => {
      vi.spyOn(registry, 'listStackHistory').mockReturnValue([]);

      await expect(manager.autoResolveConflicts(TICKET, PROJECT_DIR)).rejects.toThrow();
    });
  });

  // ==========================================================================
  // merge_conflict routing
  // ==========================================================================
  describe('merge_conflict routing', () => {
    beforeEach(() => {
      registry.createStack({
        id: 'stack-1',
        project: 'test',
        project_dir: PROJECT_DIR,
        ticket: TICKET,
        branch: BRANCH,
        description: null,
        status: 'pr_created',
        runtime: 'docker',
      });
      registry.setPullRequest('stack-1', PR_URL, PR_NUMBER);
      mockGhFn.mockResolvedValue(ghViewJson('CONFLICTING'));
    });

    it('dispatches with executionTouchpoint=merge_conflict and undefined model', async () => {
      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      const [, , model, opts] = dispatchTaskSpy.mock.calls[0] as [string, string, string | undefined, Record<string, unknown>];
      // Model is now undefined — routing is driven by executionTouchpoint in --phase-routing-json
      expect(model).toBeUndefined();
      expect(opts.executionTouchpoint).toBe('merge_conflict');
    });

    it('dispatches with executionTouchpoint=merge_conflict when routing is configured', async () => {
      registry.setProjectRouting(PROJECT_DIR, { assignments: { merge_conflict: { backend: 'claude', model: 'haiku' } }, preset: null });

      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      const [, , model, opts] = dispatchTaskSpy.mock.calls[0] as [string, string, string | undefined, Record<string, unknown>];
      expect(model).toBeUndefined();
      expect(opts.executionTouchpoint).toBe('merge_conflict');
    });

    it('dispatches with executionTouchpoint=merge_conflict for opencode merge_conflict routing (no fallback)', async () => {
      registry.setProjectRouting(PROJECT_DIR, { assignments: { merge_conflict: { backend: 'opencode', model: 'some-opencode-model' } }, preset: null });

      await manager.autoResolveConflicts(TICKET, PROJECT_DIR);

      const [, , model, opts] = dispatchTaskSpy.mock.calls[0] as [string, string, string | undefined, Record<string, unknown>];
      // No fallback warning — opencode is now supported for container merge_conflict dispatch
      expect(model).toBeUndefined();
      expect(opts.executionTouchpoint).toBe('merge_conflict');
    });
  });
});
