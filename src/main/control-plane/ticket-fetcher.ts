import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Fetch ticket context by running the project's `.sandstorm/scripts/fetch-ticket.sh` script.
 * Returns the script's stdout (standardized markdown), or null if the script
 * doesn't exist, isn't executable, or fails.
 */
export async function fetchTicketContext(
  ticketId: string,
  projectDir: string
): Promise<string | null> {
  const scriptPath = path.join(projectDir, '.sandstorm', 'scripts', 'fetch-ticket.sh');

  if (!fs.existsSync(scriptPath)) {
    console.warn(
      `[sandstorm] No fetch-ticket script found at ${scriptPath}. ` +
      `Configure a ticket provider with 'sandstorm init' or create the script manually.`
    );
    return null;
  }

  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
  } catch {
    console.warn(
      `[sandstorm] fetch-ticket.sh exists but is not executable. Run: chmod +x ${scriptPath}`
    );
    return null;
  }

  try {
    return await runFetchScript(scriptPath, ticketId, projectDir);
  } catch {
    return null;
  }
}

function runFetchScript(scriptPath: string, ticketId: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      scriptPath,
      [ticketId],
      { cwd, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          if (stderr) {
            console.warn(`[sandstorm] fetch-ticket.sh failed: ${stderr.trim()}`);
          }
          return reject(err);
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * Detect whether a task prompt references a ticket.
 * Matches GitHub patterns (#123, owner/repo#123, GitHub URLs),
 * Jira patterns (PROJ-123), and Linear patterns (LIN-123).
 */
export function referencesTicket(prompt: string): boolean {
  // #123 (standalone issue number)
  if (/(?:^|\s)#\d+/.test(prompt)) return true;
  // owner/repo#123
  if (/[\w.-]+\/[\w.-]+#\d+/.test(prompt)) return true;
  // GitHub issue URL
  if (/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/.test(prompt)) return true;
  // Jira-style: PROJ-123 (2+ uppercase letters, dash, digits)
  if (/(?:^|\s)[A-Z]{2,}-\d+/.test(prompt)) return true;
  // Linear-style URLs
  if (/linear\.app\/[\w.-]+\/issue\/[\w-]+/.test(prompt)) return true;
  return false;
}
