/**
 * Lightweight cron expression validator and human-readable formatter.
 * Supports standard 5-field cron (minute hour day-of-month month day-of-week).
 *
 * Validation logic lives in shared/cron-utils.ts so both main and renderer
 * processes use the same validator. This module re-exports and adds
 * next-fire-time computation that is only needed on the main side.
 */

export { validateCronExpression, cronToHuman } from '../../shared/cron-utils';

/**
 * Compute the next fire time for a cron expression from the given base time.
 * This is a simplified implementation that handles common patterns.
 * Returns an ISO-8601 string or null if computation is not supported.
 */
export function nextFireTime(expression: string, from: Date = new Date()): Date | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minField, hourField, domField, monthField, dowField] = fields;

  // For expressions with dom or month constraints, return null (UI will show "—").
  // Day-of-week patterns are handled below via allowedDows.
  if (domField !== '*' || monthField !== '*') return null;

  // Parse allowed minutes
  const allowedMinutes = expandField(minField, 0, 59);
  const allowedHours = expandField(hourField, 0, 23);
  const allowedDows = dowField === '*' ? null : expandField(dowField, 0, 6);

  if (!allowedMinutes || !allowedHours) return null;

  // Iterate forward from `from` to find next match (max 7 days)
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // always at least 1 minute in the future

  const limit = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);

  while (candidate < limit) {
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const d = candidate.getDay();

    if (
      allowedMinutes.includes(m) &&
      allowedHours.includes(h) &&
      (allowedDows === null || allowedDows.includes(d))
    ) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

function expandField(field: string, min: number, max: number): number[] | null {
  if (field === '*') {
    const result: number[] = [];
    for (let i = min; i <= max; i++) result.push(i);
    return result;
  }

  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    if (step < 1) return null; // invalid step — validation should have caught this
    const result: number[] = [];
    for (let i = min; i <= max; i += step) result.push(i);
    return result;
  }

  const values = new Set<number>();
  for (const part of field.split(',')) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n)) return null;
      values.add(n > max ? n % (max + 1) : n); // handle dow=7 → 0
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}
