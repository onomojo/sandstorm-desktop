import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the account-usage module before importing SessionMonitor
vi.mock('../../src/main/control-plane/account-usage', () => ({
  fetchAccountUsage: vi.fn(),
}));

import { SessionMonitor, DEFAULT_SESSION_MONITOR_SETTINGS } from '../../src/main/control-plane/session-monitor';
import { fetchAccountUsage } from '../../src/main/control-plane/account-usage';

const mockFetchAccountUsage = fetchAccountUsage as ReturnType<typeof vi.fn>;

function makeUsage(overrides: Partial<{
  used_tokens: number;
  limit_tokens: number;
  percent: number;
  reset_at: string | null;
  reset_in: string | null;
  subscription_type: string | null;
  rate_limit_tier: string | null;
}> = {}) {
  return {
    used_tokens: 0,
    limit_tokens: 1_000_000,
    percent: 0,
    reset_at: null,
    reset_in: null,
    subscription_type: 'max',
    rate_limit_tier: null,
    ...overrides,
  };
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
      expect(monitor.getSettings().criticalThreshold).toBe(95);
    });

    it('starts with normal state', () => {
      monitor = new SessionMonitor();
      const state = monitor.getState();
      expect(state.level).toBe('normal');
      expect(state.usage).toBeNull();
      expect(state.halted).toBe(false);
      expect(state.stale).toBe(false);
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
      expect(monitor.computeLevel(90)).toBe('warning');
      expect(monitor.computeLevel(94)).toBe('warning');
    });

    it('returns critical at critical threshold', () => {
      monitor = new SessionMonitor();
      expect(monitor.computeLevel(95)).toBe('critical');
      expect(monitor.computeLevel(99)).toBe('critical');
    });

    it('returns limit at auto-halt threshold', () => {
      monitor = new SessionMonitor();
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
      expect(monitor.computeLevel(91)).toBe('limit');
      // over_limit requires both >= autoHaltThreshold AND > 100
      expect(monitor.computeLevel(101)).toBe('over_limit');
    });
  });

  describe('polling and threshold events', () => {
    it('polls immediately on start and emits state:changed', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 50, used_tokens: 500000 }));
      monitor = new SessionMonitor();
      const stateChanged = vi.fn();
      monitor.on('state:changed', stateChanged);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(1);
      expect(stateChanged).toHaveBeenCalled();
      expect(monitor.getState().level).toBe('normal');
      expect(monitor.getState().usage?.percent).toBe(50);
    });

    it('emits threshold:warning when crossing warning threshold', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 85 }));
      monitor = new SessionMonitor();
      const warningFn = vi.fn();
      monitor.on('threshold:warning', warningFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(warningFn).toHaveBeenCalledTimes(1);
      expect(monitor.getState().level).toBe('warning');
    });

    it('emits threshold:critical when crossing critical threshold', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 96 }));
      monitor = new SessionMonitor();
      const criticalFn = vi.fn();
      monitor.on('threshold:critical', criticalFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(criticalFn).toHaveBeenCalledTimes(1);
      expect(monitor.getState().level).toBe('critical');
    });

    it('emits threshold:limit and halt:triggered when hitting auto-halt threshold', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 100 }));
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
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 100 }));
      monitor = new SessionMonitor({ autoHaltEnabled: false });
      const haltFn = vi.fn();
      monitor.on('halt:triggered', haltFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(haltFn).not.toHaveBeenCalled();
      expect(monitor.getState().halted).toBe(false);
    });

    it('does not fire duplicate threshold events for the same level', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 85 }));
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      const warningFn = vi.fn();
      monitor.on('threshold:warning', warningFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(warningFn).toHaveBeenCalledTimes(1);

      // Second poll at same level — should not fire again
      await vi.advanceTimersByTimeAsync(1000);
      expect(warningFn).toHaveBeenCalledTimes(1);
    });

    it('emits threshold:cleared when usage drops back to normal', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 85 }));
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      const clearedFn = vi.fn();
      monitor.on('threshold:cleared', clearedFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.getState().level).toBe('warning');

      // Usage drops
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 50 }));
      await vi.advanceTimersByTimeAsync(1000);

      expect(clearedFn).toHaveBeenCalledTimes(1);
      expect(monitor.getState().level).toBe('normal');
    });

    it('polls at configured interval', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 10 }));
      monitor = new SessionMonitor({ pollIntervalMs: 5000 });

      monitor.start();
      await vi.advanceTimersByTimeAsync(0); // immediate poll
      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000); // second poll
      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5000); // third poll
      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(3);
    });
  });

  describe('stale data handling', () => {
    it('marks data as stale after 3 consecutive failures', async () => {
      mockFetchAccountUsage.mockResolvedValue(null);
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      const staleFn = vi.fn();
      monitor.on('stale', staleFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0); // failure 1
      expect(monitor.getState().stale).toBe(false);

      await vi.advanceTimersByTimeAsync(1000); // failure 2
      expect(monitor.getState().stale).toBe(false);

      await vi.advanceTimersByTimeAsync(1000); // failure 3
      expect(monitor.getState().stale).toBe(true);
      expect(staleFn).toHaveBeenCalledTimes(1);
    });

    it('clears stale flag on successful poll', async () => {
      mockFetchAccountUsage.mockResolvedValue(null);
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000); // now stale
      expect(monitor.getState().stale).toBe(true);

      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 30 }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(monitor.getState().stale).toBe(false);
      expect(monitor.getState().consecutiveFailures).toBe(0);
    });
  });

  describe('session reset detection', () => {
    it('emits session:reset when usage drops significantly', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 85 }));
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      const resetFn = vi.fn();
      monitor.on('session:reset', resetFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.getState().level).toBe('warning');

      // Simulate session reset — usage drops to near zero
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 2 }));
      await vi.advanceTimersByTimeAsync(1000);

      expect(resetFn).toHaveBeenCalledTimes(1);
      expect(monitor.getState().halted).toBe(false);
    });

    it('clears fired thresholds on session reset', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 85 }));
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      const warningFn = vi.fn();
      monitor.on('threshold:warning', warningFn);

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(warningFn).toHaveBeenCalledTimes(1);

      // Session reset
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 2 }));
      await vi.advanceTimersByTimeAsync(1000);

      // Usage climbs back up — warning should fire again
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 85 }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(warningFn).toHaveBeenCalledTimes(2);
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
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 100 }));
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
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 42 }));
      monitor = new SessionMonitor();

      const state = await monitor.forcePoll();
      expect(state.usage?.percent).toBe(42);
      expect(state.level).toBe('normal');
    });
  });

  describe('updateSettings', () => {
    it('updates settings', () => {
      monitor = new SessionMonitor();
      monitor.updateSettings({ warningThreshold: 60 });
      expect(monitor.getSettings().warningThreshold).toBe(60);
    });

    it('restarts polling when interval changes', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 10 }));
      monitor = new SessionMonitor({ pollIntervalMs: 5000 });
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      monitor.updateSettings({ pollIntervalMs: 2000 });
      // Should have restarted — immediate poll on restart
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(2);
    });
  });

  describe('start/stop', () => {
    it('does not double-start', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 10 }));
      monitor = new SessionMonitor({ pollIntervalMs: 5000 });
      monitor.start();
      monitor.start(); // second call should be no-op
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(1);
    });

    it('stops polling on stop()', async () => {
      mockFetchAccountUsage.mockResolvedValue(makeUsage({ percent: 10 }));
      monitor = new SessionMonitor({ pollIntervalMs: 1000 });
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchAccountUsage).toHaveBeenCalledTimes(1);

      monitor.stop();
      await vi.advanceTimersByTimeAsync(5000);
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
  });
});
