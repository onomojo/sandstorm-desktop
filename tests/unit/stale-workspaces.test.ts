import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StackManager } from '../../src/main/control-plane/stack-manager';
import { Registry } from '../../src/main/control-plane/registry';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { ContainerRuntime } from '../../src/main/runtime/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
    listContainers: vi.fn().mockResolvedValue([]),
    inspect: vi.fn(),
    logs: vi.fn().mockReturnValue((async function* () {})()),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    containerStats: vi.fn().mockResolvedValue({ memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
  };
}

describe('Stale Workspace Detection', () => {
  let dbPath: string;
  let registry: Registry;
  let manager: StackManager;
  let mockRuntime: ContainerRuntime;
  let tmpProjectDir: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    mockRuntime = createMockRuntime();

    const portAllocator = new PortAllocator(registry);
    const taskWatcher = new TaskWatcher(mockRuntime);

    manager = new StackManager(
      registry,
      portAllocator,
      taskWatcher,
      mockRuntime,
      mockRuntime,
      '/tmp/sandstorm-cli'
    );

    // Create a temp project directory with .sandstorm/workspaces structure
    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-stale-proj-'));
    const workspacesDir = path.join(tmpProjectDir, '.sandstorm', 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });

    // Also create config and docker-compose for checkInit compatibility
    fs.writeFileSync(path.join(tmpProjectDir, '.sandstorm', 'config'), 'PROJECT_NAME=test');
    fs.writeFileSync(path.join(tmpProjectDir, '.sandstorm', 'docker-compose.yml'), 'services: {}');
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it('detects orphaned workspaces (no matching stack in registry)', async () => {
    // Register the project
    registry.addProject(tmpProjectDir);

    // Create a workspace directory that has no matching stack in the DB
    const orphanedDir = path.join(tmpProjectDir, '.sandstorm', 'workspaces', 'orphaned-stack');
    fs.mkdirSync(orphanedDir, { recursive: true });
    fs.writeFileSync(path.join(orphanedDir, 'file.txt'), 'hello');

    const stale = await manager.detectStaleWorkspaces();

    expect(stale).toHaveLength(1);
    expect(stale[0].stackId).toBe('orphaned-stack');
    expect(stale[0].reason).toBe('orphaned');
    expect(stale[0].workspacePath).toBe(orphanedDir);
  });

  it('detects completed stack workspaces as stale', async () => {
    registry.addProject(tmpProjectDir);

    // Create a stack with completed status
    registry.createStack({
      id: 'completed-stack',
      project: path.basename(tmpProjectDir),
      project_dir: tmpProjectDir,
      ticket: null,
      branch: null,
      description: null,
      status: 'completed',
      runtime: 'docker',
    });

    // Create the workspace directory
    const workspaceDir = path.join(tmpProjectDir, '.sandstorm', 'workspaces', 'completed-stack');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'file.txt'), 'hello');

    const stale = await manager.detectStaleWorkspaces();

    expect(stale).toHaveLength(1);
    expect(stale[0].stackId).toBe('completed-stack');
    expect(stale[0].reason).toBe('completed');
  });

  it('detects failed stack workspaces as stale', async () => {
    registry.addProject(tmpProjectDir);

    registry.createStack({
      id: 'failed-stack',
      project: path.basename(tmpProjectDir),
      project_dir: tmpProjectDir,
      ticket: null,
      branch: null,
      description: null,
      status: 'building',
      runtime: 'docker',
    });
    registry.updateStackStatus('failed-stack', 'failed', 'Build error');

    const workspaceDir = path.join(tmpProjectDir, '.sandstorm', 'workspaces', 'failed-stack');
    fs.mkdirSync(workspaceDir, { recursive: true });

    const stale = await manager.detectStaleWorkspaces();

    expect(stale).toHaveLength(1);
    expect(stale[0].stackId).toBe('failed-stack');
    expect(stale[0].reason).toBe('completed');
  });

  it('does NOT flag active stacks as stale', async () => {
    registry.addProject(tmpProjectDir);

    // Create stacks in various active states
    for (const status of ['building', 'up', 'running', 'idle', 'stopped', 'pushed', 'pr_created'] as const) {
      const id = `${status}-stack`;
      registry.createStack({
        id,
        project: path.basename(tmpProjectDir),
        project_dir: tmpProjectDir,
        ticket: null,
        branch: null,
        description: null,
        status: 'building',
        runtime: 'docker',
      });
      if (status !== 'building') {
        registry.updateStackStatus(id, status);
      }
      const workspaceDir = path.join(tmpProjectDir, '.sandstorm', 'workspaces', id);
      fs.mkdirSync(workspaceDir, { recursive: true });
    }

    const stale = await manager.detectStaleWorkspaces();
    expect(stale).toHaveLength(0);
  });

  it('does NOT flag workspaces with running containers as stale', async () => {
    registry.addProject(tmpProjectDir);

    // Create a completed stack
    registry.createStack({
      id: 'running-containers',
      project: path.basename(tmpProjectDir),
      project_dir: tmpProjectDir,
      ticket: null,
      branch: null,
      description: null,
      status: 'building',
      runtime: 'docker',
    });
    registry.updateStackStatus('running-containers', 'completed');

    // Workspace exists
    const workspaceDir = path.join(tmpProjectDir, '.sandstorm', 'workspaces', 'running-containers');
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Mock: containers are running
    (mockRuntime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'container-1',
        name: 'sandstorm-test-running-containers-claude-1',
        image: 'sandstorm-claude',
        status: 'running' as const,
        state: 'running',
        ports: [],
        labels: {},
        created: new Date().toISOString(),
      },
    ]);

    const stale = await manager.detectStaleWorkspaces();
    expect(stale).toHaveLength(0);
  });

  it('returns empty array when no projects are registered', async () => {
    const stale = await manager.detectStaleWorkspaces();
    expect(stale).toHaveLength(0);
  });

  it('returns empty array when workspaces directory does not exist', async () => {
    registry.addProject(tmpProjectDir);
    // Remove the workspaces dir
    fs.rmSync(path.join(tmpProjectDir, '.sandstorm', 'workspaces'), { recursive: true });

    const stale = await manager.detectStaleWorkspaces();
    expect(stale).toHaveLength(0);
  });

  it('includes project info and lastModified in results', async () => {
    registry.addProject(tmpProjectDir);

    const workspaceDir = path.join(tmpProjectDir, '.sandstorm', 'workspaces', 'old-stack');
    fs.mkdirSync(workspaceDir, { recursive: true });

    const stale = await manager.detectStaleWorkspaces();

    expect(stale).toHaveLength(1);
    expect(stale[0].project).toBe(path.basename(tmpProjectDir));
    expect(stale[0].projectDir).toBe(tmpProjectDir);
    expect(stale[0].lastModified).toBeTruthy();
  });

  it('detects multiple stale workspaces across the same project', async () => {
    registry.addProject(tmpProjectDir);

    for (const id of ['stale-1', 'stale-2', 'stale-3']) {
      fs.mkdirSync(path.join(tmpProjectDir, '.sandstorm', 'workspaces', id), { recursive: true });
    }

    const stale = await manager.detectStaleWorkspaces();
    expect(stale).toHaveLength(3);
    const ids = stale.map((s) => s.stackId).sort();
    expect(ids).toEqual(['stale-1', 'stale-2', 'stale-3']);
  });

  it('skips non-directory entries in workspaces folder', async () => {
    registry.addProject(tmpProjectDir);

    // Create a file (not directory) in workspaces
    fs.writeFileSync(path.join(tmpProjectDir, '.sandstorm', 'workspaces', 'not-a-dir.txt'), 'hello');

    const stale = await manager.detectStaleWorkspaces();
    expect(stale).toHaveLength(0);
  });
});

