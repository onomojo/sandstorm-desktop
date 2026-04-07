import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the account-usage module before importing SessionMonitor
vi.mock('../../src/main/control-plane/account-usage', () => ({
  fetchAccountUsage: vi.fn(),
  checkTmuxInstalled: vi.fn().mockResolvedValue(true),
}));

import { SessionMonitor, DEFAULT_SESSION_MONITOR_SETTINGS } from '../../src/main/control-plane/session-monitor';
import { fetchAccountUsage, checkTmuxInstalled } from '../../src/main/control-plane/account-usage';
import type { UsageSnapshot } from '../../src/main/control-plane/account-usage';

const mockFetchAccountUsage = fetchAccountUsage as ReturnType<typeof vi.fn>;

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    session: { percent: 0, resetsAt: '6pm (America/New_York)' },
    weekAll: null,
    weekSonnet: null,
    extraUsage: { enabled: false },
    capturedAt: new Date().toISOString(),
    status: 'ok',
    ...overrides,
  };
}

function makeSnapshotWithPercent(percent: number): UsageSnapshot {
  return makeSnapshot({
    session: { percent, resetsAt: '6pm (America/New_York)' },
    status: percent >= 95 ? 'at_limit' : 'ok',
  });
}

describe('SessionMonitor', () => {
  let monitor: SessionMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchAccountUsage.mockReset();
  });

  afterEach(() => {
    monitor?.destroy();
    vi.useRealTimers();
  });

  describe('constructor and defaults', () => {
    it('uses default settings when none provided', () => {
      monitor = new SessionMonitor();
      expect(monitor.getSettings()).toEqual(DEFAULT_SESSION_MONITOR_SETTINGS);
    });

    it('merges partial settings with defaults', () => {
      monitor = new SessionMonitor({ warningThreshold: 70 });
      expect(monitor.getSettings().warningThreshold).toBe(70);
      expect(monitor.getSettings().criticalThreshold).toBe(90);
    });

    it('starts with normal state', () => {
      monitor = new SessionMonitor();
      const state = monitor.getState();
      expect(state.level).toBe('normal');
      expect(state.usage).toBeNull();
      expect(state.halted).toBe(false);
      expect(state.stale).toBe(false);
      expect(state.pollMode).toBe('normal');
      expect(state.idle).toBe(false);
    });
  });

  describe('computeLevel', () => {
    it('returns normal below warning threshold', () => {
      monitor = new SessionMonitor();
      expect(monitor.computeLevel(0)).toBe('normal');
      expect(monitor.computeLevel(50)).toBe('normal');
      expect(monitor.computeLevel(79)).toBe('normal');
    });

    it('returns warning at warning threshold', () => {
      monitor = new SessionMonitor();
      expect(monitor.computeLevel(80)).toBe('warning');
      expect(monitor.computeLevel(85)).toBe('warning');
      expect(monitor.computeLevel(89)).toBe('warning');
    });

    it('returns critical at critical threshold (90%)', () => {
      monitor = new SessionMonitor();
      expect(monitor.computeLevel(90)).toBe('critical');
      expect(monitor.computeLevel(94)).toBe('critical');
    });

    it('returns limit at auto-halt threshold (95%)', () => {
      monitor = new SessionMonitor();
      expect(monitor.computeLevel(95)).toBe('limit');
      expect(monitor.computeLevel(100)).toBe('limit');
    });

    it('returns over_limit when over 100%', () => {
      monitor = new SessionMonitor();
      expect(monitor.computeLevel(101)).toBe('over_limit');
      expect(monitor.computeLevel(150)).toBe('over_limit');
    });

    it('respects custom thresholds', () => {
      monitor = new SessionMonitor({
        warningThreshold: 60,
        criticalThreshold: 80,
        autoHaltThreshold: 90,
      });
      expect(monitor.computeLevel(59)).toBe('normal');
      expect(monitor.computeLevel(60)).toBe('warning');
      expect(monitor.computeLevel(80)).toBe('critical');
      expect(monitor.computeLevel(90)).toBe('limit');
      expect(monitor.computeLevel(101)).toBe('over_limit');
    });
  });

  describe('polling and threshold events', () => {
    it('polls immediately on start and emits state:changed', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(50));
      monitor = new SessionMonitor();
      const stateChanged = vi.fn();
      monitor.on('state:changed', stateChanged);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(1);
      expect(stateChanged).toHaveBeenCalled();
      expect(monitor.getState().level).toBe('normal');
      expect(monitor.getState().usage?.session?.percent).toBe(50);
    });

    it('emits threshold:warning when crossing warning threshold', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(85));
      monitor = new SessionMonitor();
      const warningFn = vi.fn();
      monitor.on('threshold:warning', warningFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(warningFn).toHaveBeenCalledTimes(1);
      expect(monitor.getState().level).toBe('warning');
    });

    it('emits threshold:critical when crossing critical threshold', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(92));
      monitor = new SessionMonitor();
      const criticalFn = vi.fn();
      monitor.on('threshold:critical', criticalFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(criticalFn).toHaveBeenCalledTimes(1);
      expect(monitor.getState().level).toBe('critical');
    });

    it('emits threshold:limit and halt:triggered when hitting auto-halt threshold', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(95));
      monitor = new SessionMonitor();
      const limitFn = vi.fn();
      const haltFn = vi.fn();
      monitor.on('threshold:limit', limitFn);
      monitor.on('halt:triggered', haltFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(limitFn).toHaveBeenCalledTimes(1);
      expect(haltFn).toHaveBeenCalledTimes(1);
      expect(monitor.getState().halted).toBe(true);
    });

    it('does not emit halt:triggered when autoHaltEnabled is false', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(95));
      monitor = new SessionMonitor({ autoHaltEnabled: false });
      const haltFn = vi.fn();
      monitor.on('halt:triggered', haltFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(haltFn).not.toHaveBeenCalled();
      expect(monitor.getState().halted).toBe(false);
    });

    it('does not fire duplicate threshold events for the same level', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(85));
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      const warningFn = vi.fn();
      monitor.on('threshold:warning', warningFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(warningFn).toHaveBeenCalledTimes(1);

      // Second poll at same level — should not fire again
      await vi.advanceTimersByTimeAsync(12_000);
      expect(warningFn).toHaveBeenCalledTimes(1);
    });

    it('emits threshold:cleared when usage drops back to normal', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(85));
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      const clearedFn = vi.fn();
      monitor.on('threshold:cleared', clearedFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.getState().level).toBe('warning');

      // Usage drops — advance past poll interval + max jitter
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(50));
      await vi.advanceTimersByTimeAsync(12_000);

      expect(clearedFn).toHaveBeenCalledTimes(1);
      expect(monitor.getState().level).toBe('normal');
    });
  });

  describe('three-mode state machine', () => {
    it('enters at_limit mode when session percent >= autoHaltThreshold', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(96));
      monitor = new SessionMonitor();

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(monitor.getState().pollMode).toBe('at_limit');
    });

    it('stays in normal mode when below threshold', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(50));
      monitor = new SessionMonitor();

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(monitor.getState().pollMode).toBe('normal');
    });

    it('enters rate_limited mode on rate-limit response', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshot({
        session: null,
        status: 'rate_limited',
      }));
      monitor = new SessionMonitor();

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(monitor.getState().pollMode).toBe('rate_limited');
    });

    it('enters error mode on parse errors', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshot({
        session: null,
        status: 'parse_error',
      }));
      monitor = new SessionMonitor();

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(monitor.getState().pollMode).toBe('error');
    });

    it('returns to normal mode after successful poll from rate_limited', async () => {
      // First poll: rate limited. Use long idle timeout to avoid idle gating.
      mockFetchAccountUsage.mockResolvedValue(makeSnapshot({
        session: null,
        status: 'rate_limited',
      }));
      monitor = new SessionMonitor({ idleTimeoutMs: 600_000 });

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.getState().pollMode).toBe('rate_limited');

      // Second poll: success (after first rate limit backoff of 5 min)
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(50));
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);

      expect(monitor.getState().pollMode).toBe('normal');
    });
  });

  describe('stale data handling', () => {
    it('marks data as stale after 3 consecutive failures', async () => {
      mockFetchAccountUsage.mockResolvedValue(null);
      // Use long idle timeout to avoid idle gating during error backoff
      monitor = new SessionMonitor({ pollIntervalMs: 1000, idleTimeoutMs: 600_000 });
      const staleFn = vi.fn();
      monitor.on('stale', staleFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0); // failure 1
      expect(monitor.getState().stale).toBe(false);

      // Error backoff: 30s
      await vi.advanceTimersByTimeAsync(31_000); // failure 2
      expect(monitor.getState().stale).toBe(false);

      // Error backoff: 60s
      await vi.advanceTimersByTimeAsync(61_000); // failure 3
      expect(monitor.getState().stale).toBe(true);
      expect(staleFn).toHaveBeenCalledTimes(1);
    });

    it('clears stale flag on successful poll', async () => {
      mockFetchAccountUsage.mockResolvedValue(null);
      monitor = new SessionMonitor({ pollIntervalMs: 1000, idleTimeoutMs: 600_000 });

      monitor.start();
      await vi.advanceTimersByTimeAsync(0); // failure 1
      await vi.advanceTimersByTimeAsync(31_000); // failure 2 (30s backoff)
      await vi.advanceTimersByTimeAsync(61_000); // failure 3 (60s backoff)
      expect(monitor.getState().stale).toBe(true);

      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(30));
      // Error backoff: 2 min
      await vi.advanceTimersByTimeAsync(121_000);
      expect(monitor.getState().stale).toBe(false);
      expect(monitor.getState().consecutiveFailures).toBe(0);
    });
  });

  describe('session reset detection', () => {
    it('emits session:reset when usage drops significantly', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(85));
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      const resetFn = vi.fn();
      monitor.on('session:reset', resetFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.getState().level).toBe('warning');

      // Simulate session reset — usage drops to near zero
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(2));
      await vi.advanceTimersByTimeAsync(12_000);

      expect(resetFn).toHaveBeenCalledTimes(1);
      expect(monitor.getState().halted).toBe(false);
    });

    it('clears fired thresholds on session reset', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(85));
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      const warningFn = vi.fn();
      monitor.on('threshold:warning', warningFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(warningFn).toHaveBeenCalledTimes(1);

      // Session reset
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(2));
      await vi.advanceTimersByTimeAsync(12_000);

      // Usage climbs back up — warning should fire again
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(85));
      await vi.advanceTimersByTimeAsync(12_000);
      expect(warningFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('idle gating', () => {
    it('enters idle after timeout when below warning', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(50));
      monitor = new SessionMonitor({ idleTimeoutMs: 5000, pollIntervalMs: 1000 });

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.getState().idle).toBe(false);

      // Advance past idle timeout — idle check runs every 30s
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.getState().idle).toBe(true);
    });

    it('does NOT enter idle when usage is at or above warning threshold', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(85));
      monitor = new SessionMonitor({ idleTimeoutMs: 5000, pollIntervalMs: 1000 });

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      // Advance past idle timeout
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.getState().idle).toBe(false);
    });

    it('exits idle on reportActivity and triggers poll', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(50));
      monitor = new SessionMonitor({ idleTimeoutMs: 5000, pollIntervalMs: 1000 });

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      // Go idle
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.getState().idle).toBe(true);

      // Report activity
      const callCount = mockFetchAccountUsage.mock.calls.length;
      monitor.reportActivity();
      await vi.advanceTimersByTimeAsync(0);

      expect(monitor.getState().idle).toBe(false);
      expect(mockFetchAccountUsage.mock.calls.length).toBeGreaterThan(callCount);
    });
  });

  describe('acknowledgeCritical', () => {
    it('can be called without error', async () => {
      monitor = new SessionMonitor();
      expect(() => monitor.acknowledgeCritical()).not.toThrow();
    });
  });

  describe('markResumed', () => {
    it('clears halted state', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(95));
      monitor = new SessionMonitor();

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.getState().halted).toBe(true);

      monitor.markResumed();
      expect(monitor.getState().halted).toBe(false);
    });
  });

  describe('forcePoll', () => {
    it('performs an immediate poll and returns state', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(42));
      monitor = new SessionMonitor();

      const state = await monitor.forcePoll();
      expect(state.usage?.session?.percent).toBe(42);
      expect(state.level).toBe('normal');
    });

    it('does not force poll when rate limited', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshot({
        session: null,
        status: 'rate_limited',
      }));
      monitor = new SessionMonitor();

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.getState().pollMode).toBe('rate_limited');

      const callCount = mockFetchAccountUsage.mock.calls.length;
      await monitor.forcePoll();
      // Should NOT have made another call
      expect(mockFetchAccountUsage.mock.calls.length).toBe(callCount);
    });
  });

  describe('updateSettings', () => {
    it('updates settings', () => {
      monitor = new SessionMonitor();
      monitor.updateSettings({ warningThreshold: 60 });
      expect(monitor.getSettings().warningThreshold).toBe(60);
    });
  });

  describe('start/stop', () => {
    it('does not double-start', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(10));
      monitor = new SessionMonitor({ pollIntervalMs: 5000 });
      monitor.start();
      monitor.start(); // second call should be no-op
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(1);
    });

    it('stops polling on stop()', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(10));
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(1);

      monitor.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(1);
    });

    it('destroy() stops and removes listeners', async () => {
      monitor = new SessionMonitor();
      const fn = vi.fn();
      monitor.on('state:changed', fn);
      monitor.destroy();
      monitor.emit('state:changed', {});
      expect(fn).not.toHaveBeenCalled();
    });

    it('does not poll when pollingDisabled is true', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeSnapshotWithPercent(50));
      monitor = new SessionMonitor({ pollingDisabled: true });

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchAccountUsage).not.toHaveBeenCalled();
    });
  });
});
