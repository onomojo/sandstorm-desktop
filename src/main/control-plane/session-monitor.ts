/**
 * Session token limit monitor — polls real account-level usage data via the
 * node-pty-based CLI approach and triggers warnings / auto-halt when configurable
 * thresholds are crossed.
 *
 * Implements a three-mode polling state machine:
 *   Mode A (Normal)       — poll every ~2 min with jitter
 *   Mode B (At Limit)     — stop polling, wake at session reset time
 *   Mode C (Rate Limited) — doubling backoff: 5→10→20→40 min cap
 *
 * Also implements idle gating: stops polling when the app has been idle for
 * a configurable period (default 5 min), unless usage is near the warning
 * threshold. Resumes instantly on user interaction.
 */

import { EventEmitter } from 'events';
import { fetchAccountUsage, UsageSnapshot, checkClaudeInstalled } from './account-usage';

// ---------------------------------------------------------------------------
// Settings & types
// ---------------------------------------------------------------------------

export interface SessionMonitorSettings {
  /** Percentage at which a non-blocking warning is shown (default 80) */
  warningThreshold: number;
  /** Percentage at which a blocking warning modal is shown (default 90) */
  criticalThreshold: number;
  /** Percentage at which auto-halt triggers (default 95) */
  autoHaltThreshold: number;
  /** Whether auto-halt is enabled (default true) */
  autoHaltEnabled: boolean;
  /** Whether to auto-resume after session reset (default false) */
  autoResumeAfterReset: boolean;
  /** Normal-mode polling interval in ms (default 120_000 = 2 min) */
  pollIntervalMs: number;
  /** Idle timeout in ms before polling pauses (default 300_000 = 5 min) */
  idleTimeoutMs: number;
  /** Master toggle to disable all polling (default false) */
  pollingDisabled: boolean;
}

export const DEFAULT_SESSION_MONITOR_SETTINGS: SessionMonitorSettings = {
  warningThreshold: 80,
  criticalThreshold: 90,
  autoHaltThreshold: 95,
  autoHaltEnabled: true,
  autoResumeAfterReset: false,
  pollIntervalMs: 120_000,
  idleTimeoutMs: 300_000,
  pollingDisabled: false,
};

export type ThresholdLevel = 'normal' | 'warning' | 'critical' | 'limit' | 'over_limit';

export type PollMode = 'normal' | 'at_limit' | 'rate_limited' | 'error';

export interface SessionMonitorState {
  /** Current usage snapshot (null if unavailable) */
  usage: UsageSnapshot | null;
  /** Current threshold level */
  level: ThresholdLevel;
  /** Whether data is stale (source unavailable) */
  stale: boolean;
  /** Whether stacks were auto-halted due to session limit */
  halted: boolean;
  /** Timestamp of last successful poll */
  lastPollAt: string | null;
  /** Number of consecutive poll failures */
  consecutiveFailures: number;
  /** Current polling mode */
  pollMode: PollMode;
  /** ISO timestamp of next scheduled poll */
  nextPollAt: string | null;
  /** Whether the app is considered idle (polling paused) */
  idle: boolean;
  /** Whether the claude CLI is available for usage collection */
  claudeAvailable: boolean | null;
}

// ---------------------------------------------------------------------------
// SessionMonitor
// ---------------------------------------------------------------------------

/**
 * Events:
 *  - 'threshold:warning'   (usage: UsageSnapshot) — crossed warning threshold
 *  - 'threshold:critical'  (usage: UsageSnapshot) — crossed critical threshold
 *  - 'threshold:limit'     (usage: UsageSnapshot) — hit auto-halt threshold
 *  - 'threshold:cleared'   () — usage dropped below warning
 *  - 'session:reset'       () — session reset detected (usage dropped significantly)
 *  - 'halt:triggered'      () — auto-halt was triggered
 *  - 'state:changed'       (state: SessionMonitorState) — any state change
 *  - 'stale'               () — usage data became stale
 *  - 'claude:missing'      () — claude CLI not installed
 */
