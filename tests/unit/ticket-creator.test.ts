import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createTicket,
  getCreateTicketScriptStatus,
} from '../../src/main/control-plane/ticket-creator';

/**
 * Mirrors tests/unit/ticket-updater.test.ts — install a real stub script in
 * .sandstorm/scripts/create-ticket.sh inside a temp project dir and invoke
 * it directly. No vi.mock — matches the no-electron-mocks pattern.
 */

describe('getCreateTicketScriptStatus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-status-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns "missing" when create-ticket.sh does not exist', () => {
    expect(getCreateTicketScriptStatus(tmpDir)).toBe('missing');
  });

  it('returns "not_executable" when script exists but lacks execute permission', () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'create-ticket.sh'), '#!/bin/bash\nexit 0', { mode: 0o644 });
    expect(getCreateTicketScriptStatus(tmpDir)).toBe('not_executable');
  });

  it('returns "ok" when script exists and is executable', () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'create-ticket.sh'), '#!/bin/bash\nexit 0', { mode: 0o755 });
    expect(getCreateTicketScriptStatus(tmpDir)).toBe('ok');
  });
});

describe('createTicket', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-ticket-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function installStubScript(body: string): string {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'create-ticket.sh');
    fs.writeFileSync(scriptPath, body, { mode: 0o755 });
    return scriptPath;
  }

  it('rejects when the project directory does not exist', async () => {
    await expect(
      createTicket({ projectDir: '/nope-dir-xyz', title: 't', body: 'b' }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects when title is empty', async () => {
    await expect(
      createTicket({ projectDir: tmpDir, title: '   ', body: 'b' }),
    ).rejects.toThrow(/title is required/);
  });

  it('rejects when body is empty', async () => {
    await expect(
      createTicket({ projectDir: tmpDir, title: 't', body: '' }),
    ).rejects.toThrow(/body is required/);
  });

  it('rejects with a clear error when create-ticket.sh is missing', async () => {
    await expect(
      createTicket({ projectDir: tmpDir, title: 't', body: 'b' }),
    ).rejects.toThrow(/create-ticket\.sh is missing/);
  });

  it('rejects with a clear error when the script is not executable', async () => {
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'create-ticket.sh'), '#!/bin/bash', { mode: 0o644 });
    await expect(
      createTicket({ projectDir: tmpDir, title: 't', body: 'b' }),
    ).rejects.toThrow(/not executable/);
  });

  it('passes title and body as positional args to the script', async () => {
    const sideChannel = path.join(tmpDir, 'args');
    installStubScript(
      `#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "${sideChannel}"\necho "https://github.com/o/r/issues/9"\n`,
    );
    await createTicket({ projectDir: tmpDir, title: 'My Title', body: 'My Body' });
    const args = fs.readFileSync(sideChannel, 'utf-8').split('\n').filter(Boolean);
    expect(args).toEqual(['My Title', 'My Body']);
  });

  it('runs the script with cwd set to the project directory', async () => {
    const sideChannel = path.join(tmpDir, 'cwd');
    installStubScript(
      `#!/usr/bin/env bash\npwd > "${sideChannel}"\necho "https://github.com/o/r/issues/1"\n`,
    );
    await createTicket({ projectDir: tmpDir, title: 't', body: 'b' });
    const cwd = fs.readFileSync(sideChannel, 'utf-8').trim();
    expect(cwd === tmpDir || cwd === fs.realpathSync(tmpDir)).toBe(true);
  });

  it('parses a GitHub issue URL — numeric ticketId from /issues/N', async () => {
    installStubScript(
      '#!/usr/bin/env bash\necho "https://github.com/onomojo/sandstorm-desktop/issues/315"\n',
    );
    const result = await createTicket({ projectDir: tmpDir, title: 'Title', body: 'Body' });
    expect(result.url).toBe('https://github.com/onomojo/sandstorm-desktop/issues/315');
    expect(result.ticketId).toBe('315');
  });

  it('parses a Jira browse URL — alphanumeric key from /browse/PROJ-N', async () => {
    installStubScript(
      '#!/usr/bin/env bash\necho "https://acme.atlassian.net/browse/PROJ-123"\n',
    );
    const result = await createTicket({ projectDir: tmpDir, title: 'Title', body: 'Body' });
    expect(result.url).toBe('https://acme.atlassian.net/browse/PROJ-123');
    expect(result.ticketId).toBe('PROJ-123');
  });

  it('uses the LAST URL-bearing line of stdout — ignores preamble', async () => {
    installStubScript(
      '#!/usr/bin/env bash\n' +
      'echo "Some chatter"\n' +
      'echo "Created issue at the URL below:"\n' +
      'echo "https://acme.atlassian.net/browse/PROJ-77"\n',
    );
    const result = await createTicket({ projectDir: tmpDir, title: 'Title', body: 'Body' });
    expect(result.url).toBe('https://acme.atlassian.net/browse/PROJ-77');
    expect(result.ticketId).toBe('PROJ-77');
  });

  it('strips trailing punctuation that might cling to the URL', async () => {
    installStubScript(
      '#!/usr/bin/env bash\necho "Filed: https://github.com/o/r/issues/42."\n',
    );
    const result = await createTicket({ projectDir: tmpDir, title: 't', body: 'b' });
    expect(result.url).toBe('https://github.com/o/r/issues/42');
    expect(result.ticketId).toBe('42');
  });

  it('rejects when script exits non-zero, surfacing stderr', async () => {
    installStubScript(
      '#!/usr/bin/env bash\necho "auth required" >&2\nexit 1\n',
    );
    await expect(
      createTicket({ projectDir: tmpDir, title: 't', body: 'b' }),
    ).rejects.toThrow(/auth required/);
  });

  it('rejects when stdout has no parseable URL', async () => {
    installStubScript(
      '#!/usr/bin/env bash\necho "draft only — not opened"\n',
    );
    await expect(
      createTicket({ projectDir: tmpDir, title: 't', body: 'b' }),
    ).rejects.toThrow(/Could not parse a ticket URL/);
  });
});
