import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);

/** Hard cap on the body the ephemeral drafter is allowed to emit (#310). */
export const PR_BODY_MAX_BYTES = 8192;
/** Hard cap on the title (gh truncates anyway, but we surface a clean error). */
export const PR_TITLE_MAX_CHARS = 70;
/** Time budget for the draft-body ephemeral call. */
export const PR_DRAFT_TIMEOUT_MS = 90_000;

export interface DraftedPR {
  title: string;
  body: string;
}

export interface PRCreateResult {
  url: string;
  number: number;
}

/**
 * Resolve the on-disk workspace directory for a stack. Stacks live under
 * `<projectDir>/.sandstorm/workspaces/<stackId>/` — see stack-manager.ts:1315.
 */
export function workspacePathFor(projectDir: string, stackId: string): string {
  return path.join(projectDir, '.sandstorm', 'workspaces', stackId);
}

/** Run `git log <baseBranch>..HEAD --pretty=format:%s%n%b`. */
async function gitCommits(workspace: string, baseBranch = 'main'): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', `${baseBranch}..HEAD`, '--pretty=format:%s%n%b%n---'],
      { cwd: workspace, timeout: 15000, maxBuffer: 1024 * 1024 }
    );
    return stdout.trim();
  } catch {
    // Fall back to last 10 commits if base branch is missing.
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', '-n', '10', '--pretty=format:%s%n%b%n---'],
        { cwd: workspace, timeout: 15000, maxBuffer: 1024 * 1024 }
      );
      return stdout.trim();
    } catch {
      return '';
    }
  }
}

/** Run `git diff --stat <baseBranch>..HEAD` for context. */
async function gitDiffStat(workspace: string, baseBranch = 'main'): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--stat', `${baseBranch}..HEAD`],
      { cwd: workspace, timeout: 15000, maxBuffer: 1024 * 1024 }
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Resolve which branch the workspace is on, for error messaging. */
async function gitCurrentBranch(workspace: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: workspace, timeout: 5000 }
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Strict-JSON draft prompt fed to the ephemeral agent. */
export function buildDraftPrompt(opts: {
  ticket: string | null;
  ticketUrl?: string | null;
  branch: string;
  commits: string;
  diffStat: string;
  taskOutputTail: string;
}): string {
  const ticketLine = opts.ticket
    ? `Closes #${opts.ticket.replace(/^#/, '')}`
    : '';
  return `You are drafting a GitHub pull request body for changes on the branch "${opts.branch}".

Output STRICT JSON only — no prose, no code fences, no preamble. Schema:
{"title": "<≤70 chars summary>", "body": "<markdown body>"}

Body structure:
## Summary
- 1–3 bullets describing what changed and WHY (not what files moved)

## Test plan
- [ ] checklist of how a reviewer should validate

${ticketLine ? ticketLine + '\n\n' : ''}Hard limits: title ≤ 70 chars, body ≤ ${PR_BODY_MAX_BYTES} bytes.
Do NOT include "Generated with Claude Code" boilerplate. Do NOT include emojis.
Match this repo's commit style — lowercase verbs, no marketing.

Commits on this branch:
${opts.commits || '(no commits found)'}

Diff stat:
${opts.diffStat || '(no diff stat)'}

Last task output (truncated tail):
${opts.taskOutputTail || '(no task output)'}
`;
}

/**
 * Parse the strict-JSON draft response. Tolerates a single leading code fence
 * (```json ... ```) since some Claude responses wrap JSON despite instructions.
 */
export function parseDraftResponse(raw: string): DraftedPR {
  let text = raw.trim();
  // Strip ```json fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Find the first JSON object
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Draft response did not contain JSON: ${text.slice(0, 200)}`);
  }
  const slice = text.slice(start, end + 1);
  const parsed = JSON.parse(slice) as { title?: unknown; body?: unknown };
  if (typeof parsed.title !== 'string' || typeof parsed.body !== 'string') {
    throw new Error('Draft JSON missing title or body');
  }
  const title = parsed.title.trim();
  const body = parsed.body.trim();
  if (!title) throw new Error('Draft title was empty');
  if (!body) throw new Error('Draft body was empty');
  if (Buffer.byteLength(body, 'utf8') > PR_BODY_MAX_BYTES) {
    throw new Error(
      `Draft body exceeds ${PR_BODY_MAX_BYTES} bytes (got ${Buffer.byteLength(body, 'utf8')})`
    );
  }
  return {
    title: title.length > PR_TITLE_MAX_CHARS ? title.slice(0, PR_TITLE_MAX_CHARS) : title,
    body,
  };
}

export interface DraftDeps {
  /** One-shot Claude call. Returns the agent's full text response. */
  runEphemeral: (prompt: string, projectDir: string, timeoutMs?: number) => Promise<string>;
  /** Tail of `/tmp/claude-task.log` from the stack. Empty string when unavailable. */
  fetchTaskTail?: (stackId: string) => Promise<string>;
}

export interface DraftPRArgs {
  stackId: string;
  workspace: string;
  ticket: string | null;
  ticketUrl?: string | null;
  baseBranch?: string;
}

/**
 * Generate a PR title + body for a stack. Pure-ish — only side effect is
 * the bounded ephemeral Claude call delegated through `deps.runEphemeral`.
 */
export async function draftPullRequest(args: DraftPRArgs, deps: DraftDeps): Promise<DraftedPR> {
  if (!fs.existsSync(args.workspace)) {
    throw new Error(`Stack workspace not found at ${args.workspace}`);
  }
  const baseBranch = args.baseBranch || 'main';
  const [commits, diffStat, branch, tail] = await Promise.all([
    gitCommits(args.workspace, baseBranch),
    gitDiffStat(args.workspace, baseBranch),
    gitCurrentBranch(args.workspace),
    deps.fetchTaskTail ? deps.fetchTaskTail(args.stackId).catch(() => '') : Promise.resolve(''),
  ]);
  const prompt = buildDraftPrompt({
    ticket: args.ticket,
    ticketUrl: args.ticketUrl ?? null,
    branch: branch || '(unknown)',
    commits,
    diffStat,
    taskOutputTail: tail,
  });
  const raw = await deps.runEphemeral(prompt, args.workspace, PR_DRAFT_TIMEOUT_MS);
  return parseDraftResponse(raw);
}

/**
 * Run `gh pr create` in the stack workspace. Returns the parsed URL + number.
 * `gh` writes the URL to stdout on success: e.g. https://github.com/owner/repo/pull/123
 */
export function createPullRequest(args: {
  workspace: string;
  title: string;
  body: string;
  baseBranch?: string;
}): Promise<PRCreateResult> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(args.workspace)) {
      reject(new Error(`Stack workspace not found at ${args.workspace}`));
      return;
    }
    const ghArgs = [
      'pr', 'create',
      '--title', args.title,
      '--body', args.body,
    ];
    if (args.baseBranch) ghArgs.push('--base', args.baseBranch);

    const child = spawn('gh', ghArgs, {
      cwd: args.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `gh pr create exited with code ${code}`));
        return;
      }
      const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
      if (!urlMatch) {
        reject(new Error(`Could not parse PR URL from gh output: ${stdout.trim()}`));
        return;
      }
      resolve({ url: urlMatch[0], number: Number(urlMatch[1]) });
    });
  });
}
