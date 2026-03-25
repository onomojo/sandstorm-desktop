import { EventEmitter } from 'events';

/**
 * Manages Docker daemon connectivity with health monitoring,
 * rate limiting, exponential backoff, and reconnection handling.
 *
 * Emits:
 *  - 'connected'    — Docker daemon became available
 *  - 'disconnected' — Docker daemon became unavailable
 */
export class DockerConnectionManager extends EventEmitter {
  private _isConnected = false;
  private healthInterval: NodeJS.Timeout | null = null;
  private pingFn: () => Promise<boolean>;

  /** Exponential backoff state for API calls */
  private failureCount = 0;
  private backoffUntil = 0;

  /** Rate limiting: track in-flight stats calls */
  private statsInFlight = 0;
  private readonly maxConcurrentStats: number;

  /** Rate limiting: throttle API calls per window */
  private callTimestamps: number[] = [];
  private readonly maxCallsPerWindow: number;
  private readonly windowMs: number;

  /** Health check interval (ms) — faster when disconnected to detect recovery */
  private readonly healthIntervalConnected: number;
  private readonly healthIntervalDisconnected: number;

  constructor(
    pingFn: () => Promise<boolean>,
    opts?: {
      maxConcurrentStats?: number;
      maxCallsPerWindow?: number;
      windowMs?: number;
      healthIntervalConnected?: number;
      healthIntervalDisconnected?: number;
    }
  ) {
    super();
    this.pingFn = pingFn;
    this.maxConcurrentStats = opts?.maxConcurrentStats ?? 4;
    this.maxCallsPerWindow = opts?.maxCallsPerWindow ?? 30;
    this.windowMs = opts?.windowMs ?? 10_000;
    this.healthIntervalConnected = opts?.healthIntervalConnected ?? 15_000;
    this.healthIntervalDisconnected = opts?.healthIntervalDisconnected ?? 5_000;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Start periodic health checks. Call once at app startup.
   */
  start(): void {
    if (this.healthInterval) return;
    this.scheduleHealthCheck();
    // Do an immediate check
    this.checkHealth().catch(() => {});
  }

  /**
   * Stop health checks. Call on app shutdown.
   */
  stop(): void {
    if (this.healthInterval) {
      clearTimeout(this.healthInterval);
      this.healthInterval = null;
    }
  }

  /**
   * Check if we should back off from API calls.
   * Returns true if the caller should proceed, false if it should skip.
   */
  shouldThrottle(): boolean {
    if (!this._isConnected) return true;
    if (Date.now() < this.backoffUntil) return true;
    return false;
  }

  /**
   * Check rate limit. Returns true if the call is allowed.
   */
  acquireRateLimit(): boolean {
    const now = Date.now();
    // Prune old timestamps
    this.callTimestamps = this.callTimestamps.filter(
      (t) => now - t < this.windowMs
    );
    if (this.callTimestamps.length >= this.maxCallsPerWindow) {
      return false;
    }
    this.callTimestamps.push(now);
    return true;
  }

  /**
   * Guard for concurrent stats calls. Returns true if allowed.
   */
  acquireStatsSlot(): boolean {
    if (this.statsInFlight >= this.maxConcurrentStats) return false;
    this.statsInFlight++;
    return true;
  }

  releaseStatsSlot(): void {
    this.statsInFlight = Math.max(0, this.statsInFlight - 1);
  }

  /**
   * Report a successful API call — resets backoff.
   */
  reportSuccess(): void {
    this.failureCount = 0;
    this.backoffUntil = 0;
  }

  /**
   * Report a failed API call — increments backoff.
   */
  reportFailure(): void {
    this.failureCount++;
    const delay = Math.min(1000 * Math.pow(2, this.failureCount - 1), 30_000);
    this.backoffUntil = Date.now() + delay;
  }

  /**
   * Get current backoff delay in ms (0 if not backing off).
   */
  get currentBackoffMs(): number {
    const remaining = this.backoffUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  private async checkHealth(): Promise<void> {
    try {
      const available = await this.pingFn();
      if (available && !this._isConnected) {
        this._isConnected = true;
        this.failureCount = 0;
        this.backoffUntil = 0;
        this.emit('connected');
      } else if (!available && this._isConnected) {
        this._isConnected = false;
        this.emit('disconnected');
      } else if (available) {
        // Still connected — just note it
        this._isConnected = true;
      } else {
        this._isConnected = false;
      }
    } catch {
      if (this._isConnected) {
        this._isConnected = false;
        this.emit('disconnected');
      }
    }
  }

  private scheduleHealthCheck(): void {
    const interval = this._isConnected
      ? this.healthIntervalConnected
      : this.healthIntervalDisconnected;
    this.healthInterval = setTimeout(async () => {
      await this.checkHealth();
      // Reschedule with potentially different interval
      if (this.healthInterval !== null) {
        this.scheduleHealthCheck();
      }
    }, interval);
  }

  destroy(): void {
    this.stop();
    this.removeAllListeners();
  }
}
