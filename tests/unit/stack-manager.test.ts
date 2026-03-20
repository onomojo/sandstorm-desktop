import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StackManager, sanitizeComposeName } from '../../src/main/control-plane/stack-manager';
import { Registry } from '../../src/main/control-plane/registry';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { ContainerRuntime } from '../../src/main/runtime/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function createMockRuntime(): ContainerRuntime {
  return {
    name: 'mock',
    composeUp: vi.fn().mockResolvedValue(undefined),
    composeDown: vi.fn().mockResolvedValue(undefined),
    listContainers: vi.fn().mockResolvedValue([
      {
        id: 'claude-container-1',
        name: 'sandstorm-proj-test-stack-claude-1',
        image: 'sandstorm-claude',
        status: 'running' as const,
        state: 'running',
        ports: [],
        labels: {},
        created: new Date().toISOString(),
      },
    ]),
    inspect: vi.fn(),
    logs: vi.fn(),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
  };
}

function makeStack(id: string = 'test-stack') {
  return {
    id,
    project: 'proj',
    project_dir: '/proj',
    ticket: null,
    branch: null,
    description: null,
    status: 'up' as const,
    runtime: 'docker' as const,
  };
}

describe('sanitizeComposeName', () => {
  it('passes through valid names unchanged', () => {
    expect(sanitizeComposeName('auth-refactor')).toBe('auth-refactor');
    expect(sanitizeComposeName('my_stack')).toBe('my_stack');
    expect(sanitizeComposeName('test123')).toBe('test123');
  });

  it('converts spaces to hyphens', () => {
    expect(sanitizeComposeName('my stack')).toBe('my-stack');
    expect(sanitizeComposeName('my  big  stack')).toBe('my-big-stack');
  });

  it('lowercases the input', () => {
    expect(sanitizeComposeName('MyStack')).toBe('mystack');
    expect(sanitizeComposeName('AUTH-REFACTOR')).toBe('auth-refactor');
  });

  it('strips special characters', () => {
    expect(sanitizeComposeName('my@stack!')).toBe('mystack');
    expect(sanitizeComposeName('stack#1$2%3')).toBe('stack123');
  });

  it('handles names starting with numbers', () => {
    expect(sanitizeComposeName('123stack')).toBe('s123stack');
  });

  it('handles names starting with hyphens', () => {
    expect(sanitizeComposeName('--my-stack')).toBe('my-stack');
  });

  it('strips trailing hyphens', () => {
    expect(sanitizeComposeName('my-stack--')).toBe('my-stack');
  });

  it('collapses repeated hyphens', () => {
    expect(sanitizeComposeName('my---stack')).toBe('my-stack');
  });

  it('returns "stack" for empty or all-invalid input', () => {
    expect(sanitizeComposeName('')).toBe('stack');
    expect(sanitizeComposeName('!!!')).toBe('stack');
    expect(sanitizeComposeName('   ')).toBe('stack');
  });

  it('handles mixed problematic input', () => {
    expect(sanitizeComposeName('My Cool Stack!!')).toBe('my-cool-stack');
    expect(sanitizeComposeName('  --test@name-- ')).toBe('testname');
  });
});

