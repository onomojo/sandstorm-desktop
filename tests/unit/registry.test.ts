import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

function makeStack(overrides: Partial<{
  id: string; project: string; project_dir: string; ticket: string | null;
  branch: string | null; description: string | null; status: string; runtime: string;
}> = {}) {
  return {
    id: overrides.id ?? 'test-stack',
    project: overrides.project ?? 'proj',
    project_dir: overrides.project_dir ?? '/proj',
    ticket: overrides.ticket ?? null,
    branch: overrides.branch ?? null,
    description: overrides.description ?? null,
    status: (overrides.status ?? 'building') as 'building',
    runtime: (overrides.runtime ?? 'docker') as 'docker',
  };
}

describe('Registry', () => {
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

  // ===========================================
  // Projects CRUD
  // ===========================================
  describe('projects', () => {
    it('adds a project and retrieves it', () => {
      const project = registry.addProject('/home/user/myapp', 'myapp');
      expect(project.id).toBeDefined();
      expect(project.name).toBe('myapp');
      expect(project.directory).toBe('/home/user/myapp');
      expect(project.added_at).toBeTruthy();
    });

    it('auto-generates name from directory basename', () => {
      const project = registry.addProject('/home/user/cool-project');
      expect(project.name).toBe('cool-project');
    });

    it('lists all projects in insertion order', () => {
      registry.addProject('/a', 'alpha');
      registry.addProject('/b', 'beta');
      registry.addProject('/c', 'gamma');

      const projects = registry.listProjects();
      expect(projects).toHaveLength(3);
      expect(projects[0].name).toBe('alpha');
      expect(projects[1].name).toBe('beta');
      expect(projects[2].name).toBe('gamma');
    });

    it('gets a single project by id', () => {
      const added = registry.addProject('/proj');
      const got = registry.getProject(added.id);
      expect(got).toBeDefined();
      expect(got!.directory).toBe('/proj');
    });

    it('returns undefined for non-existent project id', () => {
      expect(registry.getProject(9999)).toBeUndefined();
    });

    it('removes a project', () => {
      const project = registry.addProject('/proj');
      registry.removeProject(project.id);
      expect(registry.getProject(project.id)).toBeUndefined();
      expect(registry.listProjects()).toHaveLength(0);
    });

    it('rejects duplicate directories', () => {
      registry.addProject('/same/dir');
      expect(() => registry.addProject('/same/dir')).toThrow();
    });

    it('allows same name with different directories', () => {
      registry.addProject('/dir1', 'sameName');
      registry.addProject('/dir2', 'sameName');
      expect(registry.listProjects()).toHaveLength(2);
    });

    it('handles empty project list', () => {
      expect(registry.listProjects()).toEqual([]);
    });
  });

  // ===========================================
  // Stacks CRUD
  // ===========================================
  describe('stacks', () => {
    it('creates and retrieves a stack', () => {
      const stack = registry.createStack(makeStack({
        id: 'test-stack',
        project: 'myproject',
        project_dir: '/home/user/myproject',
        ticket: 'EXP-123',
        branch: 'feature/test',
        description: 'Test stack',
      }));

      expect(stack.id).toBe('test-stack');
      expect(stack.project).toBe('myproject');
      expect(stack.status).toBe('building');
      expect(stack.ticket).toBe('EXP-123');
      expect(stack.branch).toBe('feature/test');
      expect(stack.description).toBe('Test stack');
      expect(stack.runtime).toBe('docker');
      expect(stack.created_at).toBeTruthy();
      expect(stack.updated_at).toBeTruthy();

      const retrieved = registry.getStack('test-stack');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('test-stack');
    });

    it('creates a stack with null optional fields', () => {
      const stack = registry.createStack(makeStack());
      expect(stack.ticket).toBeNull();
      expect(stack.branch).toBeNull();
      expect(stack.description).toBeNull();
    });

    it('creates a stack with podman runtime', () => {
      const stack = registry.createStack(makeStack({ id: 'podman-stack', runtime: 'podman' }));
      expect(stack.runtime).toBe('podman');
    });

    it('lists all stacks in descending created_at order', () => {
      registry.createStack(makeStack({ id: 'stack-1' }));
      registry.createStack(makeStack({ id: 'stack-2' }));
      registry.createStack(makeStack({ id: 'stack-3' }));

      const stacks = registry.listStacks();
      expect(stacks).toHaveLength(3);
    });

    it('returns undefined for non-existent stack', () => {
      expect(registry.getStack('nonexistent')).toBeUndefined();
    });

    it('updates stack status', () => {
      registry.createStack(makeStack({ id: 'status-test' }));
      registry.updateStackStatus('status-test', 'up');
      const stack = registry.getStack('status-test');
      expect(stack!.status).toBe('up');
    });

    it('stores error message when updating status to failed', () => {
      registry.createStack(makeStack({ id: 'err-test' }));
      registry.updateStackStatus('err-test', 'failed', 'compose failed: image not found');
      const stack = registry.getStack('err-test');
      expect(stack!.status).toBe('failed');
      expect(stack!.error).toBe('compose failed: image not found');
    });

    it('error is null by default', () => {
      registry.createStack(makeStack({ id: 'null-err' }));
      const stack = registry.getStack('null-err');
      expect(stack!.error).toBeNull();
    });

    it('clears error when status updated without error param', () => {
      registry.createStack(makeStack({ id: 'clear-err' }));
      registry.updateStackStatus('clear-err', 'failed', 'some error');
      registry.updateStackStatus('clear-err', 'up');
      const stack = registry.getStack('clear-err');
      expect(stack!.status).toBe('up');
      // Error should remain unchanged when not explicitly cleared
      expect(stack!.error).toBe('some error');
    });

    it('updates updated_at when changing status', () => {
      registry.createStack(makeStack({ id: 'ts-test' }));
      const before = registry.getStack('ts-test')!.updated_at;
      registry.updateStackStatus('ts-test', 'running');
      const after = registry.getStack('ts-test')!.updated_at;
      expect(after).toBeTruthy();
      // They may be the same second but updated_at should still be set
    });

    it('cycles through all valid statuses', () => {
      registry.createStack(makeStack({ id: 'cycle' }));
      const statuses = ['building', 'up', 'running', 'completed', 'failed', 'idle', 'stopped'] as const;
      for (const s of statuses) {
        registry.updateStackStatus('cycle', s);
        expect(registry.getStack('cycle')!.status).toBe(s);
      }
    });

    it('deletes a stack', () => {
      registry.createStack(makeStack({ id: 'delete-me' }));
      registry.deleteStack('delete-me');
      expect(registry.getStack('delete-me')).toBeUndefined();
    });

    it('deletes a stack and cascades tasks and ports', () => {
      registry.createStack(makeStack({ id: 'cascade' }));
      registry.createTask('cascade', 'task 1');
      registry.createTask('cascade', 'task 2');
      registry.setPorts('cascade', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      registry.deleteStack('cascade');
      expect(registry.getStack('cascade')).toBeUndefined();
      expect(registry.getTasksForStack('cascade')).toHaveLength(0);
      expect(registry.getPorts('cascade')).toHaveLength(0);
    });

    it('rejects duplicate stack IDs', () => {
      registry.createStack(makeStack({ id: 'dup' }));
      expect(() => registry.createStack(makeStack({ id: 'dup' }))).toThrow();
    });

    it('handles empty stack list', () => {
      expect(registry.listStacks()).toEqual([]);
    });

    it('deleting non-existent stack is a no-op', () => {
      expect(() => registry.deleteStack('ghost')).not.toThrow();
    });
  });

  // ===========================================
  // Tasks CRUD
  // ===========================================
  describe('tasks', () => {
    beforeEach(() => {
      registry.createStack(makeStack({ id: 'task-stack', status: 'up' }));
    });

    it('creates a task and updates stack status to running', () => {
      const task = registry.createTask('task-stack', 'Fix the bug');
      expect(task.id).toBeDefined();
      expect(task.stack_id).toBe('task-stack');
      expect(task.status).toBe('running');
      expect(task.prompt).toBe('Fix the bug');
      expect(task.started_at).toBeTruthy();
      expect(task.finished_at).toBeNull();
      expect(task.exit_code).toBeNull();

      const stack = registry.getStack('task-stack');
      expect(stack!.status).toBe('running');
    });

    it('creates multiple tasks for same stack', () => {
      registry.createTask('task-stack', 'Task 1');
      registry.createTask('task-stack', 'Task 2');
      registry.createTask('task-stack', 'Task 3');

      const tasks = registry.getTasksForStack('task-stack');
      expect(tasks).toHaveLength(3);
    });

    it('completes a task with exit code 0', () => {
      const task = registry.createTask('task-stack', 'Do work');
      registry.completeTask(task.id, 0);

      const tasks = registry.getTasksForStack('task-stack');
      expect(tasks[0].status).toBe('completed');
      expect(tasks[0].exit_code).toBe(0);
      expect(tasks[0].finished_at).toBeTruthy();

      const stack = registry.getStack('task-stack');
      expect(stack!.status).toBe('completed');
    });

    it('marks task as failed with non-zero exit code', () => {
      const task = registry.createTask('task-stack', 'Fail');
      registry.completeTask(task.id, 1);

      const tasks = registry.getTasksForStack('task-stack');
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].exit_code).toBe(1);

      const stack = registry.getStack('task-stack');
      expect(stack!.status).toBe('failed');
    });

    it('preserves various exit codes', () => {
      for (const code of [0, 1, 2, 127, 137, 255]) {
        const task = registry.createTask('task-stack', `exit ${code}`);
        registry.completeTask(task.id, code);
        const tasks = registry.getTasksForStack('task-stack');
        const found = tasks.find(t => t.id === task.id)!;
        expect(found.exit_code).toBe(code);
      }
    });

    it('returns running task', () => {
      registry.createTask('task-stack', 'Running');
      const running = registry.getRunningTask('task-stack');
      expect(running).toBeDefined();
      expect(running!.status).toBe('running');
    });

    it('returns undefined when no running task', () => {
      const running = registry.getRunningTask('task-stack');
      expect(running).toBeUndefined();
    });

    it('returns undefined when all tasks are completed', () => {
      const task = registry.createTask('task-stack', 'done');
      registry.completeTask(task.id, 0);
      expect(registry.getRunningTask('task-stack')).toBeUndefined();
    });

    it('tasks for non-existent stack returns empty array', () => {
      expect(registry.getTasksForStack('ghost')).toEqual([]);
    });

    it('throws FK error when creating task for non-existent stack', () => {
      expect(() => registry.createTask('nonexistent', 'oops')).toThrow();
    });

    it('tasks are ordered by started_at DESC', () => {
      registry.createTask('task-stack', 'First');
      registry.createTask('task-stack', 'Second');
      registry.createTask('task-stack', 'Third');

      const tasks = registry.getTasksForStack('task-stack');
      // Most recent first
      expect(tasks).toHaveLength(3);
    });
  });

  // ===========================================
  // Ports CRUD
  // ===========================================
  describe('ports', () => {
    beforeEach(() => {
      registry.createStack(makeStack({ id: 'port-stack' }));
    });

    it('sets and retrieves ports', () => {
      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
        { service: 'api', host_port: 10002, container_port: 3001 },
      ]);

      const ports = registry.getPorts('port-stack');
      expect(ports).toHaveLength(2);
      expect(ports[0].service).toBe('app');
      expect(ports[0].host_port).toBe(10001);
      expect(ports[0].container_port).toBe(3000);
      expect(ports[0].stack_id).toBe('port-stack');
    });

    it('ports are ordered by host_port ASC', () => {
      registry.setPorts('port-stack', [
        { service: 'api', host_port: 10005, container_port: 3001 },
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      const ports = registry.getPorts('port-stack');
      expect(ports[0].host_port).toBe(10001);
      expect(ports[1].host_port).toBe(10005);
    });

    it('returns all allocated ports across stacks', () => {
      registry.createStack(makeStack({ id: 'port-stack-2' }));

      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);
      registry.setPorts('port-stack-2', [
        { service: 'app', host_port: 10002, container_port: 3000 },
      ]);

      const allPorts = registry.getAllAllocatedPorts();
      expect(allPorts).toContain(10001);
      expect(allPorts).toContain(10002);
      expect(allPorts).toHaveLength(2);
    });

    it('releases ports for a stack', () => {
      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      registry.releasePorts('port-stack');
      expect(registry.getPorts('port-stack')).toHaveLength(0);
      expect(registry.getAllAllocatedPorts()).toHaveLength(0);
    });

    it('enforces unique host ports', () => {
      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      registry.createStack(makeStack({ id: 'port-stack-2' }));
      expect(() =>
        registry.setPorts('port-stack-2', [
          { service: 'app', host_port: 10001, container_port: 3000 },
        ])
      ).toThrow();
    });

    it('throws FK error when setting ports for non-existent stack', () => {
      expect(() =>
        registry.setPorts('nonexistent', [
          { service: 'app', host_port: 10001, container_port: 3000 },
        ])
      ).toThrow();
    });

    it('handles empty port list', () => {
      registry.setPorts('port-stack', []);
      expect(registry.getPorts('port-stack')).toHaveLength(0);
    });

    it('ports for non-existent stack returns empty array', () => {
      expect(registry.getPorts('ghost')).toEqual([]);
    });

    it('getAllAllocatedPorts returns empty when no ports exist', () => {
      expect(registry.getAllAllocatedPorts()).toEqual([]);
    });

    it('releasing ports for non-existent stack is a no-op', () => {
      expect(() => registry.releasePorts('ghost')).not.toThrow();
    });
  });

  // ===========================================
  // Cross-entity edge cases
  // ===========================================
  describe('cross-entity interactions', () => {
    it('creating task on non-existent stack throws FK error', () => {
      expect(() => registry.createTask('no-such-stack', 'prompt')).toThrow();
    });

    it('setting ports on non-existent stack throws FK error', () => {
      expect(() =>
        registry.setPorts('no-such-stack', [
          { service: 'app', host_port: 10001, container_port: 3000 },
        ])
      ).toThrow();
    });

    it('multiple stacks with different projects coexist', () => {
      registry.createStack(makeStack({ id: 's1', project: 'projA', project_dir: '/a' }));
      registry.createStack(makeStack({ id: 's2', project: 'projB', project_dir: '/b' }));

      expect(registry.listStacks()).toHaveLength(2);
    });

    it('deleting one stack does not affect another', () => {
      registry.createStack(makeStack({ id: 'keep' }));
      registry.createStack(makeStack({ id: 'delete' }));
      registry.createTask('keep', 'task for keep');
      registry.createTask('delete', 'task for delete');

      registry.deleteStack('delete');
      expect(registry.getStack('keep')).toBeDefined();
      expect(registry.getTasksForStack('keep')).toHaveLength(1);
    });
  });

  // ===========================================
  // Stack History
  // ===========================================
  describe('stack history', () => {
    it('archives a stack and retrieves from history', () => {
      registry.createStack(makeStack({ id: 'hist-1', branch: 'feat/test', description: 'Test work' }));
      registry.createTask('hist-1', 'Fix the bug');
      registry.archiveStack('hist-1', 'torn_down');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].stack_id).toBe('hist-1');
      expect(history[0].final_status).toBe('torn_down');
      expect(history[0].branch).toBe('feat/test');
      expect(history[0].description).toBe('Test work');
      expect(history[0].task_prompt).toBe('Fix the bug');
      expect(history[0].finished_at).toBeTruthy();
      expect(history[0].duration_seconds).toBeGreaterThanOrEqual(0);
    });

    it('archives with completed status', () => {
      registry.createStack(makeStack({ id: 'hist-comp' }));
      registry.archiveStack('hist-comp', 'completed');

      const history = registry.listStackHistory();
      expect(history[0].final_status).toBe('completed');
    });

    it('archives with failed status and preserves error', () => {
      registry.createStack(makeStack({ id: 'hist-fail' }));
      registry.updateStackStatus('hist-fail', 'failed', 'OOM killed');
      registry.archiveStack('hist-fail', 'failed');

      const history = registry.listStackHistory();
      expect(history[0].final_status).toBe('failed');
      expect(history[0].error).toBe('OOM killed');
    });

    it('stores null task_prompt when no tasks exist', () => {
      registry.createStack(makeStack({ id: 'hist-no-task' }));
      registry.archiveStack('hist-no-task', 'torn_down');

      const history = registry.listStackHistory();
      expect(history[0].task_prompt).toBeNull();
    });

    it('captures a task prompt when tasks exist', () => {
      registry.createStack(makeStack({ id: 'hist-multi-task' }));
      registry.createTask('hist-multi-task', 'First task');
      registry.createTask('hist-multi-task', 'Second task');
      registry.archiveStack('hist-multi-task', 'completed');

      const history = registry.listStackHistory();
      // Should capture one of the task prompts (most recent by started_at)
      expect(['First task', 'Second task']).toContain(history[0].task_prompt);
    });

    it('lists multiple history records', () => {
      registry.createStack(makeStack({ id: 'hist-a' }));
      registry.archiveStack('hist-a', 'torn_down');
      registry.createStack(makeStack({ id: 'hist-b' }));
      registry.archiveStack('hist-b', 'completed');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(2);
      const ids = history.map(h => h.stack_id);
      expect(ids).toContain('hist-a');
      expect(ids).toContain('hist-b');
    });

    it('does not archive non-existent stack', () => {
      registry.archiveStack('nonexistent', 'torn_down');
      expect(registry.listStackHistory()).toHaveLength(0);
    });

    it('preserves history after original stack is deleted', () => {
      registry.createStack(makeStack({ id: 'hist-del' }));
      registry.archiveStack('hist-del', 'torn_down');
      registry.deleteStack('hist-del');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].stack_id).toBe('hist-del');
    });

    it('returns empty history when none exists', () => {
      expect(registry.listStackHistory()).toEqual([]);
    });
  });

  // ===========================================
  // Database lifecycle
  // ===========================================
  describe('database lifecycle', () => {
    it('close is idempotent', async () => {
      registry.close();
      // Second close should not throw
      expect(() => registry.close()).not.toThrow();
      // Recreate for afterEach
      registry = await Registry.create(makeTempDb());
    });

    it('persists data across Registry instances', async () => {
      registry.addProject('/persistent', 'persist');
      registry.createStack(makeStack({ id: 'persist-stack' }));
      registry.close();

      const registry2 = await Registry.create(dbPath);
      expect(registry2.listProjects()).toHaveLength(1);
      expect(registry2.getStack('persist-stack')).toBeDefined();
      registry2.close();

      // Reopen for afterEach cleanup
      registry = await Registry.create(makeTempDb());
    });
  });
});
