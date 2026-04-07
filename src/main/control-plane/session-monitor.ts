/**
 * Session token limit monitor — polls real account-level usage data and
 * triggers warnings / auto-halt when configurable thresholds are crossed.
 *
 * Uses the same account usage API as AccountUsageBar, but adds:
 *  - Threshold detection (warning, critical, limit)
 *  - Event emission for UI warnings
 *  - Auto-halt orchestration (pauses all stacks at limit)
 *  - Session reset detection (usage drops → notify/resume)
 */

import { EventEmitter } from 'events';
import { fetchAccountUsage, AccountUsage } from './account-usage';

export interface SessionMonitorSettings {
  /** Percentage at which a non-blocking warning is shown (default 80) */
  warningThreshold: number;
  /** Percentage at which a blocking warning modal is shown (default 95) */
  criticalThreshold: number;
  /** Percentage at which auto-halt triggers (default 100) */
  autoHaltThreshold: number;
  /** Whether auto-halt is enabled (default true) */
  autoHaltEnabled: boolean;
  /** Whether to auto-resume after session reset (default false) */
  autoResumeAfterReset: boolean;
  /** Polling interval in ms (default 60000) */
  pollIntervalMs: number;
}

export const DEFAULT_SESSION_MONITOR_SETTINGS: SessionMonitorSettings = {
  warningThreshold: 80,
  criticalThreshold: 95,
  autoHaltThreshold: 100,
  autoHaltEnabled: true,
  autoResumeAfterReset: false,
  pollIntervalMs: 60_000,
};

export type ThresholdLevel = 'normal' | 'warning' | 'critical' | 'limit' | 'over_limit';

export interface SessionMonitorState {
  /** Current account usage (null if unavailable) */
  usage: AccountUsage | null;
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
}

/**
 * Events:
 *  - 'threshold:warning'   (usage: AccountUsage) — crossed warning threshold
 *  - 'threshold:critical'  (usage: AccountUsage) — crossed critical threshold
 *  - 'threshold:limit'     (usage: AccountUsage) — hit auto-halt threshold
 *  - 'threshold:cleared'   () — usage dropped below warning
 *  - 'session:reset'       () — session reset detected (usage dropped significantly)
 *  - 'halt:triggered'      () — auto-halt was triggered
 *  - 'state:changed'       (state: SessionMonitorState) — any state change
 *  - 'stale'               () — usage data became stale
 */
export class SessionMonitor extends EventEmitter {
  private settings: SessionMonitorSettings;
  private state: SessionMonitorState;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private previousLevel: ThresholdLevel = 'normal';
  private previousPercent = 0;
  /** Tracks which threshold events have been fired to prevent duplicates */
  private firedThresholds: Set<ThresholdLevel> = new Set();
  /** Whether the user acknowledged the critical warning */
  private criticalAcknowledged = false;
  /** Max consecutive failures before marking data as stale */
  private static readonly MAX_FAILURES_BEFORE_STALE = 3;

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
    };
  }

  getState(): SessionMonitorState {
    return { ...this.state };
  }

  getSettings(): SessionMonitorSettings {
    return { ...this.settings };
  }

  updateSettings(partial: Partial<SessionMonitorSettings>): void {
    const oldInterval = this.settings.pollIntervalMs;
    this.settings = { ...this.settings, ...partial };

    // Restart polling if interval changed
    if (partial.pollIntervalMs && partial.pollIntervalMs !== oldInterval && this.pollTimer) {
      this.stop();
      this.start();
    }
  }

  /**
   * Start polling for account usage.
   */
  start(): void {
    if (this.pollTimer) return;
    // Do an immediate poll, then schedule recurring
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.settings.pollIntervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Force an immediate poll (useful after user action).
   */
  async forcePoll(): Promise<SessionMonitorState> {
    await this.poll();
    return this.getState();
  }

  /**
   * Mark that the user acknowledged the critical threshold warning
   * (chose "Continue" or "Remind me at 100%").
   */
  acknowledgeCritical(): void {
    this.criticalAcknowledged = true;
  }

  /**
   * Mark stacks as resumed after a session halt (user override or session reset).
   */
  markResumed(): void {
    this.state.halted = false;
    this.emitStateChanged();
  }

  /**
   * Determine the threshold level for a given percentage.
   */
  computeLevel(percent: number): ThresholdLevel {
    if (percent >= this.settings.autoHaltThreshold && percent > 100) return 'over_limit';
    if (percent >= this.settings.autoHaltThreshold) return 'limit';
    if (percent >= this.settings.criticalThreshold) return 'critical';
    if (percent >= this.settings.warningThreshold) return 'warning';
    return 'normal';
  }

  private async poll(): Promise<void> {
    let usage: AccountUsage | null = null;
    try {
      usage = await fetchAccountUsage();
    } catch {
      // Fetch failed
    }

    if (!usage || (usage.limit_tokens === 0 && usage.used_tokens === 0)) {
      this.state.consecutiveFailures++;
      if (this.state.consecutiveFailures >= SessionMonitor.MAX_FAILURES_BEFORE_STALE && !this.state.stale) {
        this.state.stale = true;
        this.emit('stale');
        this.emitStateChanged();
      }
      return;
    }

    // Successful poll
    this.state.consecutiveFailures = 0;
    this.state.lastPollAt = new Date().toISOString();

    const wasStale = this.state.stale;
    this.state.stale = false;
    this.state.usage = usage;

    // Detect session reset: usage dropped significantly from previous
    if (this.previousPercent > 50 && usage.percent < 10) {
      this.state.halted = false;
      this.firedThresholds.clear();
      this.criticalAcknowledged = false;
      this.emit('session:reset');
    }

    const level = this.computeLevel(usage.percent);
    this.state.level = level;

    // Fire threshold events on level changes (only fire each level once per session)
    if (level !== this.previousLevel || wasStale) {
      if (level === 'warning' && !this.firedThresholds.has('warning')) {
        this.firedThresholds.add('warning');
        this.emit('threshold:warning', usage);
      } else if (level === 'critical' && !this.firedThresholds.has('critical')) {
        this.firedThresholds.add('critical');
        this.criticalAcknowledged = false;
        this.emit('threshold:critical', usage);
      } else if ((level === 'limit' || level === 'over_limit') && !this.firedThresholds.has('limit')) {
        this.firedThresholds.add('limit');
        if (this.settings.autoHaltEnabled && !this.state.halted) {
          this.state.halted = true;
          this.emit('halt:triggered');
        }
        this.emit('threshold:limit', usage);
      } else if (level === 'normal' && this.previousLevel !== 'normal') {
        this.firedThresholds.clear();
        this.criticalAcknowledged = false;
        this.emit('threshold:cleared');
      }
    }

    this.previousLevel = level;
    this.previousPercent = usage.percent;
    this.emitStateChanged();
  }

  private emitStateChanged(): void {
    this.emit('state:changed', this.getState());
  }

  destroy(): void {
    this.stop();
    this.removeAllListeners();
  }
}
