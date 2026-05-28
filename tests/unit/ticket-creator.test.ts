import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'child_process';
import { createTicketWithConfig } from '../../src/main/control-plane/ticket-config';
import type { ProjectTicketConfig } from '../../src/main/control-plane/registry';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(child_process.execFile);

const GITHUB_CONFIG: ProjectTicketConfig = { provider: 'github' };

function mockSuccess(stdout: string) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(null, stdout, '');
    return {} as ReturnType<typeof child_process.execFile>;
  });
}

function mockFailure(stderr: string) {
  const err = Object.assign(new Error('cmd failed'), { stderr });
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(err, '', stderr);
    return {} as ReturnType<typeof child_process.execFile>;
  });
}

describe('createTicketWithConfig — validation', () => {
  it('rejects when title is empty', async () => {
    await expect(createTicketWithConfig({ title: '  ', body: 'b', config: GITHUB_CONFIG, cwd: '/proj' })).rejects.toThrow(/title is required/);
  });

  it('rejects when body is empty', async () => {
    await expect(createTicketWithConfig({ title: 't', body: '', config: GITHUB_CONFIG, cwd: '/proj' })).rejects.toThrow(/body is required/);
  });
});

describe('createTicketWithConfig — GitHub provider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls gh issue create with title and body', async () => {
    mockSuccess('https://github.com/onomojo/sandstorm-desktop/issues/315\n');
    await createTicketWithConfig({ title: 'My Title', body: 'My Body', config: GITHUB_CONFIG, cwd: '/myproj' });
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--title', 'My Title', '--body', 'My Body'],
      expect.objectContaining({ cwd: '/myproj' }),
      expect.any(Function)
    );
  });

  it('parses a GitHub issue URL — numeric ticketId from /issues/N', async () => {
    mockSuccess('https://github.com/onomojo/sandstorm-desktop/issues/315\n');
    const result = await createTicketWithConfig({ title: 'T', body: 'B', config: GITHUB_CONFIG, cwd: '/proj' });
    expect(result.url).toBe('https://github.com/onomojo/sandstorm-desktop/issues/315');
    expect(result.ticketId).toBe('315');
  });

  it('strips trailing punctuation from URL', async () => {
    mockSuccess('Filed: https://github.com/o/r/issues/42.\n');
    const result = await createTicketWithConfig({ title: 't', body: 'b', config: GITHUB_CONFIG, cwd: '/proj' });
    expect(result.url).toBe('https://github.com/o/r/issues/42');
    expect(result.ticketId).toBe('42');
  });

  it('rejects when script exits non-zero, surfacing stderr', async () => {
    mockFailure('auth required');
    await expect(
      createTicketWithConfig({ title: 't', body: 'b', config: GITHUB_CONFIG, cwd: '/proj' })
    ).rejects.toThrow(/auth required/);
  });

  it('rejects when stdout has no parseable URL', async () => {
    mockSuccess('draft only — not opened\n');
    await expect(
      createTicketWithConfig({ title: 't', body: 'b', config: GITHUB_CONFIG, cwd: '/proj' })
    ).rejects.toThrow(/Could not parse a ticket URL/);
  });
});
