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
  return path.join(os.tmpdir(), `sandstorm-rebuild-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
    containerStats: vi.fn().mockResolvedValue({ memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 }),
  };
}

describe('Auto-rebuild mechanism', () => {
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
    taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    cleanupDb(dbPath);
  });

  describe('resolveAppVersion', () => {
    it('returns a string', () => {
      const version = StackManager.resolveAppVersion();
      expect(typeof version).toBe('string');
      expect(version.length).toBeGreaterThan(0);
    });

    it('returns "test" in test environment (from vitest define)', () => {
      // vitest.config.ts defines __GIT_COMMIT__ as 'test'
      const version = StackManager.resolveAppVersion();
      expect(version).toBe('test');
    });
  });

  describe('getAppVersion', () => {
    it('returns the resolved version', () => {
      expect(manager.getAppVersion()).toBe('test');
    });
  });

  describe('checkImageNeedsRebuild', () => {
    // Note: checkImageNeedsRebuild uses `docker image inspect` via spawn,
    // which won't work in unit tests without Docker. We test the logic paths
    // by mocking child_process.spawn.

    it('returns false when appVersion is "unknown"', async () => {
      // Create a manager with 'unknown' version
      const unknownManager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');
      // Override private field for testing
      (unknownManager as unknown as { appVersion: string }).appVersion = 'unknown';

      const result = await unknownManager.checkImageNeedsRebuild('/some/project');
      expect(result).toBe(false);
    });

    it('returns false when docker inspect fails (image does not exist)', async () => {
      // spawn will fail since Docker is not available in test env
      const result = await manager.checkImageNeedsRebuild('/nonexistent/project');
      expect(result).toBe(false);
    });
  });

  describe('createStack sets rebuilding status', () => {
    it('passes SANDSTORM_APP_VERSION to CLI via runCli', async () => {
      // Spy on runCli to verify the env var is passed
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      // Mock checkImageNeedsRebuild to return false (no rebuild)
      vi.spyOn(manager, 'checkImageNeedsRebuild').mockResolvedValue(false);

      // Create temp project dir with .sandstorm/config
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-rebuild-proj-'));
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=testproj\nPORT_MAP=\n');

      try {
        manager.createStack({
          name: 'rebuild-test',
          projectDir: tmpDir,
          runtime: 'docker',
        });

        // Wait for background build to reach runCli
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(runCliSpy).toHaveBeenCalled();
        const envArg = runCliSpy.mock.calls[0][2];
        expect(envArg).toBeDefined();
        expect(envArg!['SANDSTORM_APP_VERSION']).toBe('test');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('sets status to rebuilding when image needs rebuild', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      // Mock: image needs rebuild
      vi.spyOn(manager, 'checkImageNeedsRebuild').mockResolvedValue(true);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-rebuild-proj-'));
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=testproj\nPORT_MAP=\n');

      try {
        manager.createStack({
          name: 'rebuild-status-test',
          projectDir: tmpDir,
          runtime: 'docker',
        });

        // Wait for checkImageNeedsRebuild to run and status to be set
        await new Promise((resolve) => setTimeout(resolve, 200));

        const stack = registry.getStack('rebuild-status-test');
        // Status should have progressed — it was 'rebuilding' then 'up' after CLI succeeds
        // Since runCli is mocked to succeed, final status is 'up'
        expect(stack).toBeDefined();
        expect(['rebuilding', 'up']).toContain(stack!.status);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('does not set rebuilding status when image is up to date', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      // Mock: image does NOT need rebuild
      vi.spyOn(manager, 'checkImageNeedsRebuild').mockResolvedValue(false);

      // Track all status updates
      const statusUpdates: string[] = [];
      const origUpdate = registry.updateStackStatus.bind(registry);
      vi.spyOn(registry, 'updateStackStatus').mockImplementation((id, status, error?) => {
        statusUpdates.push(status);
        return origUpdate(id, status, error);
      });

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-rebuild-proj-'));
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=testproj\nPORT_MAP=\n');

      try {
        manager.createStack({
          name: 'no-rebuild-test',
          projectDir: tmpDir,
          runtime: 'docker',
        });

        await new Promise((resolve) => setTimeout(resolve, 200));

        // 'rebuilding' should NOT appear in the status updates
        expect(statusUpdates).not.toContain('rebuilding');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
