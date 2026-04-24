import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getUpdateScriptStatus,
  updateTicketBody,
} from '../../src/main/control-plane/ticket-updater';

/**
 * Mirrors tests/unit/ticket-fetcher.test.ts — same shape, different script.
 * No vi.mock — we install a real stub script in a temp dir and invoke it
 * directly (matches the project's no-electron-mocks pattern).
 */

describe('getUpdateScriptStatus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-status-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns "missing" when update-ticket.sh does not exist', () => {
    expect(getUpdateScriptStatus(tmpDir)).toBe('missing');
  });

  it('returns "not_executable" when script exists but lacks execute permission', () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'update-ticket.sh'), '#!/bin/bash\nexit 0', { mode: 0o644 });
    expect(getUpdateScriptStatus(tmpDir)).toBe('not_executable');
  });

  it('returns "ok" when script exists and is executable', () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'update-ticket.sh'), '#!/bin/bash\nexit 0', { mode: 0o755 });
    expect(getUpdateScriptStatus(tmpDir)).toBe('ok');
  });
});

describe('updateTicketBody', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-body-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function installStubScript(body: string): string {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'update-ticket.sh');
    fs.writeFileSync(scriptPath, body, { mode: 0o755 });
    return scriptPath;
  }

  it('rejects with a clear error when the script is missing', async () => {
    await expect(
      updateTicketBody('42', tmpDir, 'b'),
    ).rejects.toThrow(/update-ticket\.sh is missing/);
  });

  it('rejects with a clear error when the script is not executable', async () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'update-ticket.sh'), '#!/bin/bash', { mode: 0o644 });
    await expect(
      updateTicketBody('42', tmpDir, 'b'),
    ).rejects.toThrow(/not executable/);
  });

  it('rejects when ticketId is empty', async () => {
    installStubScript('#!/bin/bash\nexit 0');
    await expect(updateTicketBody('  ', tmpDir, 'b')).rejects.toThrow(/Ticket ID is required/);
  });

  it('rejects when body is empty', async () => {
    installStubScript('#!/bin/bash\nexit 0');
    await expect(updateTicketBody('1', tmpDir, '   ')).rejects.toThrow(/body cannot be empty/);
  });

  it('passes ticket id and body as positional args to the script', async () => {
    const sideChannel = path.join(tmpDir, 'args');
    installStubScript(
      `#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "${sideChannel}"\nexit 0\n`,
    );
    await updateTicketBody('310', tmpDir, 'refined body');
    const args = fs.readFileSync(sideChannel, 'utf-8').split('\n').filter(Boolean);
    expect(args).toEqual(['310', 'refined body']);
  });

  it('runs the script with cwd set to the project directory', async () => {
    const sideChannel = path.join(tmpDir, 'cwd');
    installStubScript(`#!/usr/bin/env bash\npwd > "${sideChannel}"\nexit 0\n`);
    await updateTicketBody('1', tmpDir, 'b');
    const cwd = fs.readFileSync(sideChannel, 'utf-8').trim();
    // macOS resolves /tmp -> /private/tmp; tolerate either.
    expect(cwd === tmpDir || cwd === fs.realpathSync(tmpDir)).toBe(true);
  });

  it('rejects with the script\'s stderr on failure', async () => {
    installStubScript('#!/usr/bin/env bash\necho "API: 401 Unauthorized" >&2\nexit 1\n');
    await expect(
      updateTicketBody('1', tmpDir, 'b'),
    ).rejects.toThrow(/401 Unauthorized/);
  });

  it('resolves on success without returning a value', async () => {
    installStubScript('#!/usr/bin/env bash\nexit 0');
    await expect(updateTicketBody('1', tmpDir, 'b')).resolves.toBeUndefined();
  });
});
