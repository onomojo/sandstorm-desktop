import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseIssueUrl, formatIssueForPrompt, fetchGitHubIssue, fetchIssueContext, GitHubIssue } from '../../src/main/control-plane/github-issue';
import { execFile } from 'child_process';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

describe('parseIssueUrl', () => {
  it('parses a full GitHub issue URL', () => {
    const result = parseIssueUrl('https://github.com/onomojo/sandstorm/issues/111');
    expect(result).toEqual({ owner: 'onomojo', repo: 'sandstorm', number: 111 });
  });

  it('parses a URL without https://', () => {
    const result = parseIssueUrl('github.com/owner/repo/issues/42');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 42 });
  });

  it('parses a URL with http://', () => {
    const result = parseIssueUrl('http://github.com/owner/repo/issues/7');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 7 });
  });

  it('returns null for non-issue URLs', () => {
    expect(parseIssueUrl('https://github.com/owner/repo/pulls/5')).toBeNull();
    expect(parseIssueUrl('https://gitlab.com/owner/repo/issues/5')).toBeNull();
    expect(parseIssueUrl('not a url')).toBeNull();
    expect(parseIssueUrl('')).toBeNull();
  });

  it('returns null for issue URL without a number', () => {
    expect(parseIssueUrl('https://github.com/owner/repo/issues/')).toBeNull();
  });
});

describe('formatIssueForPrompt', () => {
  const baseIssue: GitHubIssue = {
    title: 'Fix login bug',
    body: 'Login fails when password contains special characters.',
    state: 'OPEN',
    author: 'testuser',
    createdAt: '2026-03-20T10:00:00Z',
    labels: ['bug', 'auth'],
    comments: [],
  };

  it('formats an issue with no comments', () => {
    const result = formatIssueForPrompt(baseIssue);
    expect(result).toContain('## GitHub Issue: Fix login bug');
    expect(result).toContain('**State:** OPEN');
    expect(result).toContain('@testuser');
    expect(result).toContain('**Labels:** bug, auth');
    expect(result).toContain('Login fails when password contains special characters.');
    expect(result).not.toContain('### Comments');
  });

  it('formats an issue with comments', () => {
    const issue: GitHubIssue = {
      ...baseIssue,
      comments: [
        { author: 'reviewer', body: 'Can you add a test for this?', createdAt: '2026-03-21T09:00:00Z' },
        { author: 'testuser', body: 'Done, added regression test.', createdAt: '2026-03-21T10:00:00Z' },
      ],
    };
    const result = formatIssueForPrompt(issue);
    expect(result).toContain('### Comments (2)');
    expect(result).toContain('**@reviewer** on 2026-03-21T09:00:00Z:');
    expect(result).toContain('Can you add a test for this?');
    expect(result).toContain('**@testuser** on 2026-03-21T10:00:00Z:');
    expect(result).toContain('Done, added regression test.');
  });

  it('handles empty body', () => {
    const issue: GitHubIssue = { ...baseIssue, body: '' };
    const result = formatIssueForPrompt(issue);
    expect(result).toContain('(no description)');
  });

  it('handles no labels', () => {
    const issue: GitHubIssue = { ...baseIssue, labels: [] };
    const result = formatIssueForPrompt(issue);
    expect(result).not.toContain('**Labels:**');
  });
});

describe('fetchGitHubIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and parses issue JSON from gh CLI', async () => {
    const ghResponse = JSON.stringify({
      title: 'Test issue',
      body: 'Issue body',
      state: 'OPEN',
      author: { login: 'octocat' },
      createdAt: '2026-03-20T10:00:00Z',
      labels: [{ name: 'bug' }],
      comments: [
        {
          author: { login: 'commenter' },
          body: 'A comment',
          createdAt: '2026-03-21T12:00:00Z',
        },
      ],
    });

    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, ghResponse, '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await fetchGitHubIssue('owner', 'repo', 42);
    expect(result).toEqual({
      title: 'Test issue',
      body: 'Issue body',
      state: 'OPEN',
      author: 'octocat',
      createdAt: '2026-03-20T10:00:00Z',
      labels: ['bug'],
      comments: [
        { author: 'commenter', body: 'A comment', createdAt: '2026-03-21T12:00:00Z' },
      ],
    });

    expect(mockedExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'view', '42', '--repo', 'owner/repo', '--json', 'title,body,state,author,comments,labels,createdAt'],
      { timeout: 30000 },
      expect.any(Function),
    );
  });

  it('returns null when gh CLI fails', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('gh not found'), '', 'command not found: gh');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await fetchGitHubIssue('owner', 'repo', 1);
    expect(result).toBeNull();
  });

  it('returns null when JSON is invalid', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, 'not json', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await fetchGitHubIssue('owner', 'repo', 1);
    expect(result).toBeNull();
  });
});

describe('fetchIssueContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for non-GitHub URLs', async () => {
    const result = await fetchIssueContext('not-a-github-url');
    expect(result).toBeNull();
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('returns formatted context for valid issue URL', async () => {
    const ghResponse = JSON.stringify({
      title: 'Include comments in stack dispatch',
      body: 'We need to include comments.',
      state: 'OPEN',
      author: { login: 'dev' },
      createdAt: '2026-03-25T10:00:00Z',
      labels: [],
      comments: [
        { author: { login: 'pm' }, body: 'This is important!', createdAt: '2026-03-26T10:00:00Z' },
      ],
    });

    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, ghResponse, '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await fetchIssueContext('https://github.com/onomojo/sandstorm/issues/111');
    expect(result).toContain('## GitHub Issue: Include comments in stack dispatch');
    expect(result).toContain('This is important!');
    expect(result).toContain('@pm');
  });

  it('returns null when gh fetch fails', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('fail'), '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await fetchIssueContext('https://github.com/owner/repo/issues/1');
    expect(result).toBeNull();
  });
});
