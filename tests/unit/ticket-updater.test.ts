import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'child_process';
import { updateTicketWithConfig } from '../../src/main/control-plane/ticket-config';
import type { ProjectTicketConfig } from '../../src/main/control-plane/registry';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(child_process.execFile);

const GITHUB_CONFIG: ProjectTicketConfig = { provider: 'github' };

describe('updateTicketWithConfig — validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when ticketId is empty', async () => {
    await expect(updateTicketWithConfig('  ', 'body', GITHUB_CONFIG, '/proj')).rejects.toThrow(/Ticket ID is required/);
  });

  it('rejects when body is empty', async () => {
    await expect(updateTicketWithConfig('1', '   ', GITHUB_CONFIG, '/proj')).rejects.toThrow(/body cannot be empty/);
  });
});

describe('updateTicketWithConfig — GitHub provider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls gh issue edit with ticket id and body', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, '', '');
      return {} as ReturnType<typeof child_process.execFile>;
    });
    await updateTicketWithConfig('310', 'refined body', GITHUB_CONFIG, '/proj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '310', '--body', 'refined body'],
      expect.objectContaining({ cwd: '/proj' }),
      expect.any(Function)
    );
  });

  it('rejects with the stderr message on failure', async () => {
    const err = Object.assign(new Error('cmd failed'), { stderr: 'API: 401 Unauthorized' });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(err, '', 'API: 401 Unauthorized');
      return {} as ReturnType<typeof child_process.execFile>;
    });
    await expect(updateTicketWithConfig('1', 'body', GITHUB_CONFIG, '/proj')).rejects.toThrow(/401 Unauthorized/);
  });

  it('resolves on success without returning a value', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, '', '');
      return {} as ReturnType<typeof child_process.execFile>;
    });
    await expect(updateTicketWithConfig('1', 'body', GITHUB_CONFIG, '/proj')).resolves.toBeUndefined();
  });
});
