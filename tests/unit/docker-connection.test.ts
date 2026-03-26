import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerConnectionManager } from '../../src/main/runtime/docker-connection';

describe('DockerConnectionManager', () => {
  let manager: DockerConnectionManager;
  let pingFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    pingFn = vi.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    manager?.destroy();
    vi.useRealTimers();
  });

  // --- Health monitoring ---

  it('emits connected when Docker becomes available', async () => {
    pingFn.mockResolvedValue(false);
    manager = new DockerConnectionManager(pingFn, {
      healthIntervalConnected: 100,
      healthIntervalDisconnected: 50,
    });

    const connectedSpy = vi.fn();
    manager.on('connected', connectedSpy);

    manager.start();
    // Initial check — Docker down
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.isConnected).toBe(false);
    expect(connectedSpy).not.toHaveBeenCalled();

    // Docker comes back
    pingFn.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(connectedSpy).toHaveBeenCalledTimes(1);
    expect(manager.isConnected).toBe(true);
  });

  it('emits disconnected when Docker becomes unavailable', async () => {
    manager = new DockerConnectionManager(pingFn, {
      healthIntervalConnected: 100,
      healthIntervalDisconnected: 50,
    });

    const disconnectedSpy = vi.fn();
    manager.on('disconnected', disconnectedSpy);

    manager.start();
    // Initial check — Docker up
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.isConnected).toBe(true);

    // Docker goes down
    pingFn.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(disconnectedSpy).toHaveBeenCalledTimes(1);
    expect(manager.isConnected).toBe(false);
  });

  it('does not emit duplicate connected events', async () => {
    manager = new DockerConnectionManager(pingFn, {
      healthIntervalConnected: 50,
      healthIntervalDisconnected: 50,
    });

    const connectedSpy = vi.fn();
    manager.on('connected', connectedSpy);

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    // connected emitted once on first successful check, not again
    expect(connectedSpy).toHaveBeenCalledTimes(1);
  });

  it('handles ping throwing an error', async () => {
    pingFn.mockRejectedValue(new Error('socket hang up'));
    manager = new DockerConnectionManager(pingFn, {
      healthIntervalConnected: 100,
      healthIntervalDisconnected: 50,
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.isConnected).toBe(false);
  });

  // --- Reconnection cycle ---

  it('recovers from disconnection and emits connected again', async () => {
    manager = new DockerConnectionManager(pingFn, {
      healthIntervalConnected: 100,
      healthIntervalDisconnected: 50,
    });

    const events: string[] = [];
    manager.on('connected', () => events.push('connected'));
    manager.on('disconnected', () => events.push('disconnected'));

    manager.start();
    await vi.advanceTimersByTimeAsync(0); // connected

    pingFn.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(100); // disconnected

    pingFn.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(50); // reconnected

    expect(events).toEqual(['connected', 'disconnected', 'connected']);
  });

  // --- Rate limiting ---

  it('acquireRateLimit enforces max calls per window', () => {
    manager = new DockerConnectionManager(pingFn, {
      maxCallsPerWindow: 3,
      windowMs: 1000,
    });

    expect(manager.acquireRateLimit()).toBe(true);
    expect(manager.acquireRateLimit()).toBe(true);
    expect(manager.acquireRateLimit()).toBe(true);
    expect(manager.acquireRateLimit()).toBe(false); // 4th call rejected

    // After window expires, should allow again
    vi.advanceTimersByTime(1001);
    expect(manager.acquireRateLimit()).toBe(true);
  });

  // --- Stats concurrency ---

  it('acquireStatsSlot limits concurrent stats', () => {
    manager = new DockerConnectionManager(pingFn, {
      maxConcurrentStats: 2,
    });

    expect(manager.acquireStatsSlot()).toBe(true);
    expect(manager.acquireStatsSlot()).toBe(true);
    expect(manager.acquireStatsSlot()).toBe(false); // 3rd rejected

    manager.releaseStatsSlot();
    expect(manager.acquireStatsSlot()).toBe(true); // 1 slot freed
  });

  // --- Exponential backoff ---

  it('shouldThrottle returns false when connected and no backoff', async () => {
    manager = new DockerConnectionManager(pingFn, {
      healthIntervalConnected: 1000,
    });
    manager.start();
    await vi.advanceTimersByTimeAsync(0); // initial check → connected
    expect(manager.isConnected).toBe(true);
    expect(manager.shouldThrottle()).toBe(false);
  });

  it('shouldThrottle returns true when disconnected', async () => {
    pingFn.mockResolvedValue(false);
    manager = new DockerConnectionManager(pingFn, {
      healthIntervalDisconnected: 50,
    });
    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.shouldThrottle()).toBe(true);
  });

  it('shouldThrottle returns true during backoff', async () => {
    manager = new DockerConnectionManager(pingFn, {
      healthIntervalConnected: 1000,
    });
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.isConnected).toBe(true);

    manager.reportFailure();
    expect(manager.shouldThrottle()).toBe(true);
    expect(manager.currentBackoffMs).toBeGreaterThan(0);

    // After backoff expires
    vi.advanceTimersByTime(1500);
    expect(manager.shouldThrottle()).toBe(false);
  });

  it('backoff increases exponentially', () => {
    manager = new DockerConnectionManager(pingFn);

    manager.reportFailure(); // 1: 1000ms
    const first = manager.currentBackoffMs;

    vi.advanceTimersByTime(first + 1);
    manager.reportFailure(); // 2: 2000ms
    const second = manager.currentBackoffMs;

    vi.advanceTimersByTime(second + 1);
    manager.reportFailure(); // 3: 4000ms
    const third = manager.currentBackoffMs;

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('reportSuccess resets backoff', () => {
    manager = new DockerConnectionManager(pingFn);

    manager.reportFailure();
    expect(manager.currentBackoffMs).toBeGreaterThan(0);

    manager.reportSuccess();
    expect(manager.currentBackoffMs).toBe(0);
  });

  // --- Cleanup ---

  it('stop clears health check timer', async () => {
    manager = new DockerConnectionManager(pingFn, {
      healthIntervalConnected: 50,
    });
    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    const callCount = pingFn.mock.calls.length;
    manager.stop();

    await vi.advanceTimersByTimeAsync(200);
    expect(pingFn.mock.calls.length).toBe(callCount);
  });

  it('destroy removes all listeners and stops', () => {
    manager = new DockerConnectionManager(pingFn);
    const spy = vi.fn();
    manager.on('connected', spy);

    manager.destroy();
    manager.emit('connected');
    expect(spy).not.toHaveBeenCalled();
  });
});