describe('Stale Workspace Cleanup', () => {
  let dbPath: string;
  let registry: Registry;
  let manager: StackManager;
  let mockRuntime: ContainerRuntime;
  let tmpProjectDir: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    mockRuntime = createMockRuntime();

    const portAllocator = new PortAllocator(registry);
    const taskWatcher = new TaskWatcher(mockRuntime);

    manager = new StackManager(
      registry,
      portAllocator,
      taskWatcher,
      mockRuntime,
      mockRuntime,
      '/tmp/sandstorm-cli'
    );

    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-cleanup-'));
    const workspacesDir = path.join(tmpProjectDir, '.sandstorm', 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });

    // Register the project so path validation passes
    registry.addProject(tmpProjectDir);
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it('removes workspace directories and returns success', async () => {
    const workspaceDir = path.join(tmpProjectDir, '.sandstorm', 'workspaces', 'to-remove');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'file.txt'), 'data');

    expect(fs.existsSync(workspaceDir)).toBe(true);

    const results = await manager.cleanupStaleWorkspaces([workspaceDir]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].workspacePath).toBe(workspaceDir);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });

  it('handles already-removed workspaces gracefully', async () => {
    const nonExistentPath = path.join(tmpProjectDir, '.sandstorm', 'workspaces', 'gone');

    const results = await manager.cleanupStaleWorkspaces([nonExistentPath]);

    expect(results).toHaveLength(1);
    // Should succeed since the directory doesn't exist (nothing to clean)
    expect(results[0].success).toBe(true);
  });

  it('rejects paths outside registered project workspace directories', async () => {
    const outsidePath = path.join(os.tmpdir(), 'not-a-workspace');
    fs.mkdirSync(outsidePath, { recursive: true });

    const results = await manager.cleanupStaleWorkspaces([outsidePath]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('not within a registered project');
    // Directory should still exist
    expect(fs.existsSync(outsidePath)).toBe(true);

    fs.rmSync(outsidePath, { recursive: true, force: true });
  });

  it('rejects path traversal attempts', async () => {
    const traversalPath = path.join(tmpProjectDir, '.sandstorm', 'workspaces', '..', '..', 'important');
    fs.mkdirSync(path.join(tmpProjectDir, 'important'), { recursive: true });

    const results = await manager.cleanupStaleWorkspaces([traversalPath]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('not within a registered project');
  });

  it('cleans up multiple workspaces in one call', async () => {
    const dirs = ['clean-1', 'clean-2', 'clean-3'].map((name) => {
      const dir = path.join(tmpProjectDir, '.sandstorm', 'workspaces', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'file.txt'), 'data');
      return dir;
    });

    const results = await manager.cleanupStaleWorkspaces(dirs);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    for (const dir of dirs) {
      expect(fs.existsSync(dir)).toBe(false);
    }
  });
});
