/**
 * Tests for StackManager.askClarifyingQuestions (D2, ticket #622)
 * and the relaxed gate in resumeNeedsHumanStack (D3, ticket #622).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  StackManager,
  ASK_CLARIFYING_QUESTIONS_PROMPT,
} from '../../../../src/main/control-plane/stack-manager';
import { Registry } from '../../../../src/main/control-plane/registry';
import { PortAllocator } from '../../../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../../../src/main/control-plane/task-watcher';
import type { ContainerRuntime } from '../../../../src/main/runtime/types';
import { makeFakeContainerRuntime } from '../../../helpers/fake-container-runtime';

function makeTempDb(): string {
  return path.join(
    os.tmpdir(),
    `sm-clarify-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function createMockRuntime(): ContainerRuntime {
  return makeFakeContainerRuntime({
    listContainers: vi.fn().mockResolvedValue([
      {
        id: 'cid-claude',
        name: 'sandstorm-proj-s1-claude-1',
        image: 'sandstorm-claude',
        status: 'running' as const,
        state: 'running',
        ports: [],
        labels: {},
        created: new Date().toISOString(),
      },
    ]),
  });
}

describe('ASK_CLARIFYING_QUESTIONS_PROMPT', () => {
  it('includes instruction to emit STOP_AND_ASK after writing the questions file', () => {
    expect(ASK_CLARIFYING_QUESTIONS_PROMPT).toContain('STOP_AND_ASK:');
  });

  it('includes the questions file path', () => {
    expect(ASK_CLARIFYING_QUESTIONS_PROMPT).toContain('/tmp/claude-stop-questions.json');
  });
});

describe('StackManager.askClarifyingQuestions', () => {
  let registry: Registry;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    const portAllocator = new PortAllocator(registry, [40100, 40199]);
    const taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');

    registry.createStack({
      id: 's1',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'needs_human',
      runtime: 'docker',
    });
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  it('throws when stack not found', async () => {
    await expect(manager.askClarifyingQuestions('no-such-stack')).rejects.toThrow();
  });

  it('throws when stack is not needs_human', async () => {
    registry.updateStackStatus('s1', 'running');
    await expect(manager.askClarifyingQuestions('s1')).rejects.toThrow('not in needs_human state');
  });

  it('throws when no task found', async () => {
    await expect(manager.askClarifyingQuestions('s1')).rejects.toThrow();
  });

  it('calls dispatchContinuation with ASK_CLARIFYING_QUESTIONS_PROMPT when session_id is present', async () => {
    const task = registry.createTask('s1', 'Do the thing', 'sonnet');
    registry.setTaskSessionId(task.id, 'sess-abc');
    registry.completeTaskNeedsHuman(task.id, 'No questions produced', null);
    registry.updateStackStatus('s1', 'needs_human');

    vi.spyOn(manager as unknown as { ensureStackContainersRunning: () => Promise<void> }, 'ensureStackContainersRunning')
      .mockResolvedValue(undefined);
    const dispatchSpy = vi.spyOn(manager as unknown as { dispatchContinuation: () => Promise<void> }, 'dispatchContinuation')
      .mockResolvedValue(undefined);

    await manager.askClarifyingQuestions('s1');

    expect(dispatchSpy).toHaveBeenCalledOnce();
    const callArgs = dispatchSpy.mock.calls[0];
    // Fourth arg is the continuation prompt
    expect(callArgs[3]).toBe(ASK_CLARIFYING_QUESTIONS_PROMPT);
  });

  it('calls dispatchTask with original prompt when no session_id is present (Case B)', async () => {
    const task = registry.createTask('s1', 'Do the thing', 'sonnet');
    // No setTaskSessionId — task has no session_id
    registry.completeTaskNeedsHuman(task.id, 'No questions', null);
    registry.updateStackStatus('s1', 'needs_human');

    vi.spyOn(manager as unknown as { ensureStackContainersRunning: () => Promise<void> }, 'ensureStackContainersRunning')
      .mockResolvedValue(undefined);
    const dispatchSpy = vi.spyOn(manager as unknown as { dispatchTask: () => Promise<void> }, 'dispatchTask')
      .mockResolvedValue(undefined);

    await manager.askClarifyingQuestions('s1');

    expect(dispatchSpy).toHaveBeenCalledOnce();
    const callArgs = dispatchSpy.mock.calls[0];
    expect(callArgs[0]).toBe('s1');
    expect(callArgs[1]).toBe('Do the thing');
    expect(callArgs[3]).toMatchObject({ skipTicketFetch: true });
  });

  it('rolls back stack to needs_human when dispatchTask throws in Case B', async () => {
    const task = registry.createTask('s1', 'Do the thing', 'sonnet');
    // No setTaskSessionId — task has no session_id
    registry.completeTaskNeedsHuman(task.id, 'No questions', null);
    registry.updateStackStatus('s1', 'needs_human');

    vi.spyOn(manager as unknown as { ensureStackContainersRunning: () => Promise<void> }, 'ensureStackContainersRunning')
      .mockResolvedValue(undefined);
    vi.spyOn(manager as unknown as { dispatchTask: () => Promise<void> }, 'dispatchTask')
      .mockRejectedValue(new Error('dispatch failed'));

    await expect(manager.askClarifyingQuestions('s1')).rejects.toThrow('dispatch failed');

    const stack = registry.getStack('s1');
    expect(stack?.status).toBe('needs_human');
  });

  it('is a no-op when already in flight (idempotency guard)', async () => {
    const task = registry.createTask('s1', 'Do the thing', 'sonnet');
    registry.setTaskSessionId(task.id, 'sess-abc');
    registry.completeTaskNeedsHuman(task.id, 'No questions', null);
    registry.updateStackStatus('s1', 'needs_human');

    vi.spyOn(manager as unknown as { ensureStackContainersRunning: () => Promise<void> }, 'ensureStackContainersRunning')
      .mockResolvedValue(undefined);

    let resolve1!: () => void;
    const dispatchSpy = vi.spyOn(manager as unknown as { dispatchContinuation: () => Promise<void> }, 'dispatchContinuation')
      .mockImplementation(() => new Promise<void>((res) => { resolve1 = res; }));

    // First call — in flight
    const p1 = manager.askClarifyingQuestions('s1');
    // Second call while first is in flight — should be no-op
    const p2 = manager.askClarifyingQuestions('s1');

    // p2 resolves immediately (no-op)
    await p2;
    // dispatch should only have been called once (by p1 only)
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    resolve1();
    await p1;
  });
});

describe('StackManager.resumeNeedsHumanStack gate relaxation', () => {
  let registry: Registry;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    const portAllocator = new PortAllocator(registry, [40100, 40199]);
    const taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');

    registry.createStack({
      id: 's1',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'verify_blocked_environmental',
      runtime: 'docker',
    });
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  it('accepts verify_blocked_environmental status without throwing the gate error', async () => {
    const task = registry.createTask('s1', 'Do the thing', 'sonnet');
    registry.setTaskSessionId(task.id, 'sess-abc');
    // Mark task as needs_human so we have a task to resume
    registry.completeTaskNeedsHuman(task.id, 'env blocked', null);
    registry.updateStackStatus('s1', 'verify_blocked_environmental');

    // Mock out container/dispatch so it doesn't actually spawn
    vi.spyOn(manager as unknown as { ensureStackContainersRunning: () => Promise<void> }, 'ensureStackContainersRunning')
      .mockResolvedValue(undefined);
    vi.spyOn(manager as unknown as { dispatchContinuation: () => Promise<void> }, 'dispatchContinuation')
      .mockResolvedValue(undefined);

    // Should not throw "not in a resumable state" error
    await expect(manager.resumeNeedsHumanStack('s1', '')).resolves.toBeUndefined();
  });

  it('still rejects truly invalid statuses', async () => {
    registry.updateStackStatus('s1', 'running');
    const task = registry.createTask('s1', 'task', undefined);
    registry.completeTaskNeedsHuman(task.id, 'reason', null);
    registry.updateStackStatus('s1', 'running');

    await expect(manager.resumeNeedsHumanStack('s1', '')).rejects.toThrow('not in a resumable state');
  });
});