describe('StackManager', () => {
  let registry: Registry;
  let portAllocator: PortAllocator;
  let taskWatcher: TaskWatcher;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    portAllocator = new PortAllocator(registry, [40000, 40099]);
    taskWatcher = new TaskWatcher(registry, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, '/fake/cli');
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    cleanupDb(dbPath);
  });

  describe('createStack', () => {
    let tmpDir: string;

    beforeEach(() => {
      const { execSync } = require('child_process');

      // Create a bare repo to serve as a local "remote"
      const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-bare-'));
      execSync('git init --bare', { cwd: bareDir, stdio: 'ignore' });

      // Create the project dir as a clone of the bare repo
      tmpDir = path.join(os.tmpdir(), `sandstorm-proj-${Date.now()}`);
      execSync(`git clone "${bareDir}" "${tmpDir}"`, { stdio: 'ignore' });

      // Create sandstorm config and make an initial commit so the branch exists
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(path.join(sandstormDir, 'config'), 'PORT_MAP="app:8080:3000:0"\n');
      execSync('git add -A && git commit -m "init" && git push origin HEAD', {
        cwd: tmpDir,
        stdio: 'ignore',
        env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
      });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns stack immediately with building status', () => {
      // Mock runCli so it doesn't actually call the CLI
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const stack = manager.createStack({
        name: 'imm-test',
        projectDir: tmpDir,
        runtime: 'docker',
      });

      expect(stack).toBeDefined();
      expect(stack.id).toBe('imm-test');
      expect(stack.status).toBe('building');
    });

    it('transitions to up status after background build completes', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      manager.createStack({
        name: 'fk-test',
        projectDir: tmpDir,
        runtime: 'docker',
      });

      // Wait for the background build to finish
      await vi.waitFor(() => {
        const stack = registry.getStack('fk-test');
        expect(stack!.status).toBe('up');
      }, { timeout: 5000 });

      // Ports should have been allocated after stack creation (FK: stack exists first)
      const ports = registry.getPorts('fk-test');
      expect(ports).toHaveLength(1);
      expect(ports[0].container_port).toBe(3000);
    });

    it('creates a stack with optional fields', () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'config'), '# no ports\n');

      const stack = manager.createStack({
        name: 'opts-test',
        projectDir: tmpDir,
        ticket: 'JIRA-123',
        description: 'testing options',
        runtime: 'docker',
      });

      expect(stack.ticket).toBe('JIRA-123');
      expect(stack.branch).toBeNull();
      expect(stack.description).toBe('testing options');
    });

    it('marks stack as failed with error message when CLI returns non-zero', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: 'compose failed',
        exitCode: 1,
      });

      fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'config'), '# empty\n');

      manager.createStack({ name: 'fail-test', projectDir: tmpDir, runtime: 'docker' });

      // Wait for background build to fail
      await vi.waitFor(() => {
        const stack = registry.getStack('fail-test');
        expect(stack!.status).toBe('failed');
        expect(stack!.error).toBe('compose failed');
      }, { timeout: 5000 });
    });

    it('passes port env vars and stack args to CLI', async () => {
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      manager.createStack({
        name: 'env-test',
        projectDir: tmpDir,
        ticket: 'PROJ-1',
        branch: 'feature/test',
        runtime: 'docker',
      });

      await vi.waitFor(() => {
        const stack = registry.getStack('env-test');
        expect(stack!.status).toBe('up');
      }, { timeout: 5000 });

      expect(runCliSpy).toHaveBeenCalled();
      const [dir, args, env] = runCliSpy.mock.calls[0];
      expect(dir).toBe(tmpDir);
      expect(args).toContain('up');
      expect(args).toContain('env-test');
      expect(args).toContain('--ticket');
      expect(args).toContain('PROJ-1');
      expect(args).toContain('--branch');
      expect(args).toContain('feature/test');
      expect(env).toHaveProperty('SANDSTORM_PORT_app_0');
    });

    it('calls onStackUpdate callback when build completes', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      const updateCallback = vi.fn();
      manager.setOnStackUpdate(updateCallback);

      manager.createStack({
        name: 'cb-test',
        projectDir: tmpDir,
        runtime: 'docker',
      });

      await vi.waitFor(() => {
        expect(updateCallback).toHaveBeenCalled();
      }, { timeout: 5000 });
    });
  });

  describe('dispatchTask', () => {
    it('dispatches a task via CLI to a stack', async () => {
      registry.createStack(makeStack('dispatch-test'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'Task dispatched.',
        stderr: '',
        exitCode: 0,
      });

      const task = await manager.dispatchTask('dispatch-test', 'Fix the bug');
      expect(task.prompt).toBe('Fix the bug');
      expect(task.status).toBe('running');

      // Should delegate to CLI `task` command (handles cred sync + user perms)
      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['task', 'dispatch-test', 'Fix the bug']
      );
    });

    it('throws when dispatching to non-existent stack', async () => {
      await expect(
        manager.dispatchTask('nonexistent', 'task')
      ).rejects.toThrow('not found');
    });

    it('throws when CLI task dispatch fails', async () => {
      registry.createStack(makeStack('cli-fail'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: 'credential sync failed',
        exitCode: 1,
      });

      await expect(
        manager.dispatchTask('cli-fail', 'task')
      ).rejects.toThrow('credential sync failed');
    });

    it('throws when no claude container found', async () => {
      registry.createStack(makeStack('no-claude'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      await expect(
        manager.dispatchTask('no-claude', 'task')
      ).rejects.toThrow('Claude container not found');
    });
  });

  describe('teardownStack', () => {
    it('deletes stack from registry immediately', () => {
      registry.createStack(makeStack('teardown-test'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      manager.teardownStack('teardown-test');
      // Stack should be gone immediately (not just marked as stopped)
      expect(registry.getStack('teardown-test')).toBeUndefined();
    });

    it('calls CLI down in background for Docker cleanup', async () => {
      registry.createStack(makeStack('teardown-bg'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      manager.teardownStack('teardown-bg');

      await vi.waitFor(() => {
        expect(runCliSpy).toHaveBeenCalledWith(
          '/proj',
          ['down', 'teardown-bg']
        );
      }, { timeout: 5000 });
    });

    it('throws when tearing down non-existent stack', () => {
      expect(() => manager.teardownStack('ghost')).toThrow('not found');
    });

    it('best-effort teardown even if CLI fails', async () => {
      registry.createStack(makeStack('compose-fail'));
      vi.spyOn(manager, 'runCli').mockRejectedValueOnce(new Error('cli error'));

      // Should not throw — best effort
      manager.teardownStack('compose-fail');
      expect(registry.getStack('compose-fail')).toBeUndefined();
    });

    it('calls onStackUpdate callback during teardown', () => {
      const updateCallback = vi.fn();
      manager.setOnStackUpdate(updateCallback);
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      registry.createStack(makeStack('cb-teardown'));
      manager.teardownStack('cb-teardown');

      // Should be called when stack is deleted
      expect(updateCallback).toHaveBeenCalled();
    });
  });

  describe('getTasksForStack', () => {
    it('retrieves tasks for a stack', () => {
      registry.createStack(makeStack('task-test'));
      registry.createTask('task-test', 'Task 1');
      registry.createTask('task-test', 'Task 2');

      const tasks = manager.getTasksForStack('task-test');
      expect(tasks).toHaveLength(2);
    });

    it('returns empty array for stack with no tasks', () => {
      registry.createStack(makeStack('empty-tasks'));
      expect(manager.getTasksForStack('empty-tasks')).toEqual([]);
    });
  });

  describe('getDiff', () => {
    it('gets diff via CLI', async () => {
      registry.createStack(makeStack('diff-test'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'diff --git a/file.txt b/file.txt\n+new line',
        stderr: '',
        exitCode: 0,
      });

      const diff = await manager.getDiff('diff-test');
      expect(diff).toContain('+new line');
    });

    it('throws for non-existent stack', async () => {
      await expect(manager.getDiff('ghost')).rejects.toThrow('not found');
    });
  });

  describe('getStackWithServices', () => {
    it('returns stack with services', async () => {
      registry.createStack(makeStack('svc-test'));

      const result = await manager.getStackWithServices('svc-test');
      expect(result).toBeDefined();
      expect(result!.id).toBe('svc-test');
      expect(result!.services).toBeDefined();
      expect(Array.isArray(result!.services)).toBe(true);
    });

    it('returns undefined for non-existent stack', async () => {
      const result = await manager.getStackWithServices('ghost');
      expect(result).toBeUndefined();
    });
  });

  describe('listStacksWithServices', () => {
    it('returns all stacks with services', async () => {
      registry.createStack(makeStack('list-1'));
      registry.createStack(makeStack('list-2'));

      const results = await manager.listStacksWithServices();
      expect(results).toHaveLength(2);
      expect(results[0].services).toBeDefined();
    });

    it('returns empty array when no stacks', async () => {
      const results = await manager.listStacksWithServices();
      expect(results).toEqual([]);
    });
  });

  describe('push', () => {
    it('throws for non-existent stack', async () => {
      await expect(manager.push('ghost')).rejects.toThrow('not found');
    });

    it('calls CLI push with stack ID', async () => {
      registry.createStack(makeStack('push-test'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'Done!',
        stderr: '',
        exitCode: 0,
      });

      await manager.push('push-test', 'my commit message');

      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['push', 'push-test', 'my commit message']
      );
    });

    it('throws when CLI push fails', async () => {
      registry.createStack(makeStack('push-fail'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: 'push failed: no remote',
        exitCode: 1,
      });

      await expect(manager.push('push-fail')).rejects.toThrow('push failed: no remote');
    });
  });
});
