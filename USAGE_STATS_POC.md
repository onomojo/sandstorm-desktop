# Usage Stats Collection: Cross-Platform POC Results

## Problem

The app collects Claude API account usage by injecting `/usage` into a Claude Code interactive session via **tmux** and scraping the TUI output. macOS doesn't ship with tmux, so usage stats silently fail there.

## Current Implementation

File: `src/main/control-plane/account-usage.ts`

1. Spawns a detached tmux session with `claude` CLI
2. Polls `tmux capture-pane` for "for shortcuts" (ready marker)
3. Sends `/usage` via `tmux send-keys`
4. Polls `tmux capture-pane` for "Current session" / "Extra usage"
5. Parses the captured pane text with regex
6. Kills the tmux session

## Candidates Tested

### Option A: `node-pty` — RECOMMENDED

**Result: SUCCESS**

`node-pty` is an npm package that provides pseudo-terminal (PTY) capabilities for Node.js. It's already a dependency in `package.json` (used for the terminal emulator).

#### How it works

```js
const pty = require('node-pty');

// Spawn claude in a PTY (replaces tmux new-session)
const proc = pty.spawn('claude', [
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', 'user',
], {
  name: 'xterm-256color',
  cols: 220,
  rows: 60,
  env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
});

// Listen for output (replaces tmux capture-pane)
let buffer = '';
proc.onData((data) => { buffer += data; });

// Wait for ready marker
// ... poll stripAnsi(buffer) for "for shortcuts" ...

// Inject /usage (replaces tmux send-keys)
proc.write('/usage\r');

// Wait for usage output
// ... poll stripAnsi(buffer) for "Current session" ...

// Parse with existing parseUsageOutput() — no changes needed

// Clean exit
proc.write('\x1b');  // Escape
proc.write('/exit\r');
proc.kill();
```

#### POC test results (mock test)

All checks passed:
- **Spawn process in PTY**: YES
- **Detect ready marker**: YES — detected "for shortcuts" in PTY output
- **Inject /usage command**: YES — `proc.write('/usage\r')` works
- **Capture usage output**: YES — `onData` callback accumulates all output
- **Parse output**: YES — existing `parseUsageOutput()` works after stripping ANSI codes
- **Session: 47%** parsed correctly
- **Week all: 22%** parsed correctly
- **Week Sonnet: 8%** parsed correctly
- **Extra usage: not enabled** parsed correctly

#### Real Claude CLI test

Successfully spawned Claude Code in a PTY and navigated through the first-run setup wizard (theme picker, login method selector) by detecting output markers and injecting keystrokes. OAuth authentication wasn't available in the test container for a separate claude instance, but the mechanism (detect output → inject keystroke → detect response) was proven end-to-end.

#### Advantages

- **Already a dependency** — `node-pty` is in `package.json`, used by the terminal emulator
- **Native Node.js API** — no shell commands, no process orchestration
- **Cross-platform** — works on macOS, Linux, and Windows
- **No external binary** — no tmux, no expect, nothing to install
- **Same rebuild pipeline** — uses the same native module rebuild as better-sqlite3
- **Event-driven** — `onData` callback is cleaner than polling `capture-pane`
- **Direct process control** — `proc.write()` and `proc.kill()` vs shell exec

#### Caveats

- **ANSI stripping required** — PTY output includes escape codes that must be stripped before parsing. The existing parser works as-is on the stripped text.
- **Native module** — requires rebuild for Electron (already handled for better-sqlite3)

### Option B: `expect` — NOT TESTED

`expect` ships with macOS (part of Tcl) but is **not** installed by default on many Linux distributions (including the Docker images used here). This makes it unsuitable as a cross-platform solution — it would fail on Linux the same way tmux fails on macOS.

**Verdict: Rejected** — not reliably cross-platform.

### Option C: `script` + named pipes — NOT RECOMMENDED

**Result: PARTIAL / FRAGILE**

The `script` command is built into both macOS and Linux, but:

1. **Different syntax**: macOS uses `script -q file command`, Linux uses `script -q -c "command" file`
2. **Named pipe complexity**: Requires `mkfifo`, `exec` file descriptor management, background processes — all error-prone in shell
3. **Output encoding**: The `script` output file includes terminal control sequences that are harder to strip than PTY data
4. **Process lifecycle**: Managing the background `script` process, the named pipe, and the child process is fragile
5. **No Node.js integration**: Would need to be called via `child_process.exec`, adding another layer

Testing revealed issues with variable scoping across background processes and unreliable output file creation.

**Verdict: Technically possible but significantly more complex and fragile than node-pty.**

## Recommendation

**Use `node-pty` (Option A).**

It's the clear winner:
- Already a dependency
- Works cross-platform
- Native Node.js API (no shell orchestration)
- Proven end-to-end in POC
- Minimal code change — swap tmux shell commands for `pty.spawn()` / `proc.write()` / `proc.onData()`
- Existing `parseUsageOutput()` works without modification (after ANSI stripping)

## Implementation Plan

1. Replace `fetchAccountUsage()` in `account-usage.ts`:
   - Remove `checkTmuxInstalled()` — replace with `checkNodePtyAvailable()`
   - Replace tmux session spawn with `pty.spawn('claude', ...)`
   - Replace `tmux capture-pane` polling with `onData` buffer accumulation
   - Replace `tmux send-keys` with `proc.write()`
   - Add ANSI stripping before passing to `parseUsageOutput()`
   - Replace `tmux kill-session` cleanup with `proc.kill()`
2. Keep `parseUsageOutput()` and `parseUsageBlock()` unchanged
3. Add tests using the mock Claude CLI pattern from the POC

## POC Files

- `poc-node-pty.cjs` / `poc-node-pty-v2.cjs` — Direct Claude CLI tests (proved mechanism works)
- `poc-mock-claude.cjs` — Mock Claude CLI that simulates `/usage` output
- `poc-node-pty-mock-test.cjs` — End-to-end test: spawn mock in PTY, inject `/usage`, parse output (ALL CHECKS PASSED)
- `poc-script-pipes.sh` / `poc-script-pipes-v2.sh` — script+pipes attempts (fragile)
