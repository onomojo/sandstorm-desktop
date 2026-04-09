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

import * as nodePty from 'node-pty';
import { exec } from 'child_process';

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
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// ---------------------------------------------------------------------------
// Claude CLI dependency check
// ---------------------------------------------------------------------------

let claudeChecked = false;
let claudeAvailable = false;

export async function checkClaudeInstalled(): Promise<boolean> {
  if (claudeChecked) return claudeAvailable;
  try {
    await execAsync('which claude');
    claudeAvailable = true;
  } catch {
    claudeAvailable = false;
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
  const re = new RegExp(
    label + '[^\\n]*\\n[^\\n]*?\\s(\\d+)%\\s*used[^\\n]*\\n[^\\n]*Resets ([^\\n]+)'
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
 * Returns the buffer content when a marker is found, or null on timeout.
 */
function waitForOutput(
  ptyProcess: nodePty.IPty,
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

  const claudeArgs = [
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', 'user',
  ];

  let proc: nodePty.IPty | null = null;
  const buffer = { value: '' };

  try {
    // Launch claude in a pseudo-terminal
    proc = nodePty.spawn('claude', claudeArgs, {
      name: 'xterm-256color',
      cols: 220,
      rows: 60,
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      },
    });

    // Collect all output into buffer — single global listener ensures no data
    // is lost between waitForOutput calls (e.g. during sleep intervals).
    proc.onData((data) => {
      buffer.value += data;
    });

    // Wait for claude to be ready (look for "for shortcuts" prompt)
    const ready = await waitForOutput(proc, ['for shortcuts'], 15_000, buffer);

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
  } catch {
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
