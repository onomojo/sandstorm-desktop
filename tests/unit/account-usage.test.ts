/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseUsageOutput, parseUsageBlock, resetClaudeCheck, stripAnsi } from '../../src/main/control-plane/account-usage';

// ---------------------------------------------------------------------------
// Parser tests — these don't need mocks, they just test string parsing
// ---------------------------------------------------------------------------

const SAMPLE_PANE = `
  ╭─────────────────────────────────────────────────────────────────────────╮
  │                                                                         │
  │ Current session                                                         │
  │   ███████████████████████▌                           47% used           │
  │   Resets 6pm (America/New_York)                                        │
  │                                                                         │
  │ Current week (all models)                                               │
  │   ███████                                            14% used           │
  │   Resets Apr 10, 10am (America/New_York)                               │
  │                                                                         │
  │ Current week (Sonnet only)                                              │
  │   █                                                  2% used            │
  │   Resets Apr 13, 7pm (America/New_York)                                │
  │                                                                         │
  │ Extra usage                                                             │
  │   Extra usage not enabled · /extra-usage to enable                     │
  │                                                                         │
  ╰─────────────────────────────────────────────────────────────────────────╯
`;

const EXTRA_USAGE_ENABLED_PANE = `
  Current session
    ███████████████████████████████████████████████████  99% used
    Resets 8pm (America/New_York)

  Extra usage
    Enabled · /extra-usage to disable
`;

const RATE_LIMITED_PANE = `
  You are being rate limited. Please try again in a few minutes.
`;

const AUTH_EXPIRED_PANE = `
  Your session has expired. Please authenticate again.
`;

const EMPTY_PANE = `
  Welcome to Claude Code! Press ? for shortcuts.
`;

