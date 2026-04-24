import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  detectTicketProvider,
  installUpdateScript,
  templateScriptPath,
} from '../../src/main/control-plane/ticket-provider';

describe('detectTicketProvider', () => {
  let tmpDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-detect-'));
    originalPath = process.env.PATH;
    // Prepend an empty bin dir so individual tests can shadow `gh` with a
    // pass/fail stub. Keep the rest of PATH so `git` (called via spawnSync
    // by detectTicketProvider) still works in the test environment.
    const stubBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(stubBin, { recursive: true });
    process.env.PATH = `${stubBin}:${process.env.PATH ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGhStub(script: string): void {
    const binDir = path.join(tmpDir, 'bin');
    const ghPath = path.join(binDir, 'gh');
    fs.writeFileSync(ghPath, script, { mode: 0o755 });
  }

  function stubGhAvailable(): void {
    writeGhStub('#!/usr/bin/env bash\necho "gh version 2.0.0"\nexit 0\n');
  }

  function stubGhUnavailable(): void {
    // Shadow the host's gh (if any) with a stub that fails — same effect
    // as not having gh installed at all, but deterministic on any machine.
    writeGhStub('#!/usr/bin/env bash\nexit 127\n');
  }

  function initGitRepoWithRemote(remoteUrl: string): void {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: tmpDir });
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: tmpDir });
  }

  it('returns "jira" when .mcp.json contains atlassian config', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { atlassian: { command: 'mcp-atlassian' } } }),
    );
    expect(detectTicketProvider(tmpDir)).toBe('jira');
  });

  it('does NOT return "jira" when .mcp.json mentions atlassian only in unrelated text', () => {
    // The bash detector greps for `"atlassian"` (with quotes), so an unquoted
    // mention shouldn't trigger it. But our TS port uses includes('"atlassian"')
    // — verify it still requires quotes.
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '// comment about atlassian without quotes');
    expect(detectTicketProvider(tmpDir)).not.toBe('jira');
  });

  it('returns "github" when gh is on PATH and remote points to github.com', () => {
    stubGhAvailable();
    initGitRepoWithRemote('git@github.com:owner/repo.git');
    expect(detectTicketProvider(tmpDir)).toBe('github');
  });

  it('returns "skeleton" when gh is on PATH but the remote is not GitHub', () => {
    stubGhAvailable();
    initGitRepoWithRemote('git@gitlab.com:owner/repo.git');
    expect(detectTicketProvider(tmpDir)).toBe('skeleton');
  });

  it('returns "skeleton" when there is no gh binary', () => {
    stubGhUnavailable();
    initGitRepoWithRemote('git@github.com:owner/repo.git');
    expect(detectTicketProvider(tmpDir)).toBe('skeleton');
  });

  it('returns "skeleton" when the project is not a git repo', () => {
    stubGhAvailable();
    expect(detectTicketProvider(tmpDir)).toBe('skeleton');
  });

  it('jira detection wins over github when both signals exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { atlassian: { command: 'mcp-atlassian' } } }),
    );
    stubGhAvailable();
    initGitRepoWithRemote('git@github.com:owner/repo.git');
    expect(detectTicketProvider(tmpDir)).toBe('jira');
  });
});

describe('templateScriptPath', () => {
  it('joins cliDir + templates + provider + scripts + script-name', () => {
    expect(templateScriptPath('/cli', 'github', 'update-ticket.sh')).toBe(
      '/cli/templates/github/scripts/update-ticket.sh',
    );
    expect(templateScriptPath('/cli', 'jira', 'fetch-ticket.sh')).toBe(
      '/cli/templates/jira/scripts/fetch-ticket.sh',
    );
    expect(templateScriptPath('/cli', 'skeleton', 'update-ticket.sh')).toBe(
      '/cli/templates/skeleton/scripts/update-ticket.sh',
    );
  });
});

describe('installUpdateScript', () => {
  let tmpDir: string;
  let cliDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-update-'));
    cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(cliDir, { recursive: true, force: true });
  });

  function makeTemplate(provider: string, contents: string): void {
    const dir = path.join(cliDir, 'templates', provider, 'scripts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'update-ticket.sh'), contents);
  }

  it('throws when the template does not exist', () => {
    expect(() =>
      installUpdateScript({ projectDir: tmpDir, cliDir, provider: 'github' }),
    ).toThrow(/template not found/);
  });

  it('copies the github template into .sandstorm/scripts/update-ticket.sh and chmods +x', () => {
    makeTemplate('github', '#!/usr/bin/env bash\ngh issue edit\n');
    const dest = installUpdateScript({ projectDir: tmpDir, cliDir, provider: 'github' });
    expect(dest).toBe(path.join(tmpDir, '.sandstorm', 'scripts', 'update-ticket.sh'));
    expect(fs.readFileSync(dest, 'utf-8')).toContain('gh issue edit');
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(dest).mode & 0o111).not.toBe(0);
  });

  it('overwrites an existing script', () => {
    makeTemplate('github', '#!/usr/bin/env bash\nNEW\n');
    const scriptsDir = path.join(tmpDir, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'update-ticket.sh'), '#!/usr/bin/env bash\nOLD\n');
    installUpdateScript({ projectDir: tmpDir, cliDir, provider: 'github' });
    expect(fs.readFileSync(path.join(scriptsDir, 'update-ticket.sh'), 'utf-8')).toContain('NEW');
  });

  it('creates .sandstorm/scripts/ if it does not exist', () => {
    makeTemplate('jira', '#!/usr/bin/env bash');
    expect(fs.existsSync(path.join(tmpDir, '.sandstorm'))).toBe(false);
    installUpdateScript({ projectDir: tmpDir, cliDir, provider: 'jira' });
    expect(fs.existsSync(path.join(tmpDir, '.sandstorm', 'scripts', 'update-ticket.sh'))).toBe(true);
  });
});
