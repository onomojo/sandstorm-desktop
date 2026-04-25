/**
 * Cron daemon health check.
 * Checks whether a cron daemon is running on Linux or macOS.
 */

import { execSync } from 'child_process';
import os from 'os';

/**
 * Check if a cron daemon is running on the current system.
 * Returns true if cron appears to be active, false otherwise.
 *
 * Linux: tries systemctl is-active cron/crond, then pgrep -x cron.
 * macOS: tries pgrep -x cron (macOS ships cron enabled by default).
 */
export function isCronRunning(): boolean {
  const platform = os.platform();

  if (platform === 'darwin') {
    return checkMacCron();
  }

  if (platform === 'linux') {
    return checkLinuxCron();
  }

  // Unsupported platform — report as not running
  return false;
}

function checkLinuxCron(): boolean {
  // Try systemctl first (systemd-based distros)
  for (const service of ['cron', 'crond']) {
    try {
      const result = execSync(`systemctl is-active ${service} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      if (result === 'active') return true;
    } catch {
      // Not found or not active — try next
    }
  }

  // Fallback: pgrep
  return pgrepCron();
}

function checkMacCron(): boolean {
  // macOS ships cron enabled by default; just check if it's running
  return pgrepCron();
}

function pgrepCron(): boolean {
  try {
    execSync('pgrep -x cron 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    // pgrep returns non-zero if no match
    try {
      execSync('pgrep -x crond 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
