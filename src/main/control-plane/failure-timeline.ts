import type { Task } from './registry';

export interface TimelineEntry {
  iteration: number;
  phase: 'execute' | 'review' | 'verify';
  verdict: 'pass' | 'fail';
  detail: string;
}

/**
 * Deterministically build a failure timeline from persisted task data.
 * Does NOT call any agent — parses review_verdicts, verify_outputs, execute_outputs
 * and phase-timing from the TaskRow. Missing arrays or short arrays are tolerated.
 */
export function buildFailureTimeline(task: Task): TimelineEntry[] {
  const executeOutputs = parseJsonArray(task.execute_outputs);
  const reviewVerdicts = parseJsonArray(task.review_verdicts);
  const verifyOutputs = parseJsonArray(task.verify_outputs);

  const entries: TimelineEntry[] = [];
  const N = Math.max(executeOutputs.length, reviewVerdicts.length);

  for (let i = 0; i < N; i++) {
    // Execute entry for iteration i+1
    if (i < executeOutputs.length) {
      const raw = executeOutputs[i];
      const lines = raw.split('\n');
      const firstLine = lines[0]?.trim() ?? '';
      entries.push({
        iteration: i + 1,
        phase: 'execute',
        verdict: firstLine === 'EXECUTE_PASS' ? 'pass' : 'fail',
        detail: lines.slice(1).join('\n').trim(),
      });
    }

    // Review entry for iteration i+1
    if (i < reviewVerdicts.length) {
      const raw = reviewVerdicts[i];
      const lines = raw.split('\n');
      const firstLine = lines[0]?.trim() ?? '';
      entries.push({
        iteration: i + 1,
        phase: 'review',
        verdict: firstLine === 'REVIEW_PASS' ? 'pass' : 'fail',
        detail: lines.slice(1).join('\n').trim(),
      });
    }
  }

  // Verify entries
  for (let k = 0; k < verifyOutputs.length; k++) {
    const raw = verifyOutputs[k];
    const lines = raw.split('\n');
    const firstLine = lines[0]?.trim() ?? '';
    const isInfra = firstLine === 'VERIFY_INFRA';
    const detail = [
      isInfra ? '[environmental/infrastructure failure]' : '',
      lines.slice(1).join('\n').trim(),
    ].filter(Boolean).join('\n');

    entries.push({
      iteration: k + 1,
      phase: 'verify',
      verdict: firstLine === 'VERIFY_PASS' ? 'pass' : 'fail',
      detail,
    });
  }

  return entries;
}

function parseJsonArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String);
  } catch {
    return [];
  }
}
