import { describe, it, expect } from 'vitest';
import {
  parseCrontab,
  buildManagedSection,
  assembleCrontab,
  CrontabEntry,
} from '../../src/main/scheduler/crontab-writer';
import { Schedule } from '../../src/main/scheduler/types';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_test123456',
    cronExpression: '0 * * * *',
    prompt: 'Test prompt',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CrontabEntry> = {}): CrontabEntry {
  return {
    projectDir: '/home/user/my-project',
    projectId: 'my-project',
    schedule: makeSchedule(),
    wrapperPath: '/home/user/.local/share/sandstorm/bin/sandstorm-scheduled-run.sh',
    ...overrides,
  };
}

describe('crontab-writer', () => {
  describe('parseCrontab', () => {
    it('handles empty crontab', () => {
      const result = parseCrontab('');
      expect(result.before).toBe('');
      expect(result.managed).toEqual([]);
      expect(result.after).toBe('');
    });

    it('handles crontab with no managed section', () => {
      const content = '0 * * * * /usr/bin/backup\n# some comment\n';
      const result = parseCrontab(content);
      expect(result.before).toBe(content);
      expect(result.managed).toEqual([]);
      expect(result.after).toBe('');
    });

    it('parses existing managed section', () => {
      const content = [
        '0 * * * * /usr/bin/backup',
        '# BEGIN sandstorm — managed by Sandstorm Desktop, do not edit by hand',
        '0 * * * * /path/to/wrapper /project sch_abc    # sandstorm:proj:sch_abc',
        '# END sandstorm',
        '30 2 * * * /usr/bin/cleanup',
        '',
      ].join('\n');

      const result = parseCrontab(content);
      expect(result.before).toBe('0 * * * * /usr/bin/backup');
      expect(result.managed).toHaveLength(1);
      expect(result.managed[0]).toContain('sch_abc');
      expect(result.after).toBe('30 2 * * * /usr/bin/cleanup\n');
    });

    it('preserves user entries byte-for-byte', () => {
      const userBefore = '# My custom cron jobs\n0 * * * * /usr/bin/foo\n';
      const userAfter = '30 2 * * * /usr/bin/bar\n\n# trailing comment\n';
      const content = [
        userBefore.trimEnd(),
        '# BEGIN sandstorm — managed by Sandstorm Desktop, do not edit by hand',
        '0 * * * * /path/wrapper /dir sch_x    # sandstorm:p:sch_x',
        '# END sandstorm',
        userAfter.trimEnd(),
        '',
      ].join('\n');

      const result = parseCrontab(content);
      // The before section should preserve the user's content
      expect(result.before).toBe(userBefore.trimEnd());
    });
  });

  describe('buildManagedSection', () => {
    it('generates crontab lines for enabled schedules', () => {
      const entries = [makeEntry()];
      const lines = buildManagedSection(entries);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('0 * * * *');
      expect(lines[0]).toContain('/home/user/my-project');
      expect(lines[0]).toContain('sch_test123456');
      expect(lines[0]).toContain('# sandstorm:my-project:sch_test123456');
    });

    it('skips disabled schedules', () => {
      const entries = [
        makeEntry({ schedule: makeSchedule({ enabled: false }) }),
      ];
      const lines = buildManagedSection(entries);
      expect(lines).toHaveLength(0);
    });

    it('handles multiple entries from different projects', () => {
      const entries = [
        makeEntry({ projectId: 'proj-a', schedule: makeSchedule({ id: 'sch_aaa' }) }),
        makeEntry({ projectId: 'proj-b', schedule: makeSchedule({ id: 'sch_bbb', cronExpression: '*/5 * * * *' }) }),
      ];
      const lines = buildManagedSection(entries);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('sandstorm:proj-a:sch_aaa');
      expect(lines[1]).toContain('sandstorm:proj-b:sch_bbb');
    });

    it('shell-quotes project dirs with spaces', () => {
      const entries = [
        makeEntry({ projectDir: '/home/user/my project' }),
      ];
      const lines = buildManagedSection(entries);
      expect(lines[0]).toContain("'/home/user/my project'");
    });
  });

  describe('assembleCrontab', () => {
    it('creates a new managed section in empty crontab', () => {
      const result = assembleCrontab('', ['0 * * * * /wrapper /dir sch_x    # sandstorm:p:sch_x'], '');
      expect(result).toContain('# BEGIN sandstorm');
      expect(result).toContain('# END sandstorm');
      expect(result).toContain('sch_x');
    });

    it('preserves content before and after managed section', () => {
      const before = '0 * * * * /usr/bin/backup\n';
      const after = '30 2 * * * /usr/bin/cleanup\n';
      const managed = ['0 * * * * /wrapper /dir sch_x    # sandstorm:p:sch_x'];

      const result = assembleCrontab(before, managed, after);
      expect(result).toContain('/usr/bin/backup');
      expect(result).toContain('/usr/bin/cleanup');
      expect(result).toContain('sch_x');
    });

    it('handles empty managed section (all schedules disabled)', () => {
      const result = assembleCrontab('', [], '');
      expect(result).toContain('# BEGIN sandstorm');
      expect(result).toContain('# END sandstorm');
    });

    it('round-trips: parse → rebuild → re-parse preserves structure', () => {
      const original = [
        'MAILTO=user@example.com',
        '0 * * * * /usr/bin/backup',
        '# BEGIN sandstorm — managed by Sandstorm Desktop, do not edit by hand',
        '0 * * * * /wrapper /dir sch_old    # sandstorm:p:sch_old',
        '# END sandstorm',
        '30 2 * * * /usr/bin/cleanup',
        '',
      ].join('\n');

      const parsed = parseCrontab(original);

      // Replace managed with new entries
      const newManaged = ['*/5 * * * * /wrapper /dir2 sch_new    # sandstorm:q:sch_new'];
      const assembled = assembleCrontab(parsed.before, newManaged, parsed.after);

      // Re-parse to verify round-trip
      const reparsed = parseCrontab(assembled);
      expect(reparsed.before).toContain('MAILTO=user@example.com');
      expect(reparsed.before).toContain('/usr/bin/backup');
      expect(reparsed.managed).toHaveLength(1);
      expect(reparsed.managed[0]).toContain('sch_new');
      expect(reparsed.after).toContain('/usr/bin/cleanup');
    });
  });
});
