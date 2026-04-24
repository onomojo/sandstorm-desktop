import { execFile } from 'child_process';
import { promisify } from 'util';
import { fetchTicketContext, getScriptStatus } from './ticket-fetcher';

const execFileAsync = promisify(execFile);

/**
 * Trimmed result returned to the renderer for spec check / refine. Mirrors
 * the JSON shape that `sandstorm-spec.sh` emits when invoked from a skill —
 * but routed in-process so we don't pay for an HTTP-bridge round-trip when
 * the orchestrator isn't even involved.
 */
export interface SpecGateResult {
  passed: boolean;
  questions: string[];
  gateSummary: string;
  ticketUrl: string | null;
  cached: boolean;
  /** Set when the ticket can't be evaluated (missing fetch script, etc.). */
  error?: string;
}

/** Raw spec-gate report payload coming back from the ephemeral agent. */
export interface SpecGateReport {
  passed: boolean;
  report?: string;
  reason?: string;
  error?: string;
  updatedBody?: string | null;
}

/** Pull the gate verdict + question count out of the verbose report. */
export function extractGateSummary(report: string): string {
  if (!report) return '';
  let verdict = '';
  if (/##\s+Spec Quality Gate:\s*PASS/i.test(report)) verdict = 'PASS';
  else if (/##\s+Spec Quality Gate:\s*FAIL/i.test(report)) verdict = 'FAIL';
  if (!verdict) return 'Gate verdict not parsed';
  const qcount = (report.match(/^[0-9]+\.\s/gm) || []).length;
  return `Gate=${verdict}, questions=${qcount}`;
}

/**
 * Mirrors the awk parser in sandstorm-spec.sh: only pulls numbered items
 * sitting under a `### Questions` or `### Gaps` heading, stopping at the
 * next `## ` boundary. Returns an empty array when nothing matches.
 */
export function extractQuestions(report: string): string[] {
  if (!report) return [];
  const lines = report.split('\n');
  let capture = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^### (Questions|Gaps)/i.test(line)) {
      capture = true;
      continue;
    }
    if (/^## /.test(line)) {
      capture = false;
      continue;
    }
    if (!capture) continue;
    const m = line.match(/^[0-9]+\.\s*(.*)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

/**
 * Look up `spec-ready:sha-<hash>` labels on the issue and return the hash
 * suffix if any. Empty string when `gh` isn't available or the call fails.
 */
async function readSpecReadyHash(ticketId: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', ticketId, '--json', 'labels', '-q', '.labels[].name'],
      { timeout: 15000 }
    );
    const m = stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('spec-ready:sha-'));
    return m ? m.replace('spec-ready:sha-', '') : '';
  } catch {
    return '';
  }
}

/** Fetch the issue URL via gh; empty string when unavailable. */
async function readTicketUrl(ticketId: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', ticketId, '--json', 'url', '-q', '.url'],
      { timeout: 15000 }
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Compute the short body hash used by sandstorm-spec.sh for idempotency. */
export function shortBodyHash(body: string): string {
  // Match `sha256sum | cut -c1-12` shape.
  // We avoid pulling node:crypto here — keeps this module test-friendly.
  // The hash is opaque; consistency with the shell script is not required
  // because this module is the only producer/consumer of the in-process value.
  let h = 0;
  for (let i = 0; i < body.length; i++) {
    h = ((h << 5) - h + body.charCodeAt(i)) | 0;
  }
  // Pack as 12-char hex — pad/wrap so collisions are still rare for short bodies.
  const u = h >>> 0;
  return u.toString(16).padStart(8, '0').repeat(2).slice(0, 12);
}

/**
 * Replace existing `spec-ready:sha-*` labels with a fresh one tracking the
 * current body. Best-effort — failures (no gh, no perms, network) are swallowed.
 */
async function markSpecReady(ticketId: string, hash: string): Promise<void> {
  if (!hash) return;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', ticketId, '--json', 'labels', '-q', '.labels[].name'],
      { timeout: 15000 }
    );
    const stale = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('spec-ready:sha-'));
    for (const lab of stale) {
      try {
        await execFileAsync('gh', ['issue', 'edit', ticketId, '--remove-label', lab], { timeout: 15000 });
      } catch {
        // ignore
      }
    }
    await execFileAsync('gh', ['issue', 'edit', ticketId, '--add-label', `spec-ready:sha-${hash}`], { timeout: 15000 });
  } catch {
    // ignore
  }
}

export interface SpecGateDeps {
  fetchTicket: (ticketId: string, projectDir: string) => Promise<string | null>;
  scriptStatus: (projectDir: string) => 'ok' | 'missing' | 'not_executable';
  runCheck: (ticketId: string, projectDir: string) => Promise<SpecGateReport>;
  runRefine: (
    ticketId: string,
    projectDir: string,
    userAnswers?: string
  ) => Promise<SpecGateReport>;
  readSpecReadyHash: (ticketId: string) => Promise<string>;
  readTicketUrl: (ticketId: string) => Promise<string>;
  markSpecReady: (ticketId: string, hash: string) => Promise<void>;
}

/**
 * Run the spec quality gate for a ticket. When the ticket already carries
 * a `spec-ready:sha-<hash>` label whose hash matches the current body, we
 * return `cached: true` without invoking the LLM. Otherwise we call the
 * provided `runCheck` (typically the existing `handleSpecCheck`) and trim
 * its verbose report down to the renderer-facing shape.
 */