export class SessionMonitor extends EventEmitter {
  private settings: SessionMonitorSettings;
  private state: SessionMonitorState;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private previousLevel: ThresholdLevel = 'normal';
  private previousPercent = 0;
  private firedThresholds: Set<ThresholdLevel> = new Set();
  private criticalAcknowledged = false;
  private lastActivityAt: number = Date.now();
  private started = false;

  /** Rate-limit backoff state (Mode C) */
  private rateLimitBackoffStep = 0;
  private static readonly RATE_LIMIT_BACKOFFS = [5 * 60_000, 10 * 60_000, 20 * 60_000, 40 * 60_000];

  /** Generic error backoff state */
  private errorBackoffStep = 0;
  private static readonly ERROR_BACKOFFS = [30_000, 60_000, 120_000, 300_000];

  /** Max consecutive failures before marking data as stale */
  private static readonly MAX_FAILURES_BEFORE_STALE = 3;

  /** Jitter range in ms (±10 seconds) */
  private static readonly JITTER_MS = 10_000;

  constructor(settings?: Partial<SessionMonitorSettings>) {
    super();
    this.settings = { ...DEFAULT_SESSION_MONITOR_SETTINGS, ...settings };
    this.state = {
      usage: null,
      level: 'normal',
      stale: false,
      halted: false,
      lastPollAt: null,
      consecutiveFailures: 0,
      pollMode: 'normal',
      nextPollAt: null,
      idle: false,
      claudeAvailable: null,
    };
  }

  getState(): SessionMonitorState {
    return { ...this.state };
  }

  getSettings(): SessionMonitorSettings {
    return { ...this.settings };
  }

