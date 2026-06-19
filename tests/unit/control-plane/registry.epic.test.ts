import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../../../src/main/control-plane/registry';
import type { EpicStatus } from '../../../src/main/control-plane/registry';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-epic-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe('Registry — epic tables (migration 26)', () => {
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

  // ---------------------------------------------------------------------------
  // Migration idempotency
  // ---------------------------------------------------------------------------

  it('creates epics, epic_tasks, and project_epic_settings tables on fresh DB', () => {
    // Accessors work without throwing — proof that tables exist.
    expect(registry.getEpicRunState('nonexistent')).toBeNull();
    expect(registry.getEpicTasks('nonexistent')).toEqual([]);
    expect(registry.getEpicMaxParallelStacks('/some/dir')).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // EpicRunState round-trip
  // ---------------------------------------------------------------------------

  describe('getEpicRunState / upsertEpicRunState', () => {
    it('returns null for unknown epicId', () => {
      expect(registry.getEpicRunState('missing-epic')).toBeNull();
    });

    it('round-trips an epic record', () => {
      registry.upsertEpicRunState('ep-1', '/projects/alpha', 'running');
      const row = registry.getEpicRunState('ep-1');
      expect(row).not.toBeNull();
      expect(row!.epic_id).toBe('ep-1');
      expect(row!.status).toBe('running');
      expect(row!.created_at).toBeTruthy();
      expect(row!.updated_at).toBeTruthy();
    });

    it('normalizes project_dir via path.resolve', () => {
      registry.upsertEpicRunState('ep-norm', '/projects/../projects/alpha', 'paused');
      const row = registry.getEpicRunState('ep-norm');
      expect(row!.project_dir).toBe(path.resolve('/projects/../projects/alpha'));
    });

    it('updates status on subsequent upsert', () => {
      registry.upsertEpicRunState('ep-update', '/proj', 'running');
      registry.upsertEpicRunState('ep-update', '/proj', 'completed');
      const row = registry.getEpicRunState('ep-update');
      expect(row!.status).toBe('completed');
    });

    it.each(['running', 'paused', 'completed', 'needs_human'] as EpicStatus[])(
      'accepts valid status "%s"',
      (status) => {
        expect(() => registry.upsertEpicRunState(`ep-${status}`, '/proj', status)).not.toThrow();
        expect(registry.getEpicRunState(`ep-${status}`)!.status).toBe(status);
      },
    );

    it('rejects invalid status', () => {
      expect(() =>
        registry.upsertEpicRunState('ep-bad', '/proj', 'unknown' as EpicStatus)
      ).toThrow(/Invalid epic status/);
    });
  });

  // ---------------------------------------------------------------------------
  // EpicTasks round-trip
  // ---------------------------------------------------------------------------

  describe('getEpicTasks / upsertEpicTask / setEpicTaskDone', () => {
    it('returns empty array for unknown epicId', () => {
      expect(registry.getEpicTasks('no-such-epic')).toEqual([]);
    });

    it('inserts and retrieves a planned task', () => {
      registry.upsertEpicTask('ep-t', 'ticket-1', { role: 'build', origin: 'planned', critId: null });
      const tasks = registry.getEpicTasks('ep-t');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].ticket_id).toBe('ticket-1');
      expect(tasks[0].role).toBe('build');
      expect(tasks[0].origin).toBe('planned');
      expect(tasks[0].crit_id).toBeNull();
      expect(tasks[0].gap_cycles).toBe(0);
      expect(tasks[0].done).toBe(0);
    });

    it('inserts a gap task with crit_id', () => {
      registry.upsertEpicTask('ep-t2', 'gap-ticket', { role: 'reconcile', origin: 'gap', critId: 'crit-abc' });
      const tasks = registry.getEpicTasks('ep-t2');
      expect(tasks[0].crit_id).toBe('crit-abc');
      expect(tasks[0].origin).toBe('gap');
    });

    it('upserts update role/origin/crit_id on conflict', () => {
      registry.upsertEpicTask('ep-up', 'tkt', { role: 'build', origin: 'planned', critId: null });
      registry.upsertEpicTask('ep-up', 'tkt', { role: 'reconcile', origin: 'gap', critId: 'c1' });
      const tasks = registry.getEpicTasks('ep-up');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].role).toBe('reconcile');
      expect(tasks[0].crit_id).toBe('c1');
    });

    it('marks a task as done', () => {
      registry.upsertEpicTask('ep-done', 'tkt-d', { role: 'build', origin: 'planned' });
      registry.setEpicTaskDone('ep-done', 'tkt-d');
      const tasks = registry.getEpicTasks('ep-done');
      expect(tasks[0].done).toBe(1);
    });

    it('returns only tasks belonging to the requested epic', () => {
      registry.upsertEpicTask('ep-a', 'tkt-1', { role: 'build', origin: 'planned' });
      registry.upsertEpicTask('ep-b', 'tkt-2', { role: 'build', origin: 'planned' });
      expect(registry.getEpicTasks('ep-a')).toHaveLength(1);
      expect(registry.getEpicTasks('ep-b')).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getEpicForTicket (reverse lookup)
  // ---------------------------------------------------------------------------

  describe('getEpicForTicket', () => {
    it('returns null for a ticket not linked to any epic', () => {
      expect(registry.getEpicForTicket('orphan-ticket')).toBeNull();
    });

    it('returns the linked epic, role, and critId for a linked ticket', () => {
      registry.upsertEpicTask('ep-rev', 'tkt-rev', { role: 'reconcile', origin: 'gap', critId: 'crit-9' });
      expect(registry.getEpicForTicket('tkt-rev')).toEqual({
        epicId: 'ep-rev',
        role: 'reconcile',
        critId: 'crit-9',
      });
    });

    it('returns null critId when the linked task has no criterion', () => {
      registry.upsertEpicTask('ep-nc', 'tkt-nc', { role: 'build', origin: 'planned', critId: null });
      expect(registry.getEpicForTicket('tkt-nc')).toEqual({
        epicId: 'ep-nc',
        role: 'build',
        critId: null,
      });
    });

    it('picks the first epic by epic_id ordering when a ticket links to multiple', () => {
      registry.upsertEpicTask('ep-zeta', 'multi-tkt', { role: 'build', origin: 'planned' });
      registry.upsertEpicTask('ep-alpha', 'multi-tkt', { role: 'reconcile', origin: 'gap', critId: 'c' });
      const result = registry.getEpicForTicket('multi-tkt');
      expect(result?.epicId).toBe('ep-alpha');
    });
  });

  // ---------------------------------------------------------------------------
  // incrementGapCycles
  // ---------------------------------------------------------------------------

  describe('incrementGapCycles', () => {
    it('creates the row at gap_cycles=1 when no prior row exists', () => {
      const result = registry.incrementGapCycles('ep-gc', 'new-ticket');
      expect(result).toBe(1);
    });

    it('returns incrementing values on successive calls', () => {
      registry.upsertEpicTask('ep-inc', 'tkt-inc', { role: 'build', origin: 'gap' });
      expect(registry.incrementGapCycles('ep-inc', 'tkt-inc')).toBe(1);
      expect(registry.incrementGapCycles('ep-inc', 'tkt-inc')).toBe(2);
      expect(registry.incrementGapCycles('ep-inc', 'tkt-inc')).toBe(3);
    });

    it('reflects incremented value in getEpicTasks', () => {
      registry.upsertEpicTask('ep-reflect', 'tkt-r', { role: 'build', origin: 'gap' });
      registry.incrementGapCycles('ep-reflect', 'tkt-r');
      registry.incrementGapCycles('ep-reflect', 'tkt-r');
      const tasks = registry.getEpicTasks('ep-reflect');
      expect(tasks[0].gap_cycles).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // getEpicMaxParallelStacks / setEpicMaxParallelStacks
  // ---------------------------------------------------------------------------

  describe('getEpicMaxParallelStacks / setEpicMaxParallelStacks', () => {
    it('returns default of 3 when unset', () => {
      expect(registry.getEpicMaxParallelStacks('/any/dir')).toBe(3);
    });

    it('persists and returns a custom value', () => {
      registry.setEpicMaxParallelStacks('/projects/x', 5);
      expect(registry.getEpicMaxParallelStacks('/projects/x')).toBe(5);
    });

    it('updates the value on subsequent set', () => {
      registry.setEpicMaxParallelStacks('/projects/y', 2);
      registry.setEpicMaxParallelStacks('/projects/y', 7);
      expect(registry.getEpicMaxParallelStacks('/projects/y')).toBe(7);
    });

    it('isolates settings per project directory', () => {
      registry.setEpicMaxParallelStacks('/proj/a', 4);
      registry.setEpicMaxParallelStacks('/proj/b', 9);
      expect(registry.getEpicMaxParallelStacks('/proj/a')).toBe(4);
      expect(registry.getEpicMaxParallelStacks('/proj/b')).toBe(9);
    });

    it('normalizes project_dir via path.resolve', () => {
      registry.setEpicMaxParallelStacks('/proj/../proj/c', 6);
      expect(registry.getEpicMaxParallelStacks('/proj/c')).toBe(6);
    });
  });
});