export async function runSpecCheck(
  ticketId: string,
  projectDir: string,
  deps: SpecGateDeps
): Promise<SpecGateResult> {
  const status = deps.scriptStatus(projectDir);
  if (status !== 'ok') {
    return {
      passed: false,
      questions: [],
      gateSummary: `fetch-ticket.sh ${status}`,
      ticketUrl: null,
      cached: false,
      error:
        status === 'missing'
          ? 'fetch-ticket.sh is missing — run `sandstorm init` to generate it.'
          : 'fetch-ticket.sh exists but is not executable. Run `chmod +x .sandstorm/scripts/fetch-ticket.sh`.',
    };
  }

  const body = await deps.fetchTicket(ticketId, projectDir);
  if (!body) {
    return {
      passed: false,
      questions: [],
      gateSummary: 'fetch-ticket.sh returned no output',
      ticketUrl: null,
      cached: false,
      error: `fetch-ticket.sh ran but returned no output for ticket "${ticketId}".`,
    };
  }

  const url = await deps.readTicketUrl(ticketId);
  const curHash = shortBodyHash(body);
  const cachedHash = await deps.readSpecReadyHash(ticketId);

  if (cachedHash && cachedHash === curHash) {
    return {
      passed: true,
      questions: [],
      gateSummary: 'cached (body unchanged since last PASS)',
      ticketUrl: url || null,
      cached: true,
    };
  }

  const report = await deps.runCheck(ticketId, projectDir);
  if (report.error) {
    return {
      passed: false,
      questions: [],
      gateSummary: '',
      ticketUrl: url || null,
      cached: false,
      error: report.error,
    };
  }
  if (report.reason && !report.report) {
    return {
      passed: report.passed,
      questions: [],
      gateSummary: '',
      ticketUrl: url || null,
      cached: false,
      error: report.reason,
    };
  }

  const passed = !!report.passed;
  const reportText = report.report || '';
  if (passed && curHash) {
    await deps.markSpecReady(ticketId, curHash);
  }

  return {
    passed,
    questions: passed ? [] : extractQuestions(reportText),
    gateSummary: extractGateSummary(reportText),
    ticketUrl: url || null,
    cached: false,
  };
}

/**
 * Run a refinement step — pipes the user's answers to the spec-refine
 * handler, then trims the response. The MCP handler writes the updated
 * ticket body back to GitHub itself, so we only need to surface the
 * verdict + any remaining questions.
 */
export async function runSpecRefine(
  ticketId: string,
  projectDir: string,
  userAnswers: string,
  deps: SpecGateDeps
): Promise<SpecGateResult> {
  const status = deps.scriptStatus(projectDir);
  if (status !== 'ok') {
    return {
      passed: false,
      questions: [],
      gateSummary: `fetch-ticket.sh ${status}`,
      ticketUrl: null,
      cached: false,
      error:
        status === 'missing'
          ? 'fetch-ticket.sh is missing — run `sandstorm init` to generate it.'
          : 'fetch-ticket.sh exists but is not executable.',
    };
  }

  const url = await deps.readTicketUrl(ticketId);
  const report = await deps.runRefine(ticketId, projectDir, userAnswers);
  if (report.error) {
    return {
      passed: false,
      questions: [],
      gateSummary: '',
      ticketUrl: url || null,
      cached: false,
      error: report.error,
    };
  }
  if (report.reason && !report.report) {
    return {
      passed: report.passed,
      questions: [],
      gateSummary: '',
      ticketUrl: url || null,
      cached: false,
      error: report.reason,
    };
  }

  const passed = !!report.passed;
  const reportText = report.report || '';

  if (passed) {
    // Refine just rewrote the ticket body — re-fetch + re-hash before tagging.
    const fresh = await deps.fetchTicket(ticketId, projectDir);
    if (fresh) {
      await deps.markSpecReady(ticketId, shortBodyHash(fresh));
    }
  }

  return {
    passed,
    questions: passed ? [] : extractQuestions(reportText),
    gateSummary: extractGateSummary(reportText),
    ticketUrl: url || null,
    cached: false,
  };
}

/**
 * Default deps wired to the real ticket-fetcher + tools.ts handlers.
 * Exposed so the IPC layer doesn't have to know how to wire the graph.
 */
export function defaultSpecGateDeps(
  runCheck: (ticketId: string, projectDir: string) => Promise<SpecGateReport>,
  runRefine: (
    ticketId: string,
    projectDir: string,
    userAnswers?: string
  ) => Promise<SpecGateReport>
): SpecGateDeps {
  return {
    fetchTicket: fetchTicketContext,
    scriptStatus: getScriptStatus,
    runCheck,
    runRefine,
    readSpecReadyHash,
    readTicketUrl,
    markSpecReady,
  };
}

export interface FetchTicketResult {
  body: string;
  url: string | null;
}

/**
 * Fetch the rendered ticket body for the renderer. Returns the body and
 * (best-effort) the GitHub URL.
 */
export async function fetchTicketForRenderer(
  ticketId: string,
  projectDir: string
): Promise<FetchTicketResult> {
  const status = getScriptStatus(projectDir);
  if (status !== 'ok') {
    throw new Error(
      status === 'missing'
        ? 'fetch-ticket.sh is missing — run `sandstorm init` to generate it.'
        : 'fetch-ticket.sh exists but is not executable.'
    );
  }
  const body = await fetchTicketContext(ticketId, projectDir);
  if (!body) {
    throw new Error(`fetch-ticket.sh returned no output for ticket "${ticketId}".`);
  }
  const url = await readTicketUrl(ticketId);
  return { body, url: url || null };
}
