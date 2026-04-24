import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export type TicketProvider = 'github' | 'jira' | 'skeleton';

/**
 * Auto-detect the project's ticket provider using the same rules as
 * `sandstorm init` (see sandstorm-cli/lib/init.sh::detect_ticket_provider).
 * Ported so the desktop app can surface the same detection in the migration
 * modal and in any "install update-ticket.sh" prompt.
 *
 * Rules, first match wins:
 *   1. Atlassian MCP config in .mcp.json → 'jira'
 *   2. `gh` binary on PATH AND a GitHub git remote → 'github'
 *   3. otherwise → 'skeleton' (user customizes manually)
 */
export function detectTicketProvider(projectDir: string): TicketProvider {
  try {
    const mcpPath = path.join(projectDir, '.mcp.json');
    if (fs.existsSync(mcpPath)) {
      const contents = fs.readFileSync(mcpPath, 'utf-8');
      if (contents.includes('"atlassian"')) return 'jira';
    }
  } catch {
    // Unreadable .mcp.json — fall through to github/skeleton detection.
  }

  if (hasGhBinary() && hasGitHubRemote(projectDir)) return 'github';

  return 'skeleton';
}

function hasGhBinary(): boolean {
  try {
    const result = spawnSync('gh', ['--version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function hasGitHubRemote(projectDir: string): boolean {
  try {
    const result = spawnSync('git', ['remote', '-v'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return false;
    return /github\.com/.test(result.stdout || '');
  } catch {
    return false;
  }
}

/**
 * Resolve the path to a bundled template script. The desktop app ships the
 * `sandstorm-cli` tree (see src/main/index.ts::cliDir) so templates live at
 * `<cliDir>/templates/<provider>/scripts/<name>`. Returns the path whether
 * or not it exists — callers check before copying.
 */
export function templateScriptPath(
  cliDir: string,
  provider: TicketProvider,
  scriptName: string,
): string {
  return path.join(cliDir, 'templates', provider, 'scripts', scriptName);
}

/**
 * Install a named script from the selected provider template into the
 * project's `.sandstorm/scripts/` directory, creating the directory if
 * needed. Overwrites any existing file — callers typically check script
 * status or confirm in the UI before calling.
 *
 * Returns the destination path on success.
 */
export function installScript(opts: {
  projectDir: string;
  cliDir: string;
  provider: TicketProvider;
  scriptName: string;
}): string {
  const src = templateScriptPath(opts.cliDir, opts.provider, opts.scriptName);
  if (!fs.existsSync(src)) {
    throw new Error(
      `${opts.scriptName} template not found for provider '${opts.provider}' at ${src}`,
    );
  }
  const destDir = path.join(opts.projectDir, '.sandstorm', 'scripts');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, opts.scriptName);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

/**
 * Back-compat wrapper for the update-ticket.sh install flow shipped in #319.
 * Keeps the narrower IPC signature unchanged while routing through the
 * generic installer.
 */
export function installUpdateScript(opts: {
  projectDir: string;
  cliDir: string;
  provider: TicketProvider;
}): string {
  return installScript({ ...opts, scriptName: 'update-ticket.sh' });
}
