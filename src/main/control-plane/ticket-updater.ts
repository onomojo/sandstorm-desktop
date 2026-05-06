import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export type ScriptStatus = 'ok' | 'missing' | 'not_executable';

/**
 * Check whether a named script under .sandstorm/scripts/ exists and is
 * executable. Mirrors getScriptStatus in ticket-fetcher.ts.
 */
export function getSandstormScriptStatus(
  projectDir: string,
  scriptName: string,
): ScriptStatus {
  const scriptPath = path.join(projectDir, '.sandstorm', 'scripts', scriptName);
  if (!fs.existsSync(scriptPath)) return 'missing';
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
    return 'ok';
  } catch {
    return 'not_executable';
  }
}

/** Back-compat alias for the update-ticket.sh status check from #319. */
export function getUpdateScriptStatus(projectDir: string): ScriptStatus {
  return getSandstormScriptStatus(projectDir, 'update-ticket.sh');
}

/** Status check for create-pr.sh (#320 — unified PR creation path). */
export function getCreatePrScriptStatus(projectDir: string): ScriptStatus {
  return getSandstormScriptStatus(projectDir, 'create-pr.sh');
}

/** Status check for start-ticket.sh. */
export function getStartScriptStatus(projectDir: string): ScriptStatus {
  return getSandstormScriptStatus(projectDir, 'start-ticket.sh');
}

/**
 * Write an updated body back to the project's ticket system by running
 * `.sandstorm/scripts/update-ticket.sh <ticket-id> <body>`. Provider-neutral —
 * GitHub, Jira, or any custom backend — so long as the project's script
 * implements the `<ticket-id> <body>` contract.
 *
 * Rejects on missing/non-executable script so callers can surface a clear
 * error to the user (and the refine flow can tell them the ticket on
 * GitHub/Jira is still stale).
 */
export function updateTicketBody(
  ticketId: string,
  projectDir: string,
  body: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(projectDir, '.sandstorm', 'scripts', 'update-ticket.sh');
    const status = getUpdateScriptStatus(projectDir);
    if (status === 'missing') {
      reject(new Error(
        `update-ticket.sh is missing at ${scriptPath}. ` +
        'The refine step can\'t commit the refined body back to your ticket system until you install it. ' +
        'Re-run `sandstorm init` or install the script via the project migration prompt.',
      ));
      return;
    }
    if (status === 'not_executable') {
      reject(new Error(
        `update-ticket.sh exists but is not executable. Run: chmod +x ${scriptPath}`,
      ));
      return;
    }
    if (!ticketId.trim()) {
      reject(new Error('Ticket ID is required'));
      return;
    }
    if (!body.trim()) {
      reject(new Error('Ticket body cannot be empty'));
      return;
    }

    // Pass body as a positional arg — matches the contract of the existing
    // github/jira/skeleton templates.
    execFile(
      scriptPath,
      [ticketId, body],
      { cwd: projectDir, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message;
          reject(new Error(`update-ticket.sh failed: ${msg}`));
          return;
        }
        resolve();
      },
    );
  });
}
