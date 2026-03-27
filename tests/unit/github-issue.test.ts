import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchIssueContext } from '../../src/main/control-plane/github-issue';
import * as child_process from 'child_process';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(child_process.execFile);

describe('fetchIssueContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns formatted issue with title, body, and comments', async () => {
    const issueData = {
      title: 'Fix auth bug',
      body: 'The auth token expires too early.',
      state: 'OPEN',
      author: { login: 'alice' },
      createdAt: '2026-03-20T10:00:00Z',
      labels: [{ name: 'bug' }],
      comments: [
        {
          author: { login: 'bob' },
          body: 'I can reproduce this on staging.',
          createdAt: '2026-03-21T14:00:00Z',
        },
        {
          author: { login: 'alice' },
          body: 'Actually the issue is in the refresh logic, not the expiry.',
          createdAt: '2026-03-22T09:00:00Z',
        },
      ],
    };

    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, JSON.stringify(issueData));
      return {} as any;
    });

    const result = await fetchIssueContext('42', '/some/project');

    expect(result).toContain('# Issue: Fix auth bug');
    expect(result).toContain('The auth token expires too early.');
    expect(result).toContain('Labels: bug');
    expect(result).toContain('State: OPEN');
    expect(result).toContain('Author: @alice');
    expect(result).toContain('## Comments');
    expect(result).toContain('### @bob — 2026-03-21T14:00:00Z');
    expect(result).toContain('I can reproduce this on staging.');
    expect(result).toContain('### @alice — 2026-03-22T09:00:00Z');
    expect(result).toContain('Actually the issue is in the refresh logic');
  });

  it('returns formatted issue without comments section when there are none', async () => {
    const issueData = {
      title: 'Add search feature',
      body: 'We need search.',
      state: 'OPEN',
      author: { login: 'alice' },
      createdAt: '2026-03-20T10:00:00Z',
      labels: [],
      comments: [],
    };

    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, JSON.stringify(issueData));
      return {} as any;
    });

    const result = await fetchIssueContext('10', '/some/project');

    expect(result).toContain('# Issue: Add search feature');
    expect(result).toContain('We need search.');
    expect(result).not.toContain('## Comments');
  });

  it('returns null when gh CLI fails', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('gh not found'));
      return {} as any;
    });

    const result = await fetchIssueContext('42', '/some/project');
    expect(result).toBeNull();
  });

  it('returns null when gh returns invalid JSON', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, 'not json');
      return {} as any;
    });

    const result = await fetchIssueContext('42', '/some/project');
    expect(result).toBeNull();
  });

  it('passes the correct arguments to gh CLI', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, JSON.stringify({
        title: 'Test', body: '', state: 'OPEN',
        author: { login: 'x' }, createdAt: '', labels: [], comments: [],
      }));
      return {} as any;
    });

    await fetchIssueContext('123', '/my/project');

    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'view', '123', '--json', 'title,body,state,author,comments,labels,createdAt'],
      { cwd: '/my/project', timeout: 15000 },
      expect.any(Function)
    );
  });
});
