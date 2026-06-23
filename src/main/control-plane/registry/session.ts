import Database from 'better-sqlite3';
import type { SessionMonitorSettingsRecord } from '../registry';

interface SessionMonitorSettingsRow {
  key: string;
  warning_threshold: number;
  critical_threshold: number;
  auto_halt_threshold: number;
  auto_halt_enabled: number;
  auto_resume_after_reset: number;
  poll_interval_ms: number;
  idle_timeout_ms: number;
  polling_disabled: number;
}

export class SessionModule {
  constructor(private db: Database.Database) {}

  getSessionMonitorSettings(): SessionMonitorSettingsRecord {
    const row = this.db.prepare(
      "SELECT * FROM session_monitor_settings WHERE key = 'global'"
    ).get() as SessionMonitorSettingsRow | undefined;
    return row
      ? {
          warningThreshold: row.warning_threshold,
          criticalThreshold: row.critical_threshold,
          autoHaltThreshold: row.auto_halt_threshold,
          autoHaltEnabled: row.auto_halt_enabled === 1,
          autoResumeAfterReset: row.auto_resume_after_reset === 1,
          pollIntervalMs: row.poll_interval_ms,
          idleTimeoutMs: row.idle_timeout_ms,
          pollingDisabled: row.polling_disabled === 1,
        }
      : {
          warningThreshold: 80,
          criticalThreshold: 90,
          autoHaltThreshold: 95,
          autoHaltEnabled: true,
          autoResumeAfterReset: false,
          pollIntervalMs: 120_000,
          idleTimeoutMs: 300_000,
          pollingDisabled: false,
        };
  }

  setSessionMonitorSettings(settings: Partial<SessionMonitorSettingsRecord>): void {
    const current = this.getSessionMonitorSettings();
    this.db.prepare(
      `INSERT OR REPLACE INTO session_monitor_settings
        (key, warning_threshold, critical_threshold, auto_halt_threshold, auto_halt_enabled, auto_resume_after_reset, poll_interval_ms, idle_timeout_ms, polling_disabled)
       VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      settings.warningThreshold ?? current.warningThreshold,
      settings.criticalThreshold ?? current.criticalThreshold,
      settings.autoHaltThreshold ?? current.autoHaltThreshold,
      (settings.autoHaltEnabled ?? current.autoHaltEnabled) ? 1 : 0,
      (settings.autoResumeAfterReset ?? current.autoResumeAfterReset) ? 1 : 0,
      settings.pollIntervalMs ?? current.pollIntervalMs,
      settings.idleTimeoutMs ?? current.idleTimeoutMs,
      (settings.pollingDisabled ?? current.pollingDisabled) ? 1 : 0,
    );
  }
}
