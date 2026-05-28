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

function runLabelScript(
  scriptName: string,
  ticketId: string,
  label: string,
  projectDir: string,
): Promise<void> {
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
    if (!ticketId.trim()) {
      reject(new Error('Ticket ID is required'));
      return;
    }
    if (!label.trim()) {
      reject(new Error('Label is required'));
      return;
    }
    execFile(
      scriptPath,
      [ticketId, label],
      { cwd: projectDir, timeout: 30000, maxBuffer: 512 * 1024 },
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

/**
 * Add a label to a ticket. Runs `add-label.sh <ticket-id> <label>`.
 * Provider-neutral — GitHub, Jira, or any custom backend.
 */
export function addLabel(
  ticketId: string,
  projectDir: string,
  label: string,
): Promise<void> {
  return runLabelScript('add-label.sh', ticketId, label, projectDir);
}

/**
 * Remove a label from a ticket. Runs `remove-label.sh <ticket-id> <label>`.
 * Provider-neutral — GitHub, Jira, or any custom backend.
 */
export function removeLabel(
  ticketId: string,
  projectDir: string,
  label: string,
): Promise<void> {
  return runLabelScript('remove-label.sh', ticketId, label, projectDir);
}
