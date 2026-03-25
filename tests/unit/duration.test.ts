import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseUtcDate,
  formatDuration,
  getStackDuration,
  isTerminalStatus,
  DURATION_UPDATE_INTERVAL,
} from '../../src/renderer/utils/duration';

describe('parseUtcDate', () => {
  it('appends Z to date strings without timezone info', () => {
    const date = parseUtcDate('2026-03-25 10:30:00');
    expect(date.toISOString()).toBe('2026-03-25T10:30:00.000Z');
  });

  it('does not modify date strings that already have Z', () => {
    const date = parseUtcDate('2026-03-25T10:30:00.000Z');
    expect(date.toISOString()).toBe('2026-03-25T10:30:00.000Z');
  });

  it('does not modify date strings with + timezone offset', () => {
    const date = parseUtcDate('2026-03-25T10:30:00+05:00');
    expect(date.toISOString()).toBe('2026-03-25T05:30:00.000Z');
  });
});

describe('formatDuration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0s for future dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:00:00Z'));
    expect(formatDuration('2026-03-25T10:05:00Z')).toBe('0s');
  });

  it('returns seconds for durations under 1 minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:00:30Z'));
    expect(formatDuration('2026-03-25T10:00:00Z')).toBe('30s');
  });

  it('returns minutes for durations under 1 hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:15:00Z'));
    expect(formatDuration('2026-03-25T10:00:00Z')).toBe('15m');
  });

  it('returns hours and minutes for durations under 24 hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:30:00Z'));
    expect(formatDuration('2026-03-25T10:00:00Z')).toBe('2h 30m');
  });

  it('returns just hours when no remaining minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T13:00:00Z'));
    expect(formatDuration('2026-03-25T10:00:00Z')).toBe('3h');
  });

  it('returns days and hours for durations >= 24 hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-26T13:00:00Z'));
    expect(formatDuration('2026-03-25T10:00:00Z')).toBe('1d 3h');
  });

  it('returns just days when no remaining hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-27T10:00:00Z'));
    expect(formatDuration('2026-03-25T10:00:00Z')).toBe('2d');
  });

  it('handles SQLite timestamps without Z suffix correctly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:10:00Z'));
    // Without the UTC fix, this would be interpreted as local time
    // and give wrong results depending on timezone
    expect(formatDuration('2026-03-25 10:00:00')).toBe('10m');
  });

  it('calculates duration to a specific end date when provided', () => {
    const result = formatDuration('2026-03-25T10:00:00Z', '2026-03-25T10:45:00Z');
    expect(result).toBe('45m');
  });

  it('accepts a Date object as endRef', () => {
    const end = new Date('2026-03-25T12:00:00Z');
    const result = formatDuration('2026-03-25T10:00:00Z', end);
    expect(result).toBe('2h');
  });
});

describe('isTerminalStatus', () => {
  it('returns true for completed', () => {
    expect(isTerminalStatus('completed')).toBe(true);
  });

  it('returns true for failed', () => {
    expect(isTerminalStatus('failed')).toBe(true);
  });

  it('returns true for stopped', () => {
    expect(isTerminalStatus('stopped')).toBe(true);
  });

  it('returns false for running', () => {
    expect(isTerminalStatus('running')).toBe(false);
  });

  it('returns false for building', () => {
    expect(isTerminalStatus('building')).toBe(false);
  });

  it('returns false for up', () => {
    expect(isTerminalStatus('up')).toBe(false);
  });

  it('returns false for idle', () => {
    expect(isTerminalStatus('idle')).toBe(false);
  });
});

describe('getStackDuration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses current time for active stacks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:30:00Z'));
    const result = getStackDuration(
      '2026-03-25 10:00:00',
      '2026-03-25 10:05:00',
      'running'
    );
    // Should use now (10:30), not updated_at (10:05)
    expect(result).toBe('30m');
  });

  it('uses updated_at for completed stacks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
    const result = getStackDuration(
      '2026-03-25 10:00:00',
      '2026-03-25 10:45:00',
      'completed'
    );
    // Should use updated_at (10:45), not now (12:00)
    expect(result).toBe('45m');
  });

  it('uses updated_at for failed stacks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
    const result = getStackDuration(
      '2026-03-25 10:00:00',
      '2026-03-25 10:20:00',
      'failed'
    );
    expect(result).toBe('20m');
  });

  it('uses updated_at for stopped stacks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
    const result = getStackDuration(
      '2026-03-25 10:00:00',
      '2026-03-25 11:30:00',
      'stopped'
    );
    expect(result).toBe('1h 30m');
  });

  it('uses current time for building stacks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:10:00Z'));
    const result = getStackDuration(
      '2026-03-25 10:00:00',
      '2026-03-25 10:05:00',
      'building'
    );
    expect(result).toBe('10m');
  });
});

describe('DURATION_UPDATE_INTERVAL', () => {
  it('is 5 seconds', () => {
    expect(DURATION_UPDATE_INTERVAL).toBe(5000);
  });
});