  updateSettings(partial: Partial<SessionMonitorSettings>): void {
    this.settings = { ...this.settings, ...partial };
    // Reschedule if running
    if (this.started) {
      this.scheduleNextPoll();
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;

    if (this.settings.pollingDisabled) return;

    // Start idle check timer (every 30s)
    this.idleCheckTimer = setInterval(() => this.checkIdleTransition(), 30_000);

    // Immediate first poll
    this.poll();
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  destroy(): void {
    this.stop();
    this.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // Activity tracking & idle gating
  // -------------------------------------------------------------------------

  /**
   * Report user activity from the renderer (mouse, keyboard, focus, etc.).
   * Resets the idle timer. If currently idle, triggers an immediate refresh.
   */
  reportActivity(): void {
    this.lastActivityAt = Date.now();

    if (this.state.idle) {
      this.state.idle = false;

      // Don't override rate-limit backoff on activity resume
      if (this.state.pollMode === 'rate_limited') return;

      // Don't poll if at limit — wait for reset
      if (this.state.pollMode === 'at_limit') return;

      // Immediate refresh on wake from idle
      this.emitStateChanged(); // UI shows "refreshing…"
      this.poll();
    }
  }

  private checkIdleTransition(): void {
    if (this.state.idle) return; // Already idle
    if (this.settings.pollingDisabled) return;

    const elapsed = Date.now() - this.lastActivityAt;
    if (elapsed < this.settings.idleTimeoutMs) return;

    // Don't go idle if near warning threshold (safety net)
    const lastPercent = this.state.usage?.session?.percent ?? 0;
    if (lastPercent >= this.settings.warningThreshold) return;

    // Enter idle — stop scheduled polling
    this.state.idle = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.state.nextPollAt = null;
    this.emitStateChanged();
  }

  // -------------------------------------------------------------------------
  // Polling state machine
  // -------------------------------------------------------------------------

  async forcePoll(): Promise<SessionMonitorState> {
    // Force poll ignores idle but still respects rate-limit
    if (this.state.pollMode === 'rate_limited') {
      return this.getState();
    }
    await this.poll();
    return this.getState();
  }

  private async poll(): Promise<void> {
    if (this.settings.pollingDisabled) return;

    let snapshot: UsageSnapshot | null = null;
    try {
      snapshot = await fetchAccountUsage();
    } catch {
      // Fetch failed entirely
    }

    if (!snapshot) {
      // Total failure (claude not found, etc.)
      this.handlePollFailure('error');
      return;
    }

    // Check claude CLI availability
    if (this.state.claudeAvailable === null) {
      const available = await checkClaudeInstalled();
      this.state.claudeAvailable = available;
      if (!available) {
        this.emit('claude:missing');
      }
    }

    // Handle status-based routing
    switch (snapshot.status) {
      case 'rate_limited':
        this.handlePollFailure('rate_limited');
        return;

      case 'auth_expired':
        this.handlePollFailure('error');
        return;

      case 'parse_error':
        this.handlePollFailure('error');
        return;

      case 'ok':
      case 'at_limit':
        this.handlePollSuccess(snapshot);
        return;
    }
  }

  private handlePollSuccess(snapshot: UsageSnapshot): void {
    // Reset backoff counters
    this.rateLimitBackoffStep = 0;
    this.errorBackoffStep = 0;
    this.state.consecutiveFailures = 0;
    this.state.lastPollAt = new Date().toISOString();

    const wasStale = this.state.stale;
    this.state.stale = false;
    this.state.usage = snapshot;

    const percent = snapshot.session?.percent ?? 0;

    // Detect session reset: usage dropped significantly from previous
    if (this.previousPercent > 50 && percent < 10) {
      this.state.halted = false;
      this.firedThresholds.clear();
      this.criticalAcknowledged = false;
      this.emit('session:reset');
    }

    const level = this.computeLevel(percent);
    this.state.level = level;

    // Fire threshold events on level changes (only fire each level once per session)
    if (level !== this.previousLevel || wasStale) {
      if (level === 'warning' && !this.firedThresholds.has('warning')) {
        this.firedThresholds.add('warning');
        this.emit('threshold:warning', snapshot);
      } else if (level === 'critical' && !this.firedThresholds.has('critical')) {
        this.firedThresholds.add('critical');
        this.criticalAcknowledged = false;
        this.emit('threshold:critical', snapshot);
      } else if ((level === 'limit' || level === 'over_limit') && !this.firedThresholds.has('limit')) {
        this.firedThresholds.add('limit');
        if (this.settings.autoHaltEnabled && !this.state.halted) {
          this.state.halted = true;
          this.emit('halt:triggered');
        }
        this.emit('threshold:limit', snapshot);
      } else if (level === 'normal' && this.previousLevel !== 'normal') {
        this.firedThresholds.clear();
        this.criticalAcknowledged = false;
        this.emit('threshold:cleared');
      }
    }

    this.previousLevel = level;
    this.previousPercent = percent;

    // Determine next poll mode
    if (percent >= this.settings.autoHaltThreshold) {
      this.state.pollMode = 'at_limit';
    } else {
      this.state.pollMode = 'normal';
    }

    this.emitStateChanged();
    this.scheduleNextPoll();
  }

  private handlePollFailure(type: 'rate_limited' | 'error'): void {
    this.state.consecutiveFailures++;

    if (this.state.consecutiveFailures >= SessionMonitor.MAX_FAILURES_BEFORE_STALE && !this.state.stale) {
      this.state.stale = true;
      this.emit('stale');
    }

    if (type === 'rate_limited') {
      this.state.pollMode = 'rate_limited';
    } else {
      this.state.pollMode = 'error';
    }

    this.emitStateChanged();
    this.scheduleNextPoll();
  }

  private scheduleNextPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (!this.started || this.settings.pollingDisabled || this.state.idle) {
      this.state.nextPollAt = null;
      return;
    }

    const delay = this.computeNextDelay();
    if (delay === null) {
      this.state.nextPollAt = null;
      return;
    }

    this.state.nextPollAt = new Date(Date.now() + delay).toISOString();
    this.pollTimer = setTimeout(() => this.poll(), delay);
  }

  private computeNextDelay(): number | null {
    switch (this.state.pollMode) {
      case 'normal': {
        // Mode A: poll interval ± jitter
        const jitter = Math.floor(Math.random() * SessionMonitor.JITTER_MS * 2) - SessionMonitor.JITTER_MS;
        return Math.max(1_000, this.settings.pollIntervalMs + jitter);
      }

      case 'at_limit': {
        // Mode B: stop polling. Schedule wake at reset time if available.
        const resetsAt = this.state.usage?.session?.resetsAt;
        if (resetsAt) {
          const resetMs = this.parseResetTime(resetsAt);
          if (resetMs !== null) {
            const delay = resetMs - Date.now() + 30_000; // +30s jitter
            return delay > 0 ? delay : 60_000; // If already past, check in 1 min
          }
        }
        // No reset time available — check every 5 min
        return 5 * 60_000;
      }

      case 'rate_limited': {
        // Mode C: doubling backoff 5→10→20→40 min
        const step = Math.min(this.rateLimitBackoffStep, SessionMonitor.RATE_LIMIT_BACKOFFS.length - 1);
        this.rateLimitBackoffStep++;
        return SessionMonitor.RATE_LIMIT_BACKOFFS[step];
      }

      case 'error': {
        // Error backoff: 30s→1m→2m→5m
        const step = Math.min(this.errorBackoffStep, SessionMonitor.ERROR_BACKOFFS.length - 1);
        this.errorBackoffStep++;
        return SessionMonitor.ERROR_BACKOFFS[step];
      }
    }
  }

  /**
   * Parse the human-readable reset time string from Claude's /usage output.
   * Format examples: "6pm (America/New_York)", "Apr 10, 10am (America/New_York)"
   *
   * Returns epoch ms or null if unparseable.
   */
  private parseResetTime(resetsAt: string): number | null {
    try {
      // Extract timezone from parentheses
      const tzMatch = resetsAt.match(/\(([^)]+)\)/);
      if (!tzMatch) return null;

      // For now, just use the timezone to estimate. The exact parsing of
      // "6pm" / "Apr 10, 10am" in a specific TZ is complex. We return a
      // reasonable estimate — within the same day or next day.
      // A production-quality implementation should use date-fns-tz.
      const timeStr = resetsAt.replace(/\([^)]+\)/, '').trim();

      // Try simple time format like "6pm", "10am"
      const simpleTime = timeStr.match(/^(\d{1,2})(am|pm)$/i);
      if (simpleTime) {
        let hour = parseInt(simpleTime[1], 10);
        const isPm = simpleTime[2].toLowerCase() === 'pm';
        if (isPm && hour < 12) hour += 12;
        if (!isPm && hour === 12) hour = 0;

        const now = new Date();
        const target = new Date(now);
        target.setHours(hour, 0, 0, 0);

        // If the time is in the past, it's tomorrow
        if (target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1);
        }
        return target.getTime();
      }

      // Try "Apr 10, 10am" format
      const dateTime = timeStr.match(/^(\w+ \d+),?\s+(\d{1,2})(am|pm)$/i);
      if (dateTime) {
        const year = new Date().getFullYear();
        let hour = parseInt(dateTime[2], 10);
        const isPm = dateTime[3].toLowerCase() === 'pm';
        if (isPm && hour < 12) hour += 12;
        if (!isPm && hour === 12) hour = 0;

        const parsed = new Date(`${dateTime[1]} ${year} ${hour}:00:00`);
        if (!isNaN(parsed.getTime())) return parsed.getTime();
      }

      return null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Threshold logic
  // -------------------------------------------------------------------------

  computeLevel(percent: number): ThresholdLevel {
    if (percent >= this.settings.autoHaltThreshold && percent > 100) return 'over_limit';
    if (percent >= this.settings.autoHaltThreshold) return 'limit';
    if (percent >= this.settings.criticalThreshold) return 'critical';
    if (percent >= this.settings.warningThreshold) return 'warning';
    return 'normal';
  }

  acknowledgeCritical(): void {
    this.criticalAcknowledged = true;
  }

  markResumed(): void {
    this.state.halted = false;
    this.emitStateChanged();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private emitStateChanged(): void {
    this.emit('state:changed', this.getState());
  }
}
