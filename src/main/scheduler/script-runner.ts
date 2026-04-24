/**
 * Script-runner — the `run-script` scheduled action.
 *
 * Resolves and invokes a user script under
 * `<projectDir>/.sandstorm/scripts/scheduled/<scriptName>`, with the project
 * directory as cwd and a few `SANDSTORM_*` env vars.
 *
 * Deterministic-philosophy contract (CLAUDE.md):
 *   - NEVER routes through the outer-Claude chat.
 *   - Bounded: each run times out at `SCRIPT_TIMEOUT_MS` (30 min).
 *   - Script stdout is parsed line-by-line. Lines that look like JSON
 *     directives (`{"cmd": "..."}`) are handed to the directive dispatcher;
 *     everything else is logged as diagnostic output. This PR ships NO
 *     built-in directives — scripts can already shell out to `gh`, `curl`,
 *     etc. directly. Follow-up PRs add directives for app primitives
 *     (dispatch-ticket, make-pr-for-stack, etc.).
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  ScheduledDispatchRequest,
  ScheduledDispatchResponse,
} from './types';

export const SCRIPT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const STDERR_TAIL_CHARS = 2000;

/**
 * JSON directive emitted on a script's stdout. Structure is open-ended;
 * `cmd` identifies the handler. Not used in this PR (no directives
 * registered yet) — follow-up PRs add handlers for dispatch-ticket /
 * make-pr-for-stack / etc.
 */
export interface ScriptDirective {
  cmd: string;
  [key: string]: unknown;
}

/** Registry of directive handlers. Empty in this PR. */
export type DirectiveHandler = (
  directive: ScriptDirective,
  ctx: { projectDir: string; scheduleId: string; firedAt: string },
) => Promise<void>;

const directiveHandlers = new Map<string, DirectiveHandler>();

/**
 * Register a directive handler. Call at module init from follow-up PRs
 * that add primitive-level directives.
 */
export function registerDirective(cmd: string, handler: DirectiveHandler): void {
  directiveHandlers.set(cmd, handler);
}

/**
 * Clear the directive registry. Test-only — production code registers at
 * init and never unregisters.
 */
export function _clearDirectivesForTesting(): void {
  directiveHandlers.clear();
}

/**
 * Resolve `<projectDir>/.sandstorm/scripts/scheduled/<scriptName>`, rejecting
 * any path that traverses outside the scheduled-scripts directory.
 *
 * Returns the resolved absolute path on success, or an error message on
 * rejection.
 */
export function resolveScheduledScriptPath(
  projectDir: string,
  scriptName: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = scriptName.trim();
  if (!trimmed) return { ok: false, error: 'scriptName is empty' };
  if (path.isAbsolute(trimmed)) {
    return { ok: false, error: 'scriptName must be relative (no leading `/`)' };
  }
  const withExt = trimmed.endsWith('.sh') ? trimmed : `${trimmed}.sh`;
  const scriptsDir = path.resolve(projectDir, '.sandstorm', 'scripts', 'scheduled');
  const candidate = path.resolve(scriptsDir, withExt);
  // Enforce containment inside scriptsDir.
  const rel = path.relative(scriptsDir, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `scriptName escapes .sandstorm/scripts/scheduled/` };
  }
  return { ok: true, path: candidate };
}

export interface ScriptRunnerDeps {
  /**
   * Provided so tests can inject a fake spawner. Production uses
   * node's `child_process.spawn` directly.
   */
  spawn?: typeof spawn;
}

/**
 * Invoke a scheduled script. Resolves to the socket-server response the
 * caller should forward: `{ok:true, dispatchId}` on success or
 * `{ok:false, reason, message}` on failure.
 */
export async function runScheduledScript(
  projectDir: string,
  scriptName: string,
  request: Pick<ScheduledDispatchRequest, 'scheduleId' | 'firedAt'>,
  deps: ScriptRunnerDeps = {},
): Promise<ScheduledDispatchResponse> {
  const resolved = resolveScheduledScriptPath(projectDir, scriptName);
  if (!resolved.ok) {
    return { ok: false, reason: 'internal-error', message: resolved.error };
  }
  const scriptPath = resolved.path;

  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      reason: 'internal-error',
      message: `Script not found at ${scriptPath}. ` +
        `Create it under .sandstorm/scripts/scheduled/ and chmod +x.`,
    };
  }
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
  } catch {
    return {
      ok: false,
      reason: 'internal-error',
      message: `Script exists but is not executable. Run: chmod +x ${scriptPath}`,
    };
  }

  const spawnFn = deps.spawn ?? spawn;
  const dispatchId = `dispatch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  return new Promise<ScheduledDispatchResponse>((resolveResponse) => {
    let settled = false;
    const settle = (r: ScheduledDispatchResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResponse(r);
    };

    let stdoutBuffer = '';
    let stderrTail = '';

    const child = spawnFn(scriptPath, [], {
      cwd: projectDir,
      env: {
        ...process.env,
        SANDSTORM_PROJECT_DIR: projectDir,
        SANDSTORM_SCHEDULE_ID: request.scheduleId,
        SANDSTORM_FIRED_AT: request.firedAt,
        SANDSTORM_DISPATCH_ID: dispatchId,
        HOME: process.env.HOME ?? os.homedir(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch { /* already gone */ }
      settle({
        ok: false,
        reason: 'internal-error',
        message: `Script timed out after ${SCRIPT_TIMEOUT_MS / 60000} minutes`,
      });
    }, SCRIPT_TIMEOUT_MS);

    child.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString();
      let nl = stdoutBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        void handleLine(line, projectDir, request);
        nl = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderrTail = (stderrTail + data.toString()).slice(-STDERR_TAIL_CHARS);
    });

    child.on('error', (err) => {
      settle({
        ok: false,
        reason: 'internal-error',
        message: `Failed to spawn script: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      // Flush any remaining partial stdout line.
      if (stdoutBuffer.trim()) {
        void handleLine(stdoutBuffer, projectDir, request);
        stdoutBuffer = '';
      }
      if (code === 0) {
        settle({ ok: true, dispatchId });
      } else {
        settle({
          ok: false,
          reason: 'internal-error',
          message: `Script exited with code ${code}: ${stderrTail.trim() || '(no stderr)'}`,
        });
      }
    });
  });
}

async function handleLine(
  line: string,
  projectDir: string,
  request: Pick<ScheduledDispatchRequest, 'scheduleId' | 'firedAt'>,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Only treat `{…}` lines as potential directives. Non-JSON output is
  // logged as diagnostic; we don't want to swallow innocent stdout.
  if (!trimmed.startsWith('{')) {
    console.log(`[scheduler][${request.scheduleId}] ${trimmed}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    console.log(`[scheduler][${request.scheduleId}] ${trimmed}`);
    return;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as ScriptDirective).cmd !== 'string'
  ) {
    console.log(`[scheduler][${request.scheduleId}] ${trimmed}`);
    return;
  }

  const directive = parsed as ScriptDirective;
  const handler = directiveHandlers.get(directive.cmd);
  if (!handler) {
    console.warn(
      `[scheduler][${request.scheduleId}] No handler registered for directive "${directive.cmd}" — ignoring`,
    );
    return;
  }
  try {
    await handler(directive, { projectDir, scheduleId: request.scheduleId, firedAt: request.firedAt });
  } catch (err) {
    console.error(
      `[scheduler][${request.scheduleId}] Directive "${directive.cmd}" threw:`,
      err,
    );
  }
}
