/**
 * Fetches Claude Code account-level session usage by driving the official
 * `claude` CLI binary in a pseudo-terminal (via node-pty), sending `/usage`,
 * and parsing the rendered TUI output.
 *
 * This replaces the previous tmux-based approach, which only worked on Linux.
 * node-pty works cross-platform (macOS, Linux, Windows) without requiring
 * any external dependencies.
 *
 * Requirements:
 *   - `node-pty` npm package (already a dependency)
 *   - `claude` CLI must be installed and OAuth-authenticated
 *   - Must NOT be called from inside another `claude` session (TTY collision)
 */

import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageBlock {
  percent: number;
  resetsAt: string;
}

export interface UsageSnapshot {
  session: UsageBlock | null;
  weekAll: UsageBlock | null;
  weekSonnet: UsageBlock | null;
  extraUsage: { enabled: boolean };
  capturedAt: string;
  status: 'ok' | 'rate_limited' | 'at_limit' | 'auth_expired' | 'parse_error';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execAsync(cmd: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Strip ANSI escape sequences from PTY output so the parser can work
 * on plain text. PTY output includes color codes, cursor movement, etc.
 */
export function stripAnsi(str: string): string {
  return str
    // Replace cursor-forward (CSI <n> C) with the equivalent number of spaces
    // so that word boundaries are preserved in the cleaned output.
    .replace(/\x1b\[(\d+)C/g, (_m, n) => ' '.repeat(Number(n)))
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    // Normalize line endings: \r\n → \n, then standalone \r → \n.
    // PTY output often uses \r for line breaks in TUI dialogs.
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

// ---------------------------------------------------------------------------
// Dynamic node-pty loader
// ---------------------------------------------------------------------------

let nodePtyModule: typeof import('node-pty') | null = null;
let nodePtyLoadAttempted = false;
let nodePtyLoadError: string | null = null;

/**
 * Ensure the node-pty spawn-helper binary has execute permission.
 *
 * npm does not preserve file permissions on prebuilt binaries, so
 * `spawn-helper` ships as 644 after `npm install`. Without the execute
 * bit every `pty.spawn()` call fails with "posix_spawnp failed." on
 * macOS (and potentially Linux). This fixes it at runtime before the
 * first spawn attempt.
 */
export function ensureSpawnHelperPermissions(): void {
  if (process.platform === 'win32') return;

  try {
    // Resolve the node-pty package directory
    const nodePtyPath = require.resolve('node-pty');
    const nodePtyDir = path.dirname(nodePtyPath);
    // prebuilds live at <node-pty>/prebuilds/<platform>-<arch>/spawn-helper
    const platformArch = `${process.platform}-${process.arch}`;
    const helperPath = path.join(nodePtyDir, '..', 'prebuilds', platformArch, 'spawn-helper');

    if (!fs.existsSync(helperPath)) return;

    const stat = fs.statSync(helperPath);
    const isExecutable = (stat.mode & 0o111) !== 0;
    if (!isExecutable) {
      fs.chmodSync(helperPath, stat.mode | 0o755);
      console.log('[account-usage] Fixed spawn-helper execute permission:', helperPath);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[account-usage] Could not verify spawn-helper permissions:', message);
  }
}

async function loadNodePty(): Promise<typeof import('node-pty') | null> {
  if (nodePtyLoadAttempted) return nodePtyModule;
  nodePtyLoadAttempted = true;

  // Fix spawn-helper permissions before loading — must happen first because
  // node-pty's spawn() will fail on macOS if the helper isn't executable.
  ensureSpawnHelperPermissions();

  try {
    nodePtyModule = await import('node-pty');
    console.log('[account-usage] node-pty loaded successfully');
    return nodePtyModule;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    nodePtyLoadError = message;
    console.error('[account-usage] Failed to load node-pty:', message);
    if (err instanceof Error && err.stack) {
      console.error('[account-usage] Stack:', err.stack);
    }
    return null;
  }
}

/** Reset the node-pty load cache (for testing). */
export function resetNodePtyLoader(): void {
  nodePtyModule = null;
  nodePtyLoadAttempted = false;
  nodePtyLoadError = null;
}

/** Get the last node-pty load error (for diagnostics). */
export function getNodePtyLoadError(): string | null {
  return nodePtyLoadError;
}

// ---------------------------------------------------------------------------
// PATH resolution for Electron
// ---------------------------------------------------------------------------

/**
 * Build a PATH that includes common CLI install locations.
 * Electron apps often launch with a restricted PATH that doesn't include
 * user-installed CLI tools (e.g. `claude` installed via npm global or pipx).
 */
function getEnhancedPath(): string {
  const currentPath = process.env.PATH || '';
  const home = process.env.HOME || '';
  const extraPaths: string[] = [];

  if (home) {
    // Common locations for globally-installed CLI tools
    extraPaths.push(
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.nvm', 'versions', 'node'),  // nvm managed node
      path.join(home, 'bin'),
    );
  }

  // System paths that may be missing in Electron context
  extraPaths.push(
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin',  // macOS Apple Silicon homebrew
    '/home/linuxbrew/.linuxbrew/bin',  // Linux homebrew
  );

  // Only add paths that exist and aren't already in PATH
  const pathSet = new Set(currentPath.split(path.delimiter));
  const additions = extraPaths.filter((p) => {
    if (pathSet.has(p)) return false;
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  if (additions.length > 0) {
    return [...additions, currentPath].join(path.delimiter);
  }
  return currentPath;
}

// ---------------------------------------------------------------------------
// Claude CLI dependency check
// ---------------------------------------------------------------------------

let claudeChecked = false;
let claudeAvailable = false;

export async function checkClaudeInstalled(): Promise<boolean> {
  if (claudeChecked) return claudeAvailable;
  try {
    const enhancedPath = getEnhancedPath();
    await execAsync(`PATH="${enhancedPath}" which claude`);
    claudeAvailable = true;
    console.log('[account-usage] claude CLI found in PATH');
  } catch {
    claudeAvailable = false;
    console.warn('[account-usage] claude CLI not found in PATH');
  }
  claudeChecked = true;
  return claudeAvailable;
}

/** Reset cached check (for testing). */
export function resetClaudeCheck(): void {
  claudeChecked = false;
  claudeAvailable = false;
}


// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a single usage block from the captured output.
 * Looks for a pattern like:
 *   Current session
 *     ███████████████████████▌                           47% used
 *     Resets 6pm (America/New_York)
 */
export function parseUsageBlock(pane: string, label: string): UsageBlock | null {
  // PTY output may insert cursor-movement artifacts inside "Resets" (e.g. "Rese s",
  // "Reset s") so we match R-e-s-e-t-s with optional spaces/missing chars.
  const re = new RegExp(
    label + '[^\\n]*\\n[^\\n]*?\\s(\\d+)%\\s*used[^\\n]*\\n[^\\n]*R\\s*e\\s*s\\s*e\\s*t?\\s*s\\s+([^\\n]+)'
  );
  const m = pane.match(re);
  if (!m) return null;
  // Strip trailing whitespace and box-drawing characters (│, ╯, ╰, etc.)
  const resetsAt = m[2].replace(/[\s│╯╰╮╭─]+$/u, '');
  return { percent: Number(m[1]), resetsAt };
}

/**
 * Detect whether the output indicates a rate-limit on `/usage` itself.
 */
function isRateLimited(pane: string): boolean {
  const lower = pane.toLowerCase();
  return (
    (lower.includes('rate') && lower.includes('limit')) ||
    lower.includes('frequently') ||
    lower.includes('try again') ||
    lower.includes('too many')
  );
}

/**
 * Detect whether the output indicates an expired OAuth session.
 */
function isAuthExpired(pane: string): boolean {
  const lower = pane.toLowerCase();
  return (
    lower.includes('auth') ||
    lower.includes('login') ||
    lower.includes('sign in') ||
    lower.includes('authenticate') ||
    lower.includes('expired')
  );
}

/**
 * Parse the full captured output into a UsageSnapshot.
 */
export function parseUsageOutput(pane: string): UsageSnapshot {
  const session = parseUsageBlock(pane, 'Current session');
  const weekAll = parseUsageBlock(pane, 'Current week \\(all models\\)');
  const weekSonnet = parseUsageBlock(pane, 'Current week \\(Sonnet only\\)');
  const extraUsageEnabled = !/Extra usage not enabled/.test(pane);
  const capturedAt = new Date().toISOString();

  if (session) {
    const status = session.percent >= 95 ? 'at_limit' as const : 'ok' as const;
    return {
      session,
      weekAll,
      weekSonnet,
      extraUsage: { enabled: extraUsageEnabled },
      capturedAt,
      status,
    };
  }

  // No session block found — try to classify the error
  if (isRateLimited(pane)) {
    return {
      session: null, weekAll: null, weekSonnet: null,
      extraUsage: { enabled: false },
      capturedAt,
      status: 'rate_limited',
    };
  }

  if (isAuthExpired(pane)) {
    return {
      session: null, weekAll: null, weekSonnet: null,
      extraUsage: { enabled: false },
      capturedAt,
      status: 'auth_expired',
    };
  }

  return {
    session: null, weekAll: null, weekSonnet: null,
    extraUsage: { enabled: false },
    capturedAt,
    status: 'parse_error',
  };
}

// ---------------------------------------------------------------------------
// PTY-based fetch
// ---------------------------------------------------------------------------

/**
 * Wait for a marker string in the PTY output buffer.
 * Returns true when a marker is found, or false on timeout.
 */
function waitForOutput(
  ptyProcess: { onData: (cb: (data: string) => void) => { dispose: () => void } },
  markers: string[],
  timeoutMs: number,
  existingBuffer: { value: string }
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(false);
    }, timeoutMs);

    // Listen for new data to trigger marker checks, but do NOT append to the
    // buffer here — the caller's global onData listener handles accumulation.
    // This avoids double-appending every chunk.
    const disposable = ptyProcess.onData(() => {
      const clean = stripAnsi(existingBuffer.value);
      for (const marker of markers) {
        if (clean.includes(marker)) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(true);
          return;
        }
      }
    });

    // Also check existing buffer immediately
    const clean = stripAnsi(existingBuffer.value);
    for (const marker of markers) {
      if (clean.includes(marker)) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(true);
        return;
      }
    }
  });
}

/**
 * Fetch real account-level session usage by driving `claude` in a
 * pseudo-terminal, sending `/usage`, and parsing the rendered output.
 *
 * Returns a UsageSnapshot on success, or null if claude is unavailable.
 * The `status` field in the snapshot indicates parse success or specific errors.
 *
 * Wall time: ~3–4 seconds typical, up to ~20s worst case.
 */
export async function fetchAccountUsage(): Promise<UsageSnapshot | null> {
  if (!(await checkClaudeInstalled())) {
    return null;
  }

  const pty = await loadNodePty();
  if (!pty) {
    console.error('[account-usage] Cannot fetch usage: node-pty not available.', nodePtyLoadError ? `Load error: ${nodePtyLoadError}` : '');
    return null;
  }

  const claudeArgs = [
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', 'user',
  ];

  let proc: ReturnType<typeof pty.spawn> | null = null;
  const buffer = { value: '' };

  try {
    const enhancedPath = getEnhancedPath();

    // Launch claude in a pseudo-terminal
    proc = pty.spawn('claude', claudeArgs, {
      name: 'xterm-256color',
      cols: 220,
      rows: 60,
      env: {
        ...process.env,
        PATH: enhancedPath,
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      },
    });

    console.log('[account-usage] PTY spawned claude process');

    // Collect all output into buffer — single global listener ensures no data
    // is lost between waitForOutput calls (e.g. during sleep intervals).
    proc.onData((data) => {
      buffer.value += data;
    });

    // Wait for claude to be ready (look for "for shortcuts" prompt).
    // On first launch the CLI may show a theme-selection onboarding screen.
    // If we detect it, press Enter to accept the default and keep waiting.
    let ready = await waitForOutput(proc, ['for shortcuts'], 15_000, buffer);

    if (!ready) {
      // Check if we're stuck on the onboarding theme picker
      const cleanSoFar = stripAnsi(buffer.value);
      if (cleanSoFar.includes('Choose') && cleanSoFar.includes('text style')) {
        // Accept the default theme selection by pressing Enter.
        // Then keep pressing Enter through any remaining onboarding screens.
        for (let i = 0; i < 8; i++) {
          proc.write('\r');
          await sleep(1500);
          const nowReady = await waitForOutput(proc, ['for shortcuts'], 5_000, buffer);
          if (nowReady) {
            ready = true;
            break;
          }
        }
      }
    }

    if (!ready) {
      return {
        session: null, weekAll: null, weekSonnet: null,
        extraUsage: { enabled: false },
        capturedAt: new Date().toISOString(),
        status: 'parse_error',
      };
    }

    // Small delay to let the prompt fully render
    await sleep(500);

    // Send /usage command
    proc.write('/usage\r');

    // Wait for usage dialog to render
    const usageReady = await waitForOutput(
      proc,
      ['Current session', 'Extra usage'],
      10_000,
      buffer
    );

    if (usageReady) {
      // Give it a moment to finish rendering the full dialog
      await sleep(1000);
    }

    // Strip ANSI codes and parse
    const cleanOutput = stripAnsi(buffer.value);

    // Dismiss dialog and exit cleanly
    try {
      proc.write('\x1b'); // Escape key
      await sleep(300);
      proc.write('/exit\r');
    } catch {
      // Best-effort cleanup
    }

    return parseUsageOutput(cleanOutput);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[account-usage] Error during PTY usage fetch:', message);
    return null;
  } finally {
    // Always kill the PTY process
    if (proc) {
      try {
        proc.kill();
      } catch {
        // Process may already be gone
      }
    }
  }
}
