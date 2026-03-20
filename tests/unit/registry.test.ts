import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Registry', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sandstorm-test-${Date.now()}.db`);
    registry = new Registry(dbPath);
  });

  afterEach(() => {
    registry.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(`${dbPath}-wal`);
      fs.unlinkSync(`${dbPath}-shm`);
    } catch {
      // ignore cleanup errors
    }
  });

  describe('stacks', () => {
    it('creates and retrieves a stack', () => {
      const stack = registry.createStack({
        id: 'test-stack',
        project: 'myproject',
        project_dir: '/home/user/myproject',
        ticket: 'EXP-123',
        branch: 'feature/test',
        description: 'Test stack',
        status: 'building',
        runtime: 'docker',
      });

      expect(stack.id).toBe('test-stack');
      expect(stack.project).toBe('myproject');
      expect(stack.status).toBe('building');
      expect(stack.created_at).toBeTruthy();

      const retrieved = registry.getStack('test-stack');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('test-stack');
    });

    it('lists all stacks', () => {
      registry.createStack({
        id: 'stack-1',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });
      registry.createStack({
        id: 'stack-2',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'running',
        runtime: 'podman',
      });

      const stacks = registry.listStacks();
      expect(stacks).toHaveLength(2);
    });

    it('updates stack status', () => {
      registry.createStack({
        id: 'status-test',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'building',
        runtime: 'docker',
      });

      registry.updateStackStatus('status-test', 'up');
      const stack = registry.getStack('status-test');
      expect(stack!.status).toBe('up');
    });

    it('deletes a stack and cascades', () => {
      registry.createStack({
        id: 'delete-me',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });

      registry.createTask('delete-me', 'test prompt');
      registry.setPorts('delete-me', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      registry.deleteStack('delete-me');
      expect(registry.getStack('delete-me')).toBeUndefined();
      expect(registry.getTasksForStack('delete-me')).toHaveLength(0);
      expect(registry.getPorts('delete-me')).toHaveLength(0);
    });

    it('rejects duplicate stack IDs', () => {
      registry.createStack({
        id: 'dup',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });

      expect(() =>
        registry.createStack({
          id: 'dup',
          project: 'proj',
          project_dir: '/proj',
          ticket: null,
          branch: null,
          description: null,
          status: 'up',
          runtime: 'docker',
        })
      ).toThrow();
    });
  });

  describe('tasks', () => {
    beforeEach(() => {
      registry.createStack({
        id: 'task-stack',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });
    });

    it('creates a task and updates stack status to running', () => {
      const task = registry.createTask('task-stack', 'Fix the bug');
      expect(task.id).toBeDefined();
      expect(task.status).toBe('running');
      expect(task.prompt).toBe('Fix the bug');

      const stack = registry.getStack('task-stack');
      expect(stack!.status).toBe('running');
    });

    it('completes a task and updates stack status', () => {
      const task = registry.createTask('task-stack', 'Do work');
      registry.completeTask(task.id, 0);

      const tasks = registry.getTasksForStack('task-stack');
      expect(tasks[0].status).toBe('completed');
      expect(tasks[0].exit_code).toBe(0);

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
  });

  describe('ports', () => {
    beforeEach(() => {
      registry.createStack({
        id: 'port-stack',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });
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
    });

    it('returns all allocated ports', () => {
      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
        { service: 'api', host_port: 10002, container_port: 3001 },
      ]);

      const allPorts = registry.getAllAllocatedPorts();
      expect(allPorts).toContain(10001);
      expect(allPorts).toContain(10002);
    });

    it('releases ports', () => {
      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      registry.releasePorts('port-stack');
      expect(registry.getPorts('port-stack')).toHaveLength(0);
    });

    it('enforces unique host ports', () => {
      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      registry.createStack({
        id: 'port-stack-2',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });

      expect(() =>
        registry.setPorts('port-stack-2', [
          { service: 'app', host_port: 10001, container_port: 3000 },
        ])
      ).toThrow();
    });
  });
});
