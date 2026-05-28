import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getSandstormScriptStatus, type ScriptStatus } from './ticket-updater';

export interface CreatedTicket {
  url: string;
  ticketId: string;
}

/** Status check for create-ticket.sh, mirrors the other script helpers. */
export function getCreateTicketScriptStatus(projectDir: string): ScriptStatus {
  return getSandstormScriptStatus(projectDir, 'create-ticket.sh');
}

/**
 * File a new ticket by running `.sandstorm/scripts/create-ticket.sh <title> <body>`.
 * Provider-neutral — GitHub, Jira, or any custom backend — so long as the
 * project's script implements the `<title> <body>` contract and prints the
 * created ticket's URL on stdout. The ticket id is taken from the URL's
 * last path segment (works for `/issues/123` and `/browse/PROJ-123`).
 */
export function createTicket(opts: {
  projectDir: string;
  title: string;
  body: string;
}): Promise<CreatedTicket> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(opts.projectDir)) {
      reject(new Error(`Project directory not found at ${opts.projectDir}`));
      return;
    }
    const title = opts.title.trim();
    const body = opts.body.trim();
    if (!title) {
      reject(new Error('Ticket title is required'));
      return;
    }
    if (!body) {
      reject(new Error('Ticket body is required'));
      return;
    }

    const scriptPath = path.join(opts.projectDir, '.sandstorm', 'scripts', 'create-ticket.sh');
    const status = getCreateTicketScriptStatus(opts.projectDir);
    if (status === 'missing') {
      reject(new Error(
        `create-ticket.sh is missing at ${scriptPath}. ` +
        'The Create Ticket dialog can\'t file a new ticket until you install it. ' +
        'Re-run `sandstorm init` or install the script via the project migration prompt.',
      ));
      return;
    }
    if (status === 'not_executable') {
      reject(new Error(
        `create-ticket.sh exists but is not executable. Run: chmod +x ${scriptPath}`,
      ));
      return;
    }

    execFile(
      scriptPath,
      [title, body],
      { cwd: opts.projectDir, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message;
          reject(new Error(`create-ticket.sh failed: ${msg}`));
          return;
        }
        const parsed = parseTicketUrl(stdout);
        if (!parsed) {
          reject(new Error(
            `Could not parse a ticket URL from create-ticket.sh output. ` +
            `Expected an http(s) URL on the final line of stdout. Got: ${stdout.trim()}`,
          ));
          return;
        }
        resolve(parsed);
      },
    );
  });
}

function parseTicketUrl(stdout: string): CreatedTicket | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/https?:\/\/\S+/);
    if (!match) continue;
    const url = match[0].replace(/[.,;:)\]]+$/, '');
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      const ticketId = segments[segments.length - 1];
      if (!ticketId) continue;
      return { url, ticketId };
    } catch {
      continue;
    }
  }
  return null;
}
