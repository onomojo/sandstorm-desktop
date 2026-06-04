/**
 * Retry fn up to maxAttempts times. Between consecutive attempts, waits
 * baseDelayMs * 2^(attempt-1) milliseconds (1×, 2×, 4×, …).
 * The delay function is injectable so callers can supply fake timers in tests.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts: number;
    baseDelayMs: number;
    delay?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const sleep =
    opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < opts.maxAttempts) {
        await sleep(opts.baseDelayMs * Math.pow(2, attempt - 1));
      }
    }
  }
  throw lastErr;
}
