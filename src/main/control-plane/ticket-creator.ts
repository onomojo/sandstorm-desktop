import { spawn } from 'child_process';
import fs from 'fs';

export interface CreatedTicket {
  url: string;
  number: number;
  ticketId: string;
}

/**
 * File a new GitHub issue via `gh issue create`. Returns the URL + number
 * parsed from gh's stdout (e.g. https://github.com/owner/repo/issues/315).
 *
 * Pure-ish — only effect is the gh subprocess. No Electron deps, fully
 * test-injectable via the optional `runner` arg (not used in production).
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

    const child = spawn('gh', ['issue', 'create', '--title', title, '--body', body], {
      cwd: opts.projectDir,
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
        reject(new Error(stderr.trim() || stdout.trim() || `gh issue create exited with code ${code}`));
        return;
      }
      const match = stdout.match(/https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/);
      if (!match) {
        reject(new Error(`Could not parse issue URL from gh output: ${stdout.trim()}`));
        return;
      }
      resolve({ url: match[0], number: Number(match[1]), ticketId: match[1] });
    });
  });
}

