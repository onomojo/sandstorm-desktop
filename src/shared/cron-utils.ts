/**
 * Pure cron expression utilities shared between main and renderer processes.
 * No Node.js dependencies — safe to import in both Electron contexts.
 */

/**
 * Convert a cron expression to a human-readable description.
 */
export function cronToHuman(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return expression;

  const [minute, hour, dom, month, dow] = fields;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Every minute';
  }

  const everyMinMatch = minute.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(everyMinMatch[1], 10);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  if (/^\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every hour at :${minute.padStart(2, '0')}`;
  }

  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && everyHourMatch && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(everyHourMatch[1], 10);
    return n === 1 ? `Every hour at :${minute.padStart(2, '0')}` : `Every ${n} hours at :${minute.padStart(2, '0')}`;
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow === '*') {
    return `Daily at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow !== '*') {
    const days = dow.split(',').map((d) => DAY_NAMES[parseInt(d, 10) % 7] || d).join(', ');
    return `${days} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && month === '*' && dow === '*') {
    return `Day ${dom} of every month at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  return expression;
}

const FIELD_RANGES: [number, number][] = [
  [0, 59],   // minute
  [0, 23],   // hour
  [1, 31],   // day of month
  [1, 12],   // month
  [0, 7],    // day of week (0 and 7 both = Sunday)
];

const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];

function validateField(field: string, min: number, max: number, name: string): string | null {
  if (field === '*') return null;

  const stepMatch = field.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[4], 10);
    if (step < 1) return `${name}: step value must be >= 1`;
    if (stepMatch[2] !== undefined) {
      const start = parseInt(stepMatch[2], 10);
      const end = parseInt(stepMatch[3], 10);
      if (start < min || start > max) return `${name}: range start ${start} out of bounds (${min}-${max})`;
      if (end < min || end > max) return `${name}: range end ${end} out of bounds (${min}-${max})`;
    }
    return null;
  }

  const parts = field.split(',');
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < min || start > max) return `${name}: value ${start} out of bounds (${min}-${max})`;
      if (end < min || end > max) return `${name}: value ${end} out of bounds (${min}-${max})`;
      continue;
    }

    const num = parseInt(part, 10);
    if (isNaN(num) || String(num) !== part) return `${name}: invalid value "${part}"`;
    if (num < min || num > max) return `${name}: value ${num} out of bounds (${min}-${max})`;
  }

  return null;
}

/**
 * Full 5-field cron validation with range/value checking.
 * Returns null if valid, or an error string if invalid.
 */
export function validateCronExpression(expression: string): string | null {
  if (!expression || typeof expression !== 'string') {
    return 'Cron expression is required';
  }

  const trimmed = expression.trim();
  const fields = trimmed.split(/\s+/);

  if (fields.length !== 5) {
    return `Expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`;
  }

  for (let i = 0; i < 5; i++) {
    const error = validateField(fields[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1], FIELD_NAMES[i]);
    if (error) return error;
  }

  return null;
}
