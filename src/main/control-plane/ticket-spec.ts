import { execFile } from 'child_process';
import { promisify } from 'util';
import { fetchTicketWithConfig } from './ticket-config';
import type { ProjectTicketConfig } from './registry';

const execFileAsync = promisify(execFile);

export interface RefineQuestionOption {
  id: string;
  label: string;
  recommended?: boolean;
}

export interface RefineQuestion {
  id: string;
  question: string;
  options: RefineQuestionOption[];
}

/**
 * Trimmed result returned to the renderer for spec check / refine. Mirrors
 * the JSON shape that `sandstorm-spec.sh` emits when invoked from a skill —
 * but routed in-process so we don't pay for an HTTP-bridge round-trip when
 * the orchestrator isn't even involved.
 */
export interface SpecGateResult {
  passed: boolean;
  questions: RefineQuestion[];
  gateSummary: string;
  ticketUrl: string | null;
  cached: boolean;
  /** Set when the ticket can't be evaluated (unconfigured provider, etc.). */
  error?: string;
  /** Full evaluator report text, capped at 64KB. Present on FAIL; null/absent on PASS or error. */
  reportText?: string | null;
  /**
   * Set when the spec gate passed but contract generation/storage failed. The
   * ticket is reported as NOT passed (stays in Refining) so the existing Retry
   * action re-attempts. Distinct from `error` (which is a gate-evaluation
   * failure) and from `reportText` (gate FAIL questions).
   */
  contractError?: string;
}

const MAX_REPORT_TEXT_LEN = 64 * 1024;

export function capReportText(text: string): string {
  if (text.length <= MAX_REPORT_TEXT_LEN) return text;
  return text.slice(0, MAX_REPORT_TEXT_LEN) + '\n\n[Report truncated at 64KB]';
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
  const qcount = extractQuestions(report).length;
  return `Gate=${verdict}, questions=${qcount}`;
}

/**
 * Parses structured questions from a spec gate report. Looks for a ```json
 * fence under a `### Questions` heading and parses it as RefineQuestion[].
 * Falls back to the legacy numbered-list parser (coercing each line to a
 * RefineQuestion with no options) when no valid JSON block is found.
 * Any `### Gaps` sections in the report are ignored entirely.
 */
export function extractQuestions(report: string): RefineQuestion[] {
  if (!report) return [];

  const jsonResult = tryParseJsonBlock(report);
  if (jsonResult !== null) {
    return jsonResult;
  }

  // Fallback: numbered-item parser for `### Questions` sections only.
  const lines = report.split('\n');
  let capture = false;
  const out: RefineQuestion[] = [];
  let idx = 0;
  for (const line of lines) {
    if (/^### Questions/i.test(line)) {
      capture = true;
      continue;
    }
    if (/^## /.test(line)) {
      capture = false;
      continue;
    }
    if (!capture) continue;
    const numbered = line.match(/^[0-9]+\.\s*(.*)$/);
    if (numbered && numbered[1].trim()) {
      out.push({ id: `q${idx + 1}`, question: numbered[1].trim(), options: [] });
      idx++;
    }
  }
  return out;
}

/**
 * Locate the first ```json fence following a ### Questions heading and
 * parse it as RefineQuestion[]. Returns null on missing block, parse error,
 * or invalid shape.
 */
