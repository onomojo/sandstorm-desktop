import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

type ScriptStatus = 'ok' | 'missing' | 'not_executable';

function getSandstormScriptStatus(projectDir: string, scriptName: string): ScriptStatus {
  const scriptPath = path.join(projectDir, '.sandstorm', 'scripts', scriptName);
  if (!fs.existsSync(scriptPath)) return 'missing';
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
    return 'ok';
  } catch {
    return 'not_executable';
  }
}

export interface TicketComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface TicketEntry {
  id: string;
  title: string;
  author: string;
}

function runScript(
  scriptName: string,
  projectDir: string,
  args: string[],
  timeoutMs = 30000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(projectDir, '.sandstorm', 'scripts', scriptName);
    const status = getSandstormScriptStatus(projectDir, scriptName);
    if (status === 'missing') {
      reject(new Error(`${scriptName} is missing at ${scriptPath}.`));
      return;
    }
    if (status === 'not_executable') {
      reject(new Error(`${scriptName} exists but is not executable. Run: chmod +x ${scriptPath}`));
      return;
    }
    execFile(
      scriptPath,
      args,
      { cwd: projectDir, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message;
          reject(new Error(`${scriptName} failed: ${msg}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * List open tickets for the current auth user carrying the given label.
 * Runs `list-tickets.sh <label>` and parses its TSV output.
 */
export async function listTickets(
  label: string,
  projectDir: string,
): Promise<TicketEntry[]> {
  const stdout = await runScript('list-tickets.sh', projectDir, [label]);
  const lines = stdout.split('\n').filter((l) => l.trim());
  return lines.map((line) => {
    const parts = line.split('\t');
    return {
      id: parts[0]?.trim() ?? '',
      title: parts[1]?.trim() ?? '',
      author: parts[2]?.trim() ?? '',
    };
  }).filter((e) => e.id);
}

/**
 * List all comments on a ticket. Runs `list-comments.sh <ticket-id>` and
 * parses its JSON array output.
 */
export async function listTicketComments(
  ticketId: string,
  projectDir: string,
): Promise<TicketComment[]> {
  const stdout = await runScript('list-comments.sh', projectDir, [ticketId]);
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === '[]') return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: unknown) => {
      const c = item as Record<string, unknown>;
      return {
        author: String(c['author'] ?? ''),
        body: String(c['body'] ?? ''),
        createdAt: String(c['createdAt'] ?? ''),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Post a comment on a ticket. Runs `post-comment.sh <ticket-id> <body>`.
 */
export function postComment(
  ticketId: string,
  projectDir: string,
  body: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptName = 'post-comment.sh';
    const scriptPath = path.join(projectDir, '.sandstorm', 'scripts', scriptName);
    const status = getSandstormScriptStatus(projectDir, scriptName);
    if (status === 'missing') {
      reject(new Error(`${scriptName} is missing at ${scriptPath}.`));
      return;
    }
    if (status === 'not_executable') {
      reject(new Error(`${scriptName} exists but is not executable. Run: chmod +x ${scriptPath}`));
      return;
    }
    if (!ticketId.trim()) {
      reject(new Error('Ticket ID is required'));
      return;
    }
    if (!body.trim()) {
      reject(new Error('Comment body cannot be empty'));
      return;
    }
    execFile(
      scriptPath,
      [ticketId, body],
      { cwd: projectDir, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message;
          reject(new Error(`${scriptName} failed: ${msg}`));
          return;
        }
        resolve();
      },
    );
  });
}
