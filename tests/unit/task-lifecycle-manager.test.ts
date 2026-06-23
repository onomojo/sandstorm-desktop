/**
 * T8 — Unit tests for TaskLifecycleManager.
 *
 * Each test exercises one TLM method against a real in-memory Registry and
 * asserts the resulting task + stack status in the DB (the same observable
 * contract the golden-path test relies on).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Registry } from '../../src/main/control-plane/registry';
import { TaskLifecycleManager } from '../../src/main/control-plane/task-lifecycle-manager';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `tlm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function makeStackOpts(id: string, projectDir = '/proj') {
  return {
    id,
    project: 'proj',
    project_dir: projectDir,
    ticket: null as string | null,
    branch: null as string | null,
    description: null as string | null,
    status: 'up' as const,
    runtime: 'docker' as const,
  };
}

describe('TaskLifecycleManager', () => {
  let dbPath: string;
  let registry: Registry;
  let tlm: TaskLifecycleManager;
  let stackId: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    tlm = new TaskLifecycleManager(registry);
    stackId = `test-stack-${Date.now()}`;
    registry.createStack(makeStackOpts(stackId));
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  // ---------------------------------------------------------------------------
  // createTask
  // ---------------------------------------------------------------------------

  it('createTask creates a running task and transitions stack to running', () => {
    const task = tlm.createTask(stackId, 'do the thing');
    expect(task.status).toBe('running');
    expect(task.stack_id).toBe(stackId);
    expect(task.prompt).toBe('do the thing');
    expect(registry.getStack(stackId)?.status).toBe('running');
  });

  it('createTask passes model through', () => {
    const task = tlm.createTask(stackId, 'do the thing', 'claude-opus-4-8');
    expect(task.model).toBe('claude-opus-4-8');
  });

  // ---------------------------------------------------------------------------
  // updateStackStatus
  // ---------------------------------------------------------------------------

  it('updateStackStatus writes the given status', () => {
    tlm.updateStackStatus(stackId, 'building');
    expect(registry.getStack(stackId)?.status).toBe('building');
  });

  it('updateStackStatus writes an error message when provided', () => {
    tlm.updateStackStatus(stackId, 'failed', 'disk full');
    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('failed');
    expect(stack?.error).toBe('disk full');
  });

  // ---------------------------------------------------------------------------
  // markCompleted
  // ---------------------------------------------------------------------------

  it('markCompleted with exit 0 sets task=completed, stack=completed', () => {
    const task = tlm.createTask(stackId, 'work');
    tlm.markCompleted(task.id, 0);
    expect(registry.getMostRecentTask(stackId)?.status).toBe('completed');
    expect(registry.getMostRecentTask(stackId)?.exit_code).toBe(0);
    expect(registry.getStack(stackId)?.status).toBe('completed');
  });

  it('markCompleted with exit 1 sets task=failed, stack=failed', () => {
    const task = tlm.createTask(stackId, 'work');
    tlm.markCompleted(task.id, 1);
    expect(registry.getMostRecentTask(stackId)?.status).toBe('failed');
    expect(registry.getStack(stackId)?.status).toBe('failed');
  });

  // ---------------------------------------------------------------------------
  // markNeedsHuman
  // ---------------------------------------------------------------------------

  it('markNeedsHuman sets task=needs_human, stack=needs_human', () => {
    const task = tlm.createTask(stackId, 'work');
    tlm.markNeedsHuman(task.id, 'agent asked a question');
    const t = registry.getMostRecentTask(stackId);
    expect(t?.status).toBe('needs_human');
    expect(t?.warnings).toBe('agent asked a question');
    expect(registry.getStack(stackId)?.status).toBe('needs_human');
  });

  it('markNeedsHuman stores questionsJson', () => {
    const task = tlm.createTask(stackId, 'work');
    const q = JSON.stringify([{ id: 'q1', question: 'Which approach?' }]);
    tlm.markNeedsHuman(task.id, 'reason', q);
    expect(registry.getMostRecentTask(stackId)?.needs_human_questions).toBe(q);
  });

  // ---------------------------------------------------------------------------
  // markNeedsKey
  // ---------------------------------------------------------------------------

  it('markNeedsKey sets task=needs_key, stack=needs_key', () => {
    const task = tlm.createTask(stackId, 'work');
    tlm.markNeedsKey(task.id, 'missing anthropic key');
    const t = registry.getMostRecentTask(stackId);
    expect(t?.status).toBe('needs_key');
    expect(t?.warnings).toBe('missing anthropic key');
    expect(registry.getStack(stackId)?.status).toBe('needs_key');
  });

  // ---------------------------------------------------------------------------
  // markVerifyBlockedEnvironmental
  // ---------------------------------------------------------------------------

  it('markVerifyBlockedEnvironmental sets task=needs_human, stack=verify_blocked_environmental', () => {
    const task = tlm.createTask(stackId, 'work');
    tlm.markVerifyBlockedEnvironmental(task.id, 'permission denied');
    const t = registry.getMostRecentTask(stackId);
    expect(t?.status).toBe('needs_human');
    expect(t?.warnings).toBe('permission denied');
    expect(registry.getStack(stackId)?.status).toBe('verify_blocked_environmental');
  });

  // ---------------------------------------------------------------------------
  // markPrCreated
  // ---------------------------------------------------------------------------

  it('markPrCreated sets pr_url, pr_number, and transitions stack to pr_created', () => {
    tlm.updateStackStatus(stackId, 'completed');
    tlm.markPrCreated(stackId, 'https://github.com/acme/repo/pull/7', 7);
    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('pr_created');
    expect(stack?.pr_url).toBe('https://github.com/acme/repo/pull/7');
    expect(stack?.pr_number).toBe(7);
  });

  it('markPrCreated throws if stack not found', () => {
    expect(() => tlm.markPrCreated('nonexistent', 'url', 1)).toThrow(/not found/);
  });

  // ---------------------------------------------------------------------------
  // markInterrupted
  // ---------------------------------------------------------------------------

  it('markInterrupted transitions a running task to interrupted', () => {
    const task = tlm.createTask(stackId, 'work');
    tlm.markInterrupted(task.id);
    expect(registry.getMostRecentTask(stackId)?.status).toBe('interrupted');
  });

  it('markInterrupted is a no-op if task is not running', () => {
    const task = tlm.createTask(stackId, 'work');
    tlm.markCompleted(task.id, 0);
    // Should not throw; task stays completed
    tlm.markInterrupted(task.id);
    expect(registry.getMostRecentTask(stackId)?.status).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // markReopened
  // ---------------------------------------------------------------------------

  it('markReopened transitions a completed task back to running', () => {
    const task = tlm.createTask(stackId, 'work');
    tlm.markCompleted(task.id, 0);
    tlm.markReopened(task.id);
    expect(registry.getMostRecentTask(stackId)?.status).toBe('running');
    expect(registry.getMostRecentTask(stackId)?.exit_code).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // markResumedAt
  // ---------------------------------------------------------------------------

  it('markResumedAt stamps resumed_at on the task', () => {
    const task = tlm.createTask(stackId, 'work');
    const ts = '2026-06-23T12:00:00.000Z';
    tlm.markResumedAt(task.id, ts);
    expect(registry.getMostRecentTask(stackId)?.resumed_at).toBe(ts);
  });
});