function tryParseJsonBlock(report: string): RefineQuestion[] | null {
  const lines = report.split('\n');
  let inSection = false;
  let inFence = false;
  const fenceLines: string[] = [];

  for (const line of lines) {
    if (/^### Questions/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) {
      break;
    }
    if (!inSection) continue;

    if (!inFence && line.trim() === '```json') {
      inFence = true;
      continue;
    }
    if (inFence) {
      if (line.trim() === '```') break;
      fenceLines.push(line);
    }
  }

  if (fenceLines.length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(fenceLines.join('\n'));
    if (!Array.isArray(parsed)) return null;
    const result: RefineQuestion[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return null;
      const obj = item as Record<string, unknown>;
      if (typeof obj.question !== 'string') return null;
      const id = typeof obj.id === 'string' ? obj.id : `q${result.length + 1}`;
      const options: RefineQuestionOption[] = [];
      if (Array.isArray(obj.options)) {
        for (const opt of obj.options) {
          if (typeof opt === 'object' && opt !== null) {
            const o = opt as Record<string, unknown>;
            if (typeof o.id === 'string' && typeof o.label === 'string') {
              const rec = o.recommended === true ? { recommended: true as const } : {};
              options.push({ id: o.id, label: o.label, ...rec });
            }
          }
        }
      }
      result.push({ id, question: obj.question, options });
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Look up `spec-ready:sha-<hash>` labels on the issue and return the hash
 * suffix if any. Empty string when `gh` isn't available or the call fails.
 * GitHub-specific; returns empty string for Jira tickets (cache disabled).
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
  let h = 0;
  for (let i = 0; i < body.length; i++) {
    h = ((h << 5) - h + body.charCodeAt(i)) | 0;
  }
  const u = h >>> 0;
  return u.toString(16).padStart(8, '0').repeat(2).slice(0, 12);
}

/**
 * Replace existing `<prefix>:sha-*` labels with a fresh one tracking the
 * current body hash. Best-effort — failures (no gh, no perms, network) are
 * swallowed. GitHub-specific; no-op for Jira tickets.
 */
async function replaceShaLabel(ticketId: string, prefix: string, hash: string): Promise<void> {
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
      .filter((l) => l.startsWith(`${prefix}:sha-`));
    for (const lab of stale) {
      try {
        await execFileAsync('gh', ['issue', 'edit', ticketId, '--remove-label', lab], { timeout: 15000 });
      } catch {
        // ignore
      }
    }
    await execFileAsync('gh', ['issue', 'edit', ticketId, '--add-label', `${prefix}:sha-${hash}`], { timeout: 15000 });
  } catch {
    // ignore
  }
}

/** Mark a ticket spec-ready by stamping the current body hash as a label. */
async function markSpecReady(ticketId: string, hash: string): Promise<void> {
  return replaceShaLabel(ticketId, 'spec-ready', hash);
}

/**
 * Mark a ticket as having a current execution contract by stamping the spec
 * body hash as a `contract:sha-<hash>` label. Lets the board/dispatch check
 * contract presence + freshness without fetching comments.
 */
export async function markContractReady(ticketId: string, hash: string): Promise<void> {
  return replaceShaLabel(ticketId, 'contract', hash);
}

export interface SpecGateDeps {
  fetchTicket: (ticketId: string, projectDir: string) => Promise<string | null>;
  /** Returns the stored ticket provider config, or null if unconfigured. */
  getProviderConfig: (projectDir: string) => ProjectTicketConfig | null;
  runCheck: (ticketId: string, projectDir: string) => Promise<SpecGateReport>;
  runRefine: (
    ticketId: string,
    projectDir: string,
    userAnswers?: string
  ) => Promise<SpecGateReport>;
  readSpecReadyHash: (ticketId: string) => Promise<string>;
  readTicketUrl: (ticketId: string) => Promise<string>;
  markSpecReady: (ticketId: string, hash: string) => Promise<void>;
  /**
   * Generate the execution contract JSON for an approved ticket. Throws on
   * failure. Optional: when absent, the gate falls back to legacy
   * mark-spec-ready-only behavior (e.g. scheduler paths / tests not exercising
   * contracts).
   */
  generateContract?: (ticketId: string, projectDir: string, specBody: string) => Promise<string>;
  /** Persist the contract JSON on the ticket (comment + label). Throws on failure. */
  storeContract?: (ticketId: string, projectDir: string, json: string, hash: string) => Promise<void>;
}

/**
 * Atomic post-gate-pass step: generate the contract, store it, then mark the
 * ticket spec-ready. Spec-ready is set ONLY on full success, so a cached "pass"
 * always implies a stored, current contract. When contract deps are not wired,
 * preserves the legacy behavior (mark spec-ready immediately).
 */
export async function finalizeSpecGatePass(
  ticketId: string,
  projectDir: string,
  body: string,
  hash: string,
  deps: Pick<SpecGateDeps, 'generateContract' | 'storeContract' | 'markSpecReady'>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!deps.generateContract || !deps.storeContract) {
    if (hash) await deps.markSpecReady(ticketId, hash);
    return { ok: true };
  }
  try {
    const json = await deps.generateContract(ticketId, projectDir, body);
    await deps.storeContract(ticketId, projectDir, json, hash);
    if (hash) await deps.markSpecReady(ticketId, hash);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
  const config = deps.getProviderConfig(projectDir);
  if (!config) {
    return {
      passed: false,
      questions: [],
      gateSummary: 'No ticket provider configured',
      ticketUrl: null,
      cached: false,
      error:
        'No ticket provider configured for this project. Configure GitHub or Jira in Project Settings.',
    };
  }

  const body = await deps.fetchTicket(ticketId, projectDir);
  if (!body) {
    return {
      passed: false,
      questions: [],
      gateSummary: 'Ticket provider returned no output',
      ticketUrl: null,
      cached: false,
      error: `Ticket provider returned no output for ticket "${ticketId}".`,
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
    const fin = await finalizeSpecGatePass(ticketId, projectDir, body, curHash, deps);
    if (!fin.ok) {
      // Gate passed but the contract step failed: report NOT passed so the
      // ticket stays in Refining and the existing Retry re-attempts.
      return {
        passed: false,
        questions: [],
        gateSummary: 'Spec passed; contract generation failed',
        ticketUrl: url || null,
        cached: false,
        contractError: fin.error,
      };
    }
  }

  return {
    passed,
    questions: passed ? [] : extractQuestions(reportText),
    gateSummary: extractGateSummary(reportText),
    ticketUrl: url || null,
    cached: false,
    reportText: passed ? null : capReportText(reportText),
  };
}

/**
 * Run a refinement step — pipes the user's answers to the spec-refine
 * handler, then trims the response.
 */
export async function runSpecRefine(
  ticketId: string,
  projectDir: string,
  userAnswers: string,
  deps: SpecGateDeps
): Promise<SpecGateResult> {
  const config = deps.getProviderConfig(projectDir);
  if (!config) {
    return {
      passed: false,
      questions: [],
      gateSummary: 'No ticket provider configured',
      ticketUrl: null,
      cached: false,
      error:
        'No ticket provider configured for this project. Configure GitHub or Jira in Project Settings.',
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
    reportText: passed ? null : capReportText(reportText),
  };
}

/**
 * Default deps wired to the real ticket-config + tools.ts handlers.
 * The `getProviderConfig` dep is injected from the IPC layer so this module
 * does not depend on the registry directly.
 */
export function defaultSpecGateDeps(
  runCheck: (ticketId: string, projectDir: string) => Promise<SpecGateReport>,
  runRefine: (
    ticketId: string,
    projectDir: string,
    userAnswers?: string
  ) => Promise<SpecGateReport>,
  getProviderConfig: (projectDir: string) => ProjectTicketConfig | null,
  contractDeps?: Pick<SpecGateDeps, 'generateContract' | 'storeContract'>,
): SpecGateDeps {
  return {
    fetchTicket: async (ticketId, projectDir) => {
      const config = getProviderConfig(projectDir);
      if (!config) return null;
      return fetchTicketWithConfig(ticketId, config, projectDir);
    },
    getProviderConfig,
    runCheck,
    runRefine,
    readSpecReadyHash,
    readTicketUrl,
    markSpecReady,
    generateContract: contractDeps?.generateContract,
    storeContract: contractDeps?.storeContract,
  };
}

export interface FetchTicketResult {
  body: string;
  url: string | null;
}

/**
 * Fetch the rendered ticket body for the renderer. Returns the body and
 * (best-effort) the issue URL. The config is read from the registry by
 * the IPC layer and passed in here.
 */
export async function fetchTicketForRenderer(
  ticketId: string,
  config: ProjectTicketConfig | null,
  projectDir: string,
): Promise<FetchTicketResult> {
  if (!config) {
    throw new Error(
      'No ticket provider configured for this project. Configure GitHub or Jira in Project Settings.'
    );
  }
  const body = await fetchTicketWithConfig(ticketId, config, projectDir);
  if (!body) {
    throw new Error(`Ticket provider returned no output for ticket "${ticketId}".`);
  }
  let url: string | null = null;
  if (config.provider === 'jira' && config.jira_url) {
    url = `${config.jira_url.replace(/\/$/, '')}/browse/${ticketId}`;
  } else {
    url = await readTicketUrl(ticketId) || null;
  }
  return { body, url };
}
