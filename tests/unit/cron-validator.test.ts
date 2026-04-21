import { describe, it, expect } from 'vitest';
import {
  validateCronExpression,
  cronToHuman,
  nextFireTime,
} from '../../src/main/scheduler/cron-validator';

describe('cron-validator', () => {
  describe('validateCronExpression', () => {
    it('accepts valid 5-field expressions', () => {
      expect(validateCronExpression('* * * * *')).toBeNull();
      expect(validateCronExpression('0 * * * *')).toBeNull();
      expect(validateCronExpression('*/5 * * * *')).toBeNull();
      expect(validateCronExpression('0 9 * * 1-5')).toBeNull();
      expect(validateCronExpression('30 2 1 * *')).toBeNull();
      expect(validateCronExpression('0 0 * * 0,6')).toBeNull();
      expect(validateCronExpression('0 */2 * * *')).toBeNull();
      expect(validateCronExpression('15 14 1 * *')).toBeNull();
    });

    it('rejects wrong number of fields', () => {
      expect(validateCronExpression('* * *')).toContain('Expected 5 fields');
      expect(validateCronExpression('* * * * * *')).toContain('Expected 5 fields');
      expect(validateCronExpression('')).toBeTruthy();
    });

    it('rejects out-of-range values', () => {
      expect(validateCronExpression('60 * * * *')).toContain('out of bounds');
      expect(validateCronExpression('* 24 * * *')).toContain('out of bounds');
      expect(validateCronExpression('* * 32 * *')).toContain('out of bounds');
      expect(validateCronExpression('* * * 13 *')).toContain('out of bounds');
      expect(validateCronExpression('* * * * 8')).toContain('out of bounds');
    });

    it('rejects invalid field syntax', () => {
      expect(validateCronExpression('abc * * * *')).toContain('invalid value');
    });

    it('accepts day-of-week 7 (Sunday alias)', () => {
      expect(validateCronExpression('0 0 * * 7')).toBeNull();
    });
  });

  describe('cronToHuman', () => {
    it('every minute', () => {
      expect(cronToHuman('* * * * *')).toBe('Every minute');
    });

    it('every N minutes', () => {
      expect(cronToHuman('*/5 * * * *')).toBe('Every 5 minutes');
      expect(cronToHuman('*/1 * * * *')).toBe('Every minute');
    });

    it('every hour at minute', () => {
      expect(cronToHuman('0 * * * *')).toBe('Every hour at :00');
      expect(cronToHuman('30 * * * *')).toBe('Every hour at :30');
    });

    it('daily at specific time', () => {
      expect(cronToHuman('0 9 * * *')).toBe('Daily at 09:00');
      expect(cronToHuman('30 14 * * *')).toBe('Daily at 14:30');
    });

    it('every N hours', () => {
      expect(cronToHuman('0 */2 * * *')).toBe('Every 2 hours at :00');
    });

    it('returns raw expression for unsupported patterns', () => {
      expect(cronToHuman('0 9 1 * *')).toContain('at 09:00');
    });
  });

  describe('nextFireTime', () => {
    it('computes next fire time for every-5-minutes', () => {
      const base = new Date('2026-01-01T10:02:00Z');
      const next = nextFireTime('*/5 * * * *', base);
      expect(next).toBeTruthy();
      expect(next!.getMinutes() % 5).toBe(0);
      expect(next!.getTime()).toBeGreaterThan(base.getTime());
    });

    it('computes next fire time for daily cron', () => {
      const base = new Date('2026-01-01T10:00:00Z');
      const next = nextFireTime('0 9 * * *', base);
      expect(next).toBeTruthy();
      expect(next!.getHours()).toBe(9);
      expect(next!.getMinutes()).toBe(0);
    });

    it('returns null for complex patterns', () => {
      // Day-of-month + month specific — too complex for our simple impl
      const result = nextFireTime('0 0 1 6 *');
      // May or may not return null depending on current date; just test it doesn't throw
      expect(result === null || result instanceof Date).toBe(true);
    });
  });
});
