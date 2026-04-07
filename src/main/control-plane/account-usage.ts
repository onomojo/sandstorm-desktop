/**
 * Fetches Claude Code account-level session usage by driving the official
 * `claude` CLI binary in a detached tmux pane, sending `/usage`, and parsing
 * the rendered TUI output.
 *
 * This approach has been verified end-to-end with real captured output. It
 * retrieves real account-level session data (not aggregated stack tokens).
 *
 * Requirements:
 *   - `tmux` must be installed
 *   - `claude` CLI must be installed and OAuth-authenticated
 *   - Must NOT be called from inside another `claude` session (TTY collision)
 */

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
// Shell helpers
// ---------------------------------------------------------------------------

function execAsync(cmd: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// tmux dependency check
// ---------------------------------------------------------------------------

let tmuxChecked = false;
let tmuxAvailable = false;

export async function checkTmuxInstalled(): Promise<boolean> {
  if (tmuxChecked) return tmuxAvailable;
  try {
    await execAsync('which tmux');
    tmuxAvailable = true;
  } catch {
    tmuxAvailable = false;
  }
  tmuxChecked = true;
  return tmuxAvailable;
}

/** Reset cached check (for testing). */
export function resetTmuxCheck(): void {
  tmuxChecked = false;
  tmuxAvailable = false;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a single usage block from the captured tmux pane output.
 * Looks for a pattern like:
 *   Current session
 *     ███████████████████████▌                           47% used
 *     Resets 6pm (America/New_York)
 */
export function parseUsageBlock(pane: string, label: string): UsageBlock | null {
  // Match: label, then on a following line "N% used", then on the next line "Resets ..."
  // Use non-greedy [^\n]*? before the percent to avoid consuming the digits
  const re = new RegExp(
    label + '[^\\n]*\\n[^\\n]*?\\s(\\d+)% used[^\\n]*\\n[^\\n]*Resets ([^\\n]+)'
  );
  const m = pane.match(re);
  if (!m) return null;
  // Strip trailing whitespace and box-drawing characters (│, ╯, ╰, etc.)
  const resetsAt = m[2].replace(/[\s│╯╰╮╭─]+$/u, '');
  return { percent: Number(m[1]), resetsAt };
}

/**
 * Detect whether the pane output indicates a rate-limit on `/usage` itself.
 * We look for rate-limit-like keywords when no percentage bars are found.
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
 * Detect whether the pane output indicates an expired OAuth session.
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
 * Parse the full tmux pane output into a UsageSnapshot.
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
// Main fetch function
// ---------------------------------------------------------------------------

/**
 * Fetch real account-level session usage by driving `claude` in a detached
 * tmux pane, sending `/usage`, and parsing the rendered output.
 *
 * Returns a UsageSnapshot on success, or null if tmux/claude are unavailable.
 * The `status` field in the snapshot indicates parse success or specific errors.
 *
 * Wall time: ~3–4 seconds typical, up to ~20s worst case.
 */
export async function fetchAccountUsage(): Promise<UsageSnapshot | null> {
  if (!(await checkTmuxInstalled())) {
    return null;
  }

  const session = `claude-usage-${process.pid}-${Date.now()}`;
  const claudeCmd = [
    'CLAUDE_CODE_DISABLE_CLAUDE_MDS=1',
    'claude',
    '--strict-mcp-config',
    "--mcp-config '{\\\"mcpServers\\\":{}}'",
    '--setting-sources user',
  ].join(' ');

  try {
    // Launch claude in a detached tmux session
    await execAsync(
      `tmux new-session -d -s "${session}" -x 220 -y 60 "${claudeCmd}"`
    );

    // Wait for claude to be ready (look for "for shortcuts" prompt)
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const pane = await execAsync(`tmux capture-pane -t "${session}" -p 2>/dev/null`);
        if (pane.includes('for shortcuts')) {
          ready = true;
          break;
        }
      } catch {
        // tmux session may not be ready yet
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

    // Send /usage command
    await execAsync(`tmux send-keys -t "${session}" "/usage" Enter`);

    // Wait for usage dialog to render
    let usagePane = '';
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        usagePane = await execAsync(`tmux capture-pane -t "${session}" -p 2>/dev/null`);
        if (usagePane.includes('Current session') || usagePane.includes('Extra usage')) {
          break;
        }
      } catch {
        // Retry
      }
    }

    // Capture final pane content
    try {
      usagePane = await execAsync(`tmux capture-pane -t "${session}" -p`);
    } catch {
      // Use last captured content
    }

    // Dismiss dialog and exit cleanly
    try {
      await execAsync(`tmux send-keys -t "${session}" Escape`);
      await execAsync(`tmux send-keys -t "${session}" "/exit" Enter`);
    } catch {
      // Best-effort cleanup
    }

    return parseUsageOutput(usagePane);
  } catch {
    return null;
  } finally {
    // Always kill the tmux session
    try {
      await execAsync(`tmux kill-session -t "${session}" 2>/dev/null`);
    } catch {
      // Session may already be gone
    }
  }
}
