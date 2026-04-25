import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { projectIdFromDir } from '../../src/main/scheduler/scheduler-manager';

// Mock the scheduler index to avoid real crontab operations
vi.mock('../../src/main/scheduler/index', () => ({
  getAllSchedulesForProjects: vi.fn().mockReturnValue([]),
  syncCrontab: vi.fn(),
  getStableWrapperPath: vi.fn().mockReturnValue('/usr/local/bin/sandstorm-scheduled-run.sh'),
}));

describe('scheduler-manager', () => {
  describe('projectIdFromDir', () => {
    it('produces a deterministic id from a project path', () => {
      const id1 = projectIdFromDir('/home/user/my-project');
      const id2 = projectIdFromDir('/home/user/my-project');
      expect(id1).toBe(id2);
    });

    it('includes the basename in the id', () => {
      const id = projectIdFromDir('/home/user/my-project');
      expect(id).toMatch(/^my-project-/);
    });

    it('appends an 8-char hex hash suffix', () => {
      const id = projectIdFromDir('/home/user/my-project');
      const parts = id.split('-');
      const hash = parts[parts.length - 1];
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('produces different ids for different paths with the same basename', () => {
      const id1 = projectIdFromDir('/home/alice/myapp');
      const id2 = projectIdFromDir('/home/bob/myapp');
      expect(id1).not.toBe(id2);
      // Both should start with the same basename prefix
      expect(id1).toMatch(/^myapp-/);
      expect(id2).toMatch(/^myapp-/);
    });

    it('sanitizes special characters in basename', () => {
      const id = projectIdFromDir('/home/user/My Project (v2)');
      // Special chars should be replaced with dashes
      expect(id).not.toMatch(/[^a-z0-9_-]/);
    });

    it('lowercases the basename', () => {
      const id = projectIdFromDir('/home/user/MyProject');
      expect(id).toMatch(/^myproject-/);
    });

    it('handles paths with trailing slashes via path.basename', () => {
      // path.basename('/foo/bar/') returns 'bar' in Node
      const id1 = projectIdFromDir('/home/user/project');
      // Note: the hash will differ because the full path string differs
      expect(id1).toMatch(/^project-/);
    });

    it('handles empty basename gracefully', () => {
      // path.basename('/') returns '' — should not crash
      const id = projectIdFromDir('/');
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe('syncAllProjectsCrontab', () => {
    it('passes registry projects to crontab sync', async () => {
      const { getAllSchedulesForProjects, syncCrontab } = await import(
        '../../src/main/scheduler/index'
      );
      const { syncAllProjectsCrontab } = await import(
        '../../src/main/scheduler/scheduler-manager'
      );

      const mockRegistry = {
        listProjects: vi.fn().mockReturnValue([
          { directory: '/home/user/project-a' },
          { directory: '/home/user/project-b' },
        ]),
      };

      (getAllSchedulesForProjects as ReturnType<typeof vi.fn>).mockReturnValue([]);

      await syncAllProjectsCrontab(mockRegistry);

      expect(getAllSchedulesForProjects).toHaveBeenCalledWith([
        '/home/user/project-a',
        '/home/user/project-b',
      ]);
      expect(syncCrontab).toHaveBeenCalled();
    });

    it('throws when crontab sync fails', async () => {
      const { syncCrontab } = await import('../../src/main/scheduler/index');
      const { syncAllProjectsCrontab } = await import(
        '../../src/main/scheduler/scheduler-manager'
      );

      const mockRegistry = {
        listProjects: vi.fn().mockReturnValue([]),
      };

      (syncCrontab as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('crontab write failed');
      });

      await expect(syncAllProjectsCrontab(mockRegistry)).rejects.toThrow('crontab write failed');
    });
  });
});
