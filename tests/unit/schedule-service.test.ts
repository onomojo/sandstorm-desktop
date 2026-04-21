import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  getAllSchedulesForProjects,
} from '../../src/main/scheduler/schedule-service';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-sched-test-'));
  // Create .sandstorm directory to mimic initialized project
  fs.mkdirSync(path.join(tmpDir, '.sandstorm'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('schedule-service', () => {
  describe('createSchedule', () => {
    it('creates a schedule with valid inputs', () => {
      const schedule = createSchedule({
        projectDir: tmpDir,
        label: 'Test Schedule',
        cronExpression: '0 * * * *',
        prompt: 'Do something',
      });

      expect(schedule.id).toMatch(/^sch_/);
      expect(schedule.label).toBe('Test Schedule');
      expect(schedule.cronExpression).toBe('0 * * * *');
      expect(schedule.prompt).toBe('Do something');
      expect(schedule.enabled).toBe(true);
      expect(schedule.createdAt).toBeTruthy();
      expect(schedule.updatedAt).toBeTruthy();
    });

    it('creates a disabled schedule when enabled=false', () => {
      const schedule = createSchedule({
        projectDir: tmpDir,
        cronExpression: '0 * * * *',
        prompt: 'Test',
        enabled: false,
      });
      expect(schedule.enabled).toBe(false);
    });

    it('rejects invalid cron expression', () => {
      expect(() =>
        createSchedule({
          projectDir: tmpDir,
          cronExpression: 'invalid',
          prompt: 'Test',
        })
      ).toThrow('Invalid cron expression');
    });

    it('rejects empty prompt', () => {
      expect(() =>
        createSchedule({
          projectDir: tmpDir,
          cronExpression: '0 * * * *',
          prompt: '  ',
        })
      ).toThrow('Prompt is required');
    });

    it('persists to schedules.json with atomic write', () => {
      createSchedule({
        projectDir: tmpDir,
        cronExpression: '0 * * * *',
        prompt: 'Test',
      });

      const filePath = path.join(tmpDir, '.sandstorm', 'schedules.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const store = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(store.version).toBe(1);
      expect(store.schedules).toHaveLength(1);
    });

    it('no temp files remain after write', () => {
      createSchedule({
        projectDir: tmpDir,
        cronExpression: '0 * * * *',
        prompt: 'Test',
      });

      const files = fs.readdirSync(path.join(tmpDir, '.sandstorm'));
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('listSchedules', () => {
    it('returns empty array when no schedules.json', () => {
      expect(listSchedules(tmpDir)).toEqual([]);
    });

    it('returns all created schedules', () => {
      createSchedule({ projectDir: tmpDir, cronExpression: '0 * * * *', prompt: 'First' });
      createSchedule({ projectDir: tmpDir, cronExpression: '*/5 * * * *', prompt: 'Second' });

      const schedules = listSchedules(tmpDir);
      expect(schedules).toHaveLength(2);
    });

    it('silently drops entries with invalid cron expressions when reading from disk', () => {
      // Simulate a manually-crafted schedules.json with a newline-injected cron expression
      const injectedStore = {
        version: 1,
        schedules: [
          {
            id: 'sch_aabbccddeeff',
            cronExpression: '0 * * * *\nmalicious-command /path',
            prompt: 'injected',
            enabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: 'sch_112233445566',
            cronExpression: '0 * * * *',
            prompt: 'valid entry',
            enabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };
      fs.writeFileSync(
        path.join(tmpDir, '.sandstorm', 'schedules.json'),
        JSON.stringify(injectedStore)
      );

      const schedules = listSchedules(tmpDir);
      // Only the valid entry should survive; the injected one is silently dropped
      expect(schedules).toHaveLength(1);
      expect(schedules[0].id).toBe('sch_112233445566');
    });
  });

  describe('getSchedule', () => {
    it('returns schedule by id', () => {
      const created = createSchedule({
        projectDir: tmpDir,
        cronExpression: '0 * * * *',
        prompt: 'Test',
      });

      const found = getSchedule(tmpDir, created.id);
      expect(found).toBeTruthy();
      expect(found!.id).toBe(created.id);
    });

    it('returns null for nonexistent id', () => {
      expect(getSchedule(tmpDir, 'sch_nonexistent')).toBeNull();
    });
  });

  describe('updateSchedule', () => {
    it('updates individual fields', () => {
      const created = createSchedule({
        projectDir: tmpDir,
        cronExpression: '0 * * * *',
        prompt: 'Original',
        label: 'Original Label',
      });

      const updated = updateSchedule(tmpDir, created.id, {
        prompt: 'Updated',
        enabled: false,
      });

      expect(updated.prompt).toBe('Updated');
      expect(updated.enabled).toBe(false);
      expect(updated.label).toBe('Original Label'); // unchanged
      expect(updated.cronExpression).toBe('0 * * * *'); // unchanged
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime()
      );
    });

    it('rejects invalid cron in patch', () => {
      const created = createSchedule({
        projectDir: tmpDir,
        cronExpression: '0 * * * *',
        prompt: 'Test',
      });

      expect(() =>
        updateSchedule(tmpDir, created.id, { cronExpression: 'bad' })
      ).toThrow('Invalid cron expression');
    });

    it('throws for nonexistent schedule', () => {
      expect(() =>
        updateSchedule(tmpDir, 'sch_nonexistent', { prompt: 'X' })
      ).toThrow('Schedule not found');
    });
  });

  describe('deleteSchedule', () => {
    it('removes the schedule', () => {
      const created = createSchedule({
        projectDir: tmpDir,
        cronExpression: '0 * * * *',
        prompt: 'Test',
      });

      deleteSchedule(tmpDir, created.id);
      expect(listSchedules(tmpDir)).toHaveLength(0);
    });

    it('throws for nonexistent schedule', () => {
      expect(() => deleteSchedule(tmpDir, 'sch_nonexistent')).toThrow('Schedule not found');
    });
  });

  describe('getAllSchedulesForProjects', () => {
    it('aggregates schedules from multiple projects', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-sched-test2-'));
      fs.mkdirSync(path.join(dir2, '.sandstorm'), { recursive: true });

      createSchedule({ projectDir: tmpDir, cronExpression: '0 * * * *', prompt: 'P1' });
      createSchedule({ projectDir: dir2, cronExpression: '*/5 * * * *', prompt: 'P2' });

      const all = getAllSchedulesForProjects([tmpDir, dir2]);
      expect(all).toHaveLength(2);
      expect(all[0].projectDir).toBe(tmpDir);
      expect(all[1].projectDir).toBe(dir2);

      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('skips projects with invalid schedule files', () => {
      fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'schedules.json'), 'NOT JSON');
      const all = getAllSchedulesForProjects([tmpDir]);
      expect(all).toHaveLength(0);
    });
  });

  describe('corrupted schedules.json', () => {
    it('listSchedules throws a clear error on malformed JSON', () => {
      fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'schedules.json'), '{broken');
      expect(() => listSchedules(tmpDir)).toThrow('Failed to parse schedules.json');
    });

    it('createSchedule throws a clear error on malformed JSON', () => {
      fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'schedules.json'), 'NOT VALID JSON');
      expect(() => createSchedule({
        projectDir: tmpDir,
        cronExpression: '0 * * * *',
        prompt: 'Test prompt',
      })).toThrow('Failed to parse schedules.json');
    });

    it('updateSchedule throws a clear error on malformed JSON', () => {
      fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'schedules.json'), '<<<>>>');
      expect(() => updateSchedule(tmpDir, 'sch_000000000000', { enabled: false }))
        .toThrow('Failed to parse schedules.json');
    });

    it('deleteSchedule throws a clear error on malformed JSON', () => {
      fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'schedules.json'), '!!!');
      expect(() => deleteSchedule(tmpDir, 'sch_000000000000'))
        .toThrow('Failed to parse schedules.json');
    });
  });
});