describe('account-usage parser', () => {
  beforeEach(() => {
    resetClaudeCheck();
  });

  describe('parseUsageBlock', () => {
    it('parses session block from sample pane', () => {
      const block = parseUsageBlock(SAMPLE_PANE, 'Current session');
      expect(block).not.toBeNull();
      expect(block!.percent).toBe(47);
      expect(block!.resetsAt).toBe('6pm (America/New_York)');
    });

    it('parses week (all models) block', () => {
      const block = parseUsageBlock(SAMPLE_PANE, 'Current week \\(all models\\)');
      expect(block).not.toBeNull();
      expect(block!.percent).toBe(14);
      expect(block!.resetsAt).toBe('Apr 10, 10am (America/New_York)');
    });

    it('parses week (Sonnet only) block', () => {
      const block = parseUsageBlock(SAMPLE_PANE, 'Current week \\(Sonnet only\\)');
      expect(block).not.toBeNull();
      expect(block!.percent).toBe(2);
      expect(block!.resetsAt).toBe('Apr 13, 7pm (America/New_York)');
    });

    it('returns null for non-existent label', () => {
      const block = parseUsageBlock(SAMPLE_PANE, 'Nonexistent block');
      expect(block).toBeNull();
    });

    it('parses 99% usage', () => {
      const block = parseUsageBlock(EXTRA_USAGE_ENABLED_PANE, 'Current session');
      expect(block).not.toBeNull();
      expect(block!.percent).toBe(99);
    });
  });

  describe('parseUsageOutput', () => {
    it('parses a normal usage pane into a complete snapshot', () => {
      const snapshot = parseUsageOutput(SAMPLE_PANE);
      expect(snapshot.status).toBe('ok');
      expect(snapshot.session).not.toBeNull();
      expect(snapshot.session!.percent).toBe(47);
      expect(snapshot.session!.resetsAt).toBe('6pm (America/New_York)');
      expect(snapshot.weekAll).not.toBeNull();
      expect(snapshot.weekAll!.percent).toBe(14);
      expect(snapshot.weekSonnet).not.toBeNull();
      expect(snapshot.weekSonnet!.percent).toBe(2);
      expect(snapshot.extraUsage.enabled).toBe(false);
      expect(snapshot.capturedAt).toBeDefined();
    });

    it('detects extra usage enabled', () => {
      const snapshot = parseUsageOutput(EXTRA_USAGE_ENABLED_PANE);
      expect(snapshot.extraUsage.enabled).toBe(true);
    });

    it('sets status to at_limit when session >= 95%', () => {
      const snapshot = parseUsageOutput(EXTRA_USAGE_ENABLED_PANE);
      expect(snapshot.status).toBe('at_limit');
    });

    it('detects rate-limited pane', () => {
      const snapshot = parseUsageOutput(RATE_LIMITED_PANE);
      expect(snapshot.status).toBe('rate_limited');
      expect(snapshot.session).toBeNull();
    });

    it('detects auth expired pane', () => {
      const snapshot = parseUsageOutput(AUTH_EXPIRED_PANE);
      expect(snapshot.status).toBe('auth_expired');
      expect(snapshot.session).toBeNull();
    });

    it('returns parse_error for unrecognized pane', () => {
      const snapshot = parseUsageOutput(EMPTY_PANE);
      expect(snapshot.status).toBe('parse_error');
      expect(snapshot.session).toBeNull();
    });

    it('handles completely empty string', () => {
      const snapshot = parseUsageOutput('');
      expect(snapshot.status).toBe('parse_error');
      expect(snapshot.session).toBeNull();
    });

    it('handles pane with only session block (no week blocks)', () => {
      const pane = `
        Current session
          ██████████                                         20% used
          Resets 3pm (America/Chicago)

        Extra usage
          Extra usage not enabled
      `;
      const snapshot = parseUsageOutput(pane);
      expect(snapshot.status).toBe('ok');
      expect(snapshot.session!.percent).toBe(20);
      expect(snapshot.weekAll).toBeNull();
      expect(snapshot.weekSonnet).toBeNull();
    });

    it('handles 0% usage', () => {
      const pane = `
        Current session
                                                             0% used
          Resets 6pm (America/New_York)

        Extra usage
          Extra usage not enabled
      `;
      const snapshot = parseUsageOutput(pane);
      expect(snapshot.status).toBe('ok');
      expect(snapshot.session!.percent).toBe(0);
    });

    it('handles 100% usage', () => {
      const pane = `
        Current session
          ██████████████████████████████████████████████████ 100% used
          Resets 6pm (America/New_York)

        Extra usage
          Extra usage not enabled
      `;
      const snapshot = parseUsageOutput(pane);
      expect(snapshot.status).toBe('at_limit');
      expect(snapshot.session!.percent).toBe(100);
    });

    it('detects rate-limit keywords in various forms', () => {
      expect(parseUsageOutput('rate limit exceeded').status).toBe('rate_limited');
      expect(parseUsageOutput('Too many requests, try again later').status).toBe('rate_limited');
      expect(parseUsageOutput('You are requesting too frequently').status).toBe('rate_limited');
    });
  });

  describe('stripAnsi', () => {
    it('strips color codes', () => {
      const input = '\x1b[38;5;231mHello\x1b[0m World';
      expect(stripAnsi(input)).toBe('Hello World');
    });

    it('strips cursor movement codes', () => {
      const input = '\x1b[1AHello\x1b[2B World';
      expect(stripAnsi(input)).toBe('Hello World');
    });

    it('replaces cursor-forward (CSI <n> C) with spaces to preserve word boundaries', () => {
      // cursor-forward moves the cursor right without overwriting — equivalent to spaces
      const input = 'Hello\x1b[5CWorld';
      expect(stripAnsi(input)).toBe('Hello     World');
    });

    it('handles cursor-forward with single character move', () => {
      const input = 'A\x1b[1CB';
      expect(stripAnsi(input)).toBe('A B');
    });

    it('strips OSC sequences', () => {
      const input = '\x1b]0;title\x07Hello';
      expect(stripAnsi(input)).toBe('Hello');
    });

    it('strips charset switching', () => {
      const input = '\x1b(BHello\x1b)0 World';
      expect(stripAnsi(input)).toBe('Hello World');
    });

    it('strips control characters but keeps newlines and tabs', () => {
      const input = 'Hello\x01\x02\nWorld\t!';
      expect(stripAnsi(input)).toBe('Hello\nWorld\t!');
    });

    it('returns empty string for empty input', () => {
      expect(stripAnsi('')).toBe('');
    });

    it('returns plain text unchanged', () => {
      expect(stripAnsi('plain text')).toBe('plain text');
    });

    it('handles private mode sequences like ?2026l', () => {
      const input = '\x1b[?2026lHello';
      expect(stripAnsi(input)).toBe('Hello');
    });
  });

  describe('parsing ANSI-stripped PTY output', () => {
    it('parses usage from stripped PTY output (simulating node-pty)', () => {
      // Simulate what node-pty output looks like after ANSI stripping
      const rawPtyOutput = `\x1b[38;5;231mCurrent session\x1b[0m
\x1b[38;5;70m  ███████████████████████▌\x1b[0m                 47% used
  Resets 6pm (America/New_York)

\x1b[38;5;231mExtra usage not enabled\x1b[0m`;
      const stripped = stripAnsi(rawPtyOutput);
      const snapshot = parseUsageOutput(stripped);
      expect(snapshot.status).toBe('ok');
      expect(snapshot.session!.percent).toBe(47);
      expect(snapshot.session!.resetsAt).toBe('6pm (America/New_York)');
      expect(snapshot.extraUsage.enabled).toBe(false);
    });

    it('parses PTY output with \\r line endings (real TUI dialog format)', () => {
      // Real PTY output uses \r line breaks within TUI dialogs, not \n.
      // stripAnsi normalizes \r → \n so the parser works.
      const rawPty = [
        'Current session    ',
        '  ███████████████████████████████████                70% used',
        '  Resets 6pm (UTC)',
        '  Current week (all models)',
        '  █▌                                                 3% used',
        '  Resets Apr 17, 2pm (UTC)',
        '  Current week (Sonnet only)',
        '  ███████                                            14% used',
        '  Resets Apr 13, 11pm (UTC)',
        '  Extra usage',
        '  Extra usage not enabled',
      ].join('\r');
      const stripped = stripAnsi(rawPty);
      const snapshot = parseUsageOutput(stripped);
      expect(snapshot.status).toBe('ok');
      expect(snapshot.session!.percent).toBe(70);
      expect(snapshot.session!.resetsAt).toBe('6pm (UTC)');
      expect(snapshot.weekAll!.percent).toBe(3);
      expect(snapshot.weekSonnet!.percent).toBe(14);
      expect(snapshot.extraUsage.enabled).toBe(false);
    });

    it('parses PTY output where Resets has cursor artifacts (e.g. "Rese s")', () => {
      // PTY cursor-forward codes can split "Resets" into "Rese s" or similar
      const output = [
        'Current session',
        '  ██████████████████  47% used',
        '  Rese s 6pm (America/New_York)',
        '',
        '  Extra usage not enabled',
      ].join('\n');
      const snapshot = parseUsageOutput(output);
      expect(snapshot.status).toBe('ok');
      expect(snapshot.session!.percent).toBe(47);
      expect(snapshot.session!.resetsAt).toBe('6pm (America/New_York)');
    });

    it('parses full dialog from stripped PTY output', () => {
      const stripped = `
╭─────────────────────────────────────────────────╮
│ Current session                                 │
│   ███████████████████████▌            47% used  │
│   Resets 6pm (America/New_York)                 │
│                                                 │
│ Current week (all models)                       │
│   ██████████▌                         22% used  │
│   Resets Monday 12am (America/New_York)         │
│                                                 │
│ Current week (Sonnet only)                      │
│   ████▌                                8% used  │
│   Resets Monday 12am (America/New_York)         │
│                                                 │
│ Extra usage not enabled                         │
╰─────────────────────────────────────────────────╯
`;
      const snapshot = parseUsageOutput(stripped);
      expect(snapshot.status).toBe('ok');
      expect(snapshot.session!.percent).toBe(47);
      expect(snapshot.weekAll!.percent).toBe(22);
      expect(snapshot.weekSonnet!.percent).toBe(8);
      expect(snapshot.extraUsage.enabled).toBe(false);
    });
  });
});
