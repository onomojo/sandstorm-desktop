import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchTicketContext, referencesTicket, getScriptStatus } from '../../src/main/control-plane/ticket-fetcher';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(child_process.execFile);

describe('referencesTicket', () => {
  it('detects standalone GitHub issue references like #123', () => {
    expect(referencesTicket('Fix #123')).toBe(true);
    expect(referencesTicket('#42 needs work')).toBe(true);
    expect(referencesTicket('See issue #99 for details')).toBe(true);
  });

  it('detects owner/repo#123 references', () => {
    expect(referencesTicket('See onomojo/sandstorm#27')).toBe(true);
  });

  it('detects GitHub issue URLs', () => {
    expect(referencesTicket('https://github.com/onomojo/sandstorm/issues/27')).toBe(true);
  });

  it('detects Jira-style ticket references (PROJ-123)', () => {
    expect(referencesTicket('Fix PROJ-123')).toBe(true);
    expect(referencesTicket('SAND-42 is blocking')).toBe(true);
    expect(referencesTicket('See ABC-1 for details')).toBe(true);
  });

  it('detects Linear-style URLs', () => {
    expect(referencesTicket('https://linear.app/myteam/issue/ABC-123')).toBe(true);
  });

  it('returns false for plain text without ticket references', () => {
    expect(referencesTicket('Fix the auth bug')).toBe(false);
    expect(referencesTicket('Refactor the login flow')).toBe(false);
  });

  it('returns false for hash in non-issue contexts', () => {
    expect(referencesTicket('color: #fff')).toBe(false);
  });

  it('does not match single uppercase letter followed by dash and digits', () => {
    // Jira requires at least 2 uppercase letters
    expect(referencesTicket('See A-123')).toBe(false);
  });
});

describe('getScriptStatus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-status-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns "missing" when fetch-ticket.sh does not exist', () => {
    expect(getScriptStatus(tmpDir)).toBe('missing');
  });

  it('returns "not_executable" when script exists but lacks execute permission', () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'fetch-ticket.sh'), '#!/bin/bash\necho hi', { mode: 0o644 });
    expect(getScriptStatus(tmpDir)).toBe('not_executable');
  });

  it('returns "ok" when script exists and is executable', () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'fetch-ticket.sh'), '#!/bin/bash\necho hi', { mode: 0o755 });
    expect(getScriptStatus(tmpDir)).toBe('ok');
  });
});

describe('fetchTicketContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-fetcher-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null and warns when fetch-ticket.sh does not exist', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchTicketContext('42', tmpDir);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No fetch-ticket script found')
    );

    warnSpy.mockRestore();
  });

  it('returns null and warns when fetch-ticket.sh is not executable', async () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'fetch-ticket.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho "test"', { mode: 0o644 });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchTicketContext('42', tmpDir);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('not executable')
    );

    warnSpy.mockRestore();
  });

  it('returns script stdout when fetch-ticket.sh succeeds', async () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'fetch-ticket.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho "test"', { mode: 0o755 });

    const expectedOutput = '# Issue: Fix auth bug\n\nState: OPEN\n';

    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, expectedOutput, '');
      return {} as any;
    });

    const result = await fetchTicketContext('42', tmpDir);

    expect(result).toBe(expectedOutput);
  });

  it('passes ticket ID as argument to the script', async () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'fetch-ticket.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho "test"', { mode: 0o755 });

    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, 'output', '');
      return {} as any;
    });

    await fetchTicketContext('PROJ-123', tmpDir);

    expect(mockExecFile).toHaveBeenCalledWith(
      scriptPath,
      ['PROJ-123'],
      { cwd: tmpDir, timeout: 30000 },
      expect.any(Function)
    );
  });

  it('returns null when script fails', async () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'fetch-ticket.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho "test"', { mode: 0o755 });

    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('Script failed'), '', 'Error: gh not found');
      return {} as any;
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchTicketContext('42', tmpDir);

    expect(result).toBeNull();

    warnSpy.mockRestore();
  });
});
