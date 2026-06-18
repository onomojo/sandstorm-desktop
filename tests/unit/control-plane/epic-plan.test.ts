import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseEpicBody, isEpic, RunPlan } from '../../../src/main/control-plane/epic-plan';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'epics');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

describe('isEpic', () => {
  it('returns true when epic label is present among others', () => {
    expect(isEpic(['epic', 'spec-ready'])).toBe(true);
  });

  it('returns true when only epic label is present', () => {
    expect(isEpic(['epic'])).toBe(true);
  });

  it('returns false when epic label is absent', () => {
    expect(isEpic(['spec-ready', 'bug'])).toBe(false);
  });

  it('returns false for empty labels array', () => {
    expect(isEpic([])).toBe(false);
  });
});

describe('parseEpicBody', () => {
  describe('valid.md — fully valid body', () => {
    it('returns exact RunPlan with runnable=true', () => {
      const result = parseEpicBody('609', readFixture('valid.md'));
      const expected: RunPlan = {
        epicId: '609',
        runnable: true,
        notRunnableReasons: [],
        subtasks: [
          { ticketId: '101', spine: true, acceptanceGate: false },
          { ticketId: '102', spine: false, acceptanceGate: false },
          { ticketId: '103', spine: false, acceptanceGate: true },
        ],
        edges: [
          { from: '101', to: '102' },
          { from: '102', to: '103' },
        ],
        criteria: [
          { id: 'data-processing', text: 'The system processes data correctly' },
          { id: 'error-handling', text: 'Error handling is robust' },
        ],
      };
      expect(result).toEqual(expected);
    });
  });

  describe('no-subtask-checklist.md', () => {
    it('returns runnable=false: no subtask checklist found', () => {
      const result = parseEpicBody('609', readFixture('no-subtask-checklist.md'));
      expect(result.runnable).toBe(false);
      expect(result.notRunnableReasons).toEqual(['no subtask checklist found']);
    });
  });

  describe('no-dag-block.md', () => {
    it('returns runnable=false: no dag block found', () => {
      const result = parseEpicBody('609', readFixture('no-dag-block.md'));
      expect(result.runnable).toBe(false);
      expect(result.notRunnableReasons).toEqual(['no dag block found']);
    });
  });

  describe('unknown-dag-reference.md', () => {
    it('returns runnable=false: dag edge references unknown ticket', () => {
      const result = parseEpicBody('609', readFixture('unknown-dag-reference.md'));
      expect(result.runnable).toBe(false);
      expect(result.notRunnableReasons).toEqual(['dag edge references unknown ticket: 999']);
    });
  });

  describe('no-spine.md', () => {
    it('returns runnable=false: no spine tag', () => {
      const result = parseEpicBody('609', readFixture('no-spine.md'));
      expect(result.runnable).toBe(false);
      expect(result.notRunnableReasons).toEqual(['no spine tag']);
    });
  });

  describe('no-acceptance-gate.md', () => {
    it('returns runnable=false: no acceptance-gate tag', () => {
      const result = parseEpicBody('609', readFixture('no-acceptance-gate.md'));
      expect(result.runnable).toBe(false);
      expect(result.notRunnableReasons).toEqual(['no acceptance-gate tag']);
    });
  });

  describe('no-criteria.md', () => {
    it('returns runnable=false: no acceptance criteria found', () => {
      const result = parseEpicBody('609', readFixture('no-criteria.md'));
      expect(result.runnable).toBe(false);
      expect(result.notRunnableReasons).toEqual(['no acceptance criteria found']);
    });
  });

  describe('duplicate-crit.md', () => {
    it('returns runnable=false: duplicate crit id', () => {
      const result = parseEpicBody('609', readFixture('duplicate-crit.md'));
      expect(result.runnable).toBe(false);
      expect(result.notRunnableReasons).toEqual(['duplicate crit id: dup-id']);
    });
  });

  describe('cycle.md', () => {
    it('returns runnable=false: cycle detected in dag', () => {
      const result = parseEpicBody('609', readFixture('cycle.md'));
      expect(result.runnable).toBe(false);
      expect(result.notRunnableReasons).toEqual(['cycle detected in dag']);
    });
  });

  describe('no-middot.md — checklist lines without middot separator', () => {
    it('returns runnable=false: no subtask checklist found', () => {
      const result = parseEpicBody('609', readFixture('no-middot.md'));
      expect(result.runnable).toBe(false);
      expect(result.notRunnableReasons).toEqual(['no subtask checklist found']);
    });
  });

  describe('CRLF line endings', () => {
    it('normalizes CRLF and produces the same result as LF', () => {
      const lf = readFixture('valid.md');
      const crlf = lf.replace(/\n/g, '\r\n');
      expect(parseEpicBody('609', crlf)).toEqual(parseEpicBody('609', lf));
    });
  });

  describe('multiple-dag-blocks.md — first dag block wins', () => {
    it('uses only edges from the first dag block and is runnable', () => {
      const result = parseEpicBody('609', readFixture('multiple-dag-blocks.md'));
      expect(result.runnable).toBe(true);
      // Second block (202 --> 201) is ignored; only first block edge present
      expect(result.edges).toEqual([{ from: '201', to: '202' }]);
    });
  });

  describe('epicId passthrough', () => {
    it('sets epicId from the parameter', () => {
      const result = parseEpicBody('999', readFixture('valid.md'));
      expect(result.epicId).toBe('999');
    });
  });

  describe('ids stored without # prefix', () => {
    it('stores ticketId and edge ids as bare numbers', () => {
      const result = parseEpicBody('609', readFixture('valid.md'));
      for (const s of result.subtasks) {
        expect(s.ticketId).toMatch(/^\d+$/);
      }
      for (const e of result.edges) {
        expect(e.from).toMatch(/^\d+$/);
        expect(e.to).toMatch(/^\d+$/);
      }
    });
  });
});
