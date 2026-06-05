import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../src/main/control-plane/retry-with-backoff';

describe('withRetry', () => {
  it('returns result on first-attempt success without calling delay', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1000, delay: sleep });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on failure and returns result on second attempt (success-on-retry)', async () => {
    const delays: number[] = [];
    const sleep = vi.fn().mockImplementation((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce('recovered');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1000, delay: sleep });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000]); // 1 s wait before attempt 2
  });

  it('exhausts all 3 attempts and re-throws the last error', async () => {
    const delays: number[] = [];
    const sleep = vi.fn().mockImplementation((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1000, delay: sleep }),
    ).rejects.toThrow('always fails');

    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1000, 2000]); // 1 s then 2 s between the three attempts
  });

  it('uses exponential backoff: base * 2^(attempt-1) before each retry', async () => {
    const delays: number[] = [];
    const sleep = vi.fn().mockImplementation((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1000, delay: sleep }),
    ).rejects.toThrow();

    expect(delays).toEqual([1000, 2000]);
  });

  it('does NOT wait after the last failed attempt', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1000, delay: sleep }),
    ).rejects.toThrow();

    // 3 attempts → only 2 waits (between attempts 1→2 and 2→3, never after attempt 3)
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('uses setTimeout by default (no injectable delay needed)', async () => {
    vi.useFakeTimers();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce('done');

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
