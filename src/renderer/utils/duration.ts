/**
 * Shared duration formatting utilities for stack timestamps.
 *
 * SQLite stores timestamps without timezone info (e.g. "2026-03-25 14:30:00").
 * These must be treated as UTC — append 'Z' if no timezone indicator is present.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped']);

export function parseUtcDate(dateStr: string): Date {
  if (!dateStr.endsWith('Z') && !dateStr.includes('+')) {
    return new Date(dateStr + 'Z');
  }
  return new Date(dateStr);
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function formatDuration(createdAt: string, endRef?: string | Date): string {
  const created = parseUtcDate(createdAt);
  const end = endRef instanceof Date
    ? endRef
    : endRef
      ? parseUtcDate(endRef)
      : new Date();
  const diffMs = end.getTime() - created.getTime();
  if (diffMs < 0) return '0s';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHrs = hours % 24;
  return remainHrs > 0 ? `${days}d ${remainHrs}h` : `${days}d`;
}

/**
 * Returns the appropriate duration string for a stack.
 * Active stacks: duration from created_at to now.
 * Terminal stacks: duration from created_at to updated_at (frozen).
 */
export function getStackDuration(
  createdAt: string,
  updatedAt: string,
  status: string
): string {
  if (isTerminalStatus(status)) {
    return formatDuration(createdAt, updatedAt);
  }
  return formatDuration(createdAt);
}

/** Duration update interval in milliseconds (5 seconds). */
export const DURATION_UPDATE_INTERVAL = 5000;
