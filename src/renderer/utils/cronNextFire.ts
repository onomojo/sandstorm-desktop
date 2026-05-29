/**
 * Computes the next fire time for a standard 5-field cron expression.
 * Handles the common subset used by Sandstorm schedules.
 * Fields: minute hour dom month dow
 */

function matchesField(value: number, field: string, min: number, max: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  if (field.includes(',')) {
    return field.split(',').map(Number).includes(value);
  }
  const n = parseInt(field, 10);
  return !isNaN(n) && value === n;
}

export function cronNextFire(expression: string): Date | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minF, hourF, domF, monF, dowF] = parts;

  // Start from next minute
  const now = new Date();
  const start = new Date(now.getTime() + 60_000);
  start.setSeconds(0, 0);

  // Search up to 1 year ahead (525600 minutes)
  for (let i = 0; i < 525_600; i++) {
    const d = new Date(start.getTime() + i * 60_000);
    const min = d.getMinutes();
    const hour = d.getHours();
    const dom = d.getDate();
    const mon = d.getMonth() + 1; // 1-12
    const dow = d.getDay(); // 0=Sun

    if (
      matchesField(min, minF, 0, 59) &&
      matchesField(hour, hourF, 0, 23) &&
      matchesField(dom, domF, 1, 31) &&
      matchesField(mon, monF, 1, 12) &&
      matchesField(dow, dowF, 0, 6)
    ) {
      return d;
    }
  }

  return null;
}

export function formatRelativeTime(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 60_000) return 'in <1 min';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

export function formatElapsedTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}
