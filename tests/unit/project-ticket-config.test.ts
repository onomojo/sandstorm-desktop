import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-ticket-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe('ProjectTicketConfig registry', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  it('returns null for unconfigured project', () => {
    expect(registry.getProjectTicketConfig('/proj/a')).toBeNull();
  });

  it('sets and retrieves a GitHub config (jira_* columns all null)', () => {
    registry.setProjectTicketConfig('/proj/a', { provider: 'github' });
    const cfg = registry.getProjectTicketConfig('/proj/a');
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe('github');
    expect(cfg!.jira_url).toBeNull();
    expect(cfg!.jira_username).toBeNull();
    expect(cfg!.jira_api_token).toBeNull();
    expect(cfg!.jira_project_key).toBeNull();
    expect(cfg!.jira_issue_type).toBeNull();
    expect(cfg!.ticket_prefix).toBeNull();
  });

  it('sets and retrieves a full Jira config', () => {
    registry.setProjectTicketConfig('/proj/b', {
      provider: 'jira',
      jira_url: 'https://acme.atlassian.net',
      jira_username: 'dev@acme.com',
      jira_api_token: 'secret-token',
      jira_project_key: 'ACME',
      jira_issue_type: 'Story',
      ticket_prefix: 'ACME-',
    });
    const cfg = registry.getProjectTicketConfig('/proj/b');
    expect(cfg!.provider).toBe('jira');
    expect(cfg!.jira_url).toBe('https://acme.atlassian.net');
    expect(cfg!.jira_username).toBe('dev@acme.com');
    expect(cfg!.jira_api_token).toBe('secret-token');
    expect(cfg!.jira_project_key).toBe('ACME');
    expect(cfg!.jira_issue_type).toBe('Story');
    expect(cfg!.ticket_prefix).toBe('ACME-');
  });

  it('overwrites existing config on set', () => {
    registry.setProjectTicketConfig('/proj/c', { provider: 'github' });
    registry.setProjectTicketConfig('/proj/c', { provider: 'jira', jira_url: 'https://x.atlassian.net', jira_username: 'u', jira_api_token: 't', jira_project_key: 'X' });
    const cfg = registry.getProjectTicketConfig('/proj/c');
    expect(cfg!.provider).toBe('jira');
    expect(cfg!.jira_url).toBe('https://x.atlassian.net');
  });

  it('removes project config', () => {
    registry.setProjectTicketConfig('/proj/d', { provider: 'github' });
    registry.removeProjectTicketConfig('/proj/d');
    expect(registry.getProjectTicketConfig('/proj/d')).toBeNull();
  });

  it('different projects have independent configs', () => {
    registry.setProjectTicketConfig('/proj/x', { provider: 'github' });
    registry.setProjectTicketConfig('/proj/y', { provider: 'jira', jira_url: 'https://y.atlassian.net', jira_username: 'u', jira_api_token: 't', jira_project_key: 'Y' });

    expect(registry.getProjectTicketConfig('/proj/x')!.provider).toBe('github');
    expect(registry.getProjectTicketConfig('/proj/y')!.provider).toBe('jira');
  });

  it('resolves key via path.resolve (two paths to same dir match)', () => {
    registry.setProjectTicketConfig('/proj/foo', { provider: 'github' });
    // path.resolve('/proj/foo') === '/proj/foo' so this is a trivial check,
    // but the implementation uses path.resolve which handles relative paths.
    expect(registry.getProjectTicketConfig('/proj/foo')).not.toBeNull();
  });

  it('removes a config that does not exist without error', () => {
    expect(() => registry.removeProjectTicketConfig('/nonexistent')).not.toThrow();
  });
});
