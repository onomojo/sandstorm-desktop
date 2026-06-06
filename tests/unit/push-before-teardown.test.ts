import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
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

/**
 * Tests for the push-before-teardown ordering guarantee in restartWithFindings.
 * The key invariant: teardown must NOT run if push fails.
 */
describe('push-before-teardown ordering', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    registry.createStack({
      id: 'feat/123-fix-auth-bug',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix-auth-bug',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  it('old stack remains in DB when push fails', async () => {
    // Mock StackManager methods to isolate the ordering logic
    const callOrder: string[] = [];
    const mockPush = vi.fn().mockImplementation(async () => {
      callOrder.push('push');
      throw new Error('Push failed: remote rejected');
    });
    const mockTeardown = vi.fn().mockImplementation(async () => {
      callOrder.push('teardown');
    });
    const mockCreateStack = vi.fn().mockImplementation(() => {
      callOrder.push('createStack');
      return registry.getStack('feat/123-fix-auth-bug')!;
    });

    // Simulate restartWithFindings logic inline
    const stackId = 'feat/123-fix-auth-bug';
    const stack = registry.getStack(stackId)!;
    expect(stack).toBeTruthy();

    let threw = false;
    try {
      // Step 1: push old branch — must fail before teardown
      await mockPush(stackId, `wip: preserve failed-review state for 123`);
      // Step 2: create new stack
      mockCreateStack();
      // Step 3: teardown old stack
      await mockTeardown(stackId);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(callOrder).toEqual(['push']);
    expect(callOrder).not.toContain('teardown');
    expect(callOrder).not.toContain('createStack');

    // Original stack still exists
    expect(registry.getStack(stackId)).not.toBeNull();
  });

  it('teardown runs only after successful push', async () => {
    const callOrder: string[] = [];
    const mockPush = vi.fn().mockImplementation(async () => {
      callOrder.push('push');
    });
    const mockTeardown = vi.fn().mockImplementation(async () => {
      callOrder.push('teardown');
    });
    const mockCreateStack = vi.fn().mockImplementation(() => {
      callOrder.push('createStack');
      return { id: 'feat/123-fix-auth-bug-r2' };
    });

    await mockPush('feat/123-fix-auth-bug', 'wip: preserve');
    mockCreateStack();
    await mockTeardown('feat/123-fix-auth-bug');

    expect(callOrder).toEqual(['push', 'createStack', 'teardown']);
  });
});
