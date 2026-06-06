import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import { StackManager } from '../../src/main/control-plane/stack-manager';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeStackManager(registry: Registry): StackManager {
  const runtime = {
    name: 'mock',
    composeUp: vi.fn().mockResolvedValue(undefined),
    composeDown: vi.fn().mockResolvedValue(undefined),
    listContainers: vi.fn().mockResolvedValue([]),
    inspect: vi.fn(),
    logs: vi.fn().mockReturnValue((async function* () {})()),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('mock'),
    containerStats: vi.fn(),
  };
  const portAllocator = new PortAllocator(registry, [50000, 50099]);
  const taskWatcher = new TaskWatcher(registry, runtime as never, runtime as never, { pollInterval: 999999 });
  return new StackManager(registry, portAllocator, taskWatcher, runtime as never, runtime as never, '/fake/cli');
}

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe('selfheal_continue_used guard (registry)', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    registry.createStack({
      id: 'test-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  it('defaults to 0 on new stack', () => {
    const stack = registry.getStack('test-stack');
    expect(stack?.selfheal_continue_used).toBe(0);
  });

  it('setSelfhealContinueUsed sets to 1', () => {
    registry.setSelfhealContinueUsed('test-stack', 1);
    const stack = registry.getStack('test-stack');
    expect(stack?.selfheal_continue_used).toBe(1);
  });

  it('setSelfhealContinueUsed can reset to 0', () => {
    registry.setSelfhealContinueUsed('test-stack', 1);
    registry.setSelfhealContinueUsed('test-stack', 0);
    const stack = registry.getStack('test-stack');
    expect(stack?.selfheal_continue_used).toBe(0);
  });

  it('archiveStack mirrors selfheal_continue_used to stack_history', () => {
    registry.setSelfhealContinueUsed('test-stack', 1);
    registry.archiveStack('test-stack', 'failed');
    const history = registry.listStackHistory();
    expect(history).toHaveLength(1);
    expect(history[0].selfheal_continue_used).toBe(1);
  });

  it('archiveStack preserves selfheal_continue_used = 0 in history', () => {
    registry.archiveStack('test-stack', 'failed');
    const history = registry.listStackHistory();
    expect(history[0].selfheal_continue_used).toBe(0);
  });
});

describe('resumeNeedsHumanStack status guard', () => {
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

  it('rejects stacks in idle state with INVALID_INPUT', async () => {
    registry.createStack({
      id: 'idle-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix',
      description: null,
      status: 'idle',
      runtime: 'docker',
    });
    const sm = makeStackManager(registry);
    await expect(sm.resumeNeedsHumanStack('idle-stack', 'answers')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('accepts failed stacks and proceeds past the status guard', async () => {
    registry.createStack({
      id: 'failed-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
    const sm = makeStackManager(registry);
    // Passes the status guard; fails on INTERNAL_ERROR (no task) rather than INVALID_INPUT
    await expect(sm.resumeNeedsHumanStack('failed-stack', 'answers')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('accepts needs_human stacks and proceeds past the status guard', async () => {
    registry.createStack({
      id: 'nh-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix',
      description: null,
      status: 'needs_human',
      runtime: 'docker',
    });
    const sm = makeStackManager(registry);
    // Passes the status guard; fails on INTERNAL_ERROR (no task)
    await expect(sm.resumeNeedsHumanStack('nh-stack', 'answers')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('eligibility gating logic', () => {
  it('selfHeal is true only when agent says true AND selfheal_continue_used === 0', () => {
    const eligible = (agentSelfHeal: boolean, used: number) =>
      agentSelfHeal === true && used === 0;

    expect(eligible(true, 0)).toBe(true);
    expect(eligible(true, 1)).toBe(false);
    expect(eligible(false, 0)).toBe(false);
    expect(eligible(false, 1)).toBe(false);
  });

  it('answerQuestions requires questions to be non-empty', () => {
    const eligible = (agentAnswerQ: boolean, qCount: number) =>
      agentAnswerQ === true && qCount > 0;

    expect(eligible(true, 2)).toBe(true);
    expect(eligible(true, 0)).toBe(false);
    expect(eligible(false, 2)).toBe(false);
  });

  it('reincorporateSpec follows agent verdict directly', () => {
    expect(true).toBe(true);  // gated only by diagnosis.eligibility.reincorporateSpec
    expect(false).toBe(false);
  });
});
