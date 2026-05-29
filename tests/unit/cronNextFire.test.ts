import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cronNextFire, formatRelativeTime, formatElapsedTime } from '../../src/renderer/utils/cronNextFire';

// Fixed reference time: 2026-05-29T10:30:00.000Z (a Friday, 10:30 UTC)
const FIXED_NOW = new Date('2026-05-29T10:30:00.000Z').getTime();

describe('cronNextFire', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for invalid expressions', () => {
    expect(cronNextFire('invalid')).toBeNull();
    expect(cronNextFire('* * *')).toBeNull();
  });

  it('returns a Date in the future for "* * * * *"', () => {
    const next = cronNextFire('* * * * *');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(FIXED_NOW);
  });

  it('next fire for "0 * * * *" is on the next hour boundary', () => {
    const next = cronNextFire('0 * * * *');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getMinutes()).toBe(0);
    expect(next!.getTime()).toBeGreaterThan(FIXED_NOW);
  });

  it('next fire for "*/15 * * * *" is a multiple of 15 minutes', () => {
    const next = cronNextFire('*/15 * * * *');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getMinutes() % 15).toBe(0);
  });

  it('next fire for "0 0 * * *" is midnight', () => {
    const next = cronNextFire('0 0 * * *');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getMinutes()).toBe(0);
    expect(next!.getTime()).toBeGreaterThan(FIXED_NOW);
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats sub-minute as "in <1 min"', () => {
    const soon = new Date(FIXED_NOW + 30_000);
    expect(formatRelativeTime(soon)).toBe('in <1 min');
  });

  it('formats minutes correctly', () => {
    const in5 = new Date(FIXED_NOW + 5 * 60_000);
    expect(formatRelativeTime(in5)).toBe('in 5m');
  });

  it('formats hours correctly', () => {
    const in3h = new Date(FIXED_NOW + 3 * 3600_000);
    expect(formatRelativeTime(in3h)).toBe('in 3h');
  });

  it('returns "overdue" for past dates', () => {
    const past = new Date(FIXED_NOW - 60_000);
    expect(formatRelativeTime(past)).toBe('overdue');
  });
});

describe('formatElapsedTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats seconds ago', () => {
    expect(formatElapsedTime(FIXED_NOW - 45_000)).toBe('45s ago');
  });

  it('formats minutes ago', () => {
    expect(formatElapsedTime(FIXED_NOW - 3 * 60_000)).toBe('3m ago');
  });

  it('formats hours ago', () => {
    expect(formatElapsedTime(FIXED_NOW - 2 * 3600_000)).toBe('2h ago');
  });
});
