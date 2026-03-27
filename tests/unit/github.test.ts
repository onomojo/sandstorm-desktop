import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseIssueNumber,
  parseRepoSlug,
  formatIssueContext,
  resolveGitHubToken,
  GitHubIssue,
} from '../../src/main/control-plane/github';

describe('parseIssueNumber', () => {
  it('parses plain numbers', () => {
    expect(parseIssueNumber('123')).toBe(123);
    expect(parseIssueNumber('1')).toBe(1);
    expect(parseIssueNumber('9999')).toBe(9999);
  });

  it('parses hash-prefixed numbers', () => {
    expect(parseIssueNumber('#42')).toBe(42);
    expect(parseIssueNumber('#1')).toBe(1);
  });

  it('parses issue- and GH- prefixes', () => {
    expect(parseIssueNumber('issue-55')).toBe(55);
    expect(parseIssueNumber('GH-100')).toBe(100);
    expect(parseIssueNumber('gh-7')).toBe(7);
    expect(parseIssueNumber('ISSUE-3')).toBe(3);
  });

  it('trims whitespace', () => {
    expect(parseIssueNumber('  42  ')).toBe(42);
    expect(parseIssueNumber(' #10 ')).toBe(10);
  });

  it('returns null for non-issue tickets', () => {
    expect(parseIssueNumber('EXP-342')).toBeNull();
    expect(parseIssueNumber('JIRA-100')).toBeNull();
    expect(parseIssueNumber('abc')).toBeNull();
    expect(parseIssueNumber('')).toBeNull();
    expect(parseIssueNumber('not-a-number')).toBeNull();
  });
});

describe('parseRepoSlug', () => {
  it('parses HTTPS remote URLs', () => {
    expect(parseRepoSlug('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
    expect(parseRepoSlug('https://github.com/onomojo/examprep.git')).toEqual({
      owner: 'onomojo',
      repo: 'examprep',
    });
    expect(parseRepoSlug('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses SSH remote URLs', () => {
    expect(parseRepoSlug('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
    expect(parseRepoSlug('git@github.com:onomojo/examprep.git')).toEqual({
      owner: 'onomojo',
      repo: 'examprep',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseRepoSlug('https://gitlab.com/owner/repo.git')).toBeNull();
    expect(parseRepoSlug('not-a-url')).toBeNull();
    expect(parseRepoSlug('')).toBeNull();
  });
});

describe('formatIssueContext', () => {
  it('formats issue with no comments', () => {
    const issue: GitHubIssue = {
      number: 42,
      title: 'Fix the bug',
      state: 'open',
      user: 'alice',
      created_at: '2026-01-15T10:00:00Z',
      body: 'There is a bug in the login flow.',
      labels: ['bug', 'priority'],
      comments: [],
    };

    const result = formatIssueContext(issue);
    expect(result).toContain('Issue #42: Fix the bug');
    expect(result).toContain('State: open');
    expect(result).toContain('Opened by: alice on 2026-01-15T10:00:00Z');
    expect(result).toContain('Labels: bug, priority');
    expect(result).toContain('There is a bug in the login flow.');
    expect(result).not.toContain('Comments');
  });

  it('formats issue with comments', () => {
    const issue: GitHubIssue = {
      number: 111,
      title: 'Include comments in stack tasks',
      state: 'open',
      user: 'bob',
      created_at: '2026-03-01T12:00:00Z',
      body: 'Agents need full issue context.',
      labels: [],
      comments: [
        {
          user: 'alice',
          created_at: '2026-03-02T09:00:00Z',
          body: 'I added more context here.',
        },
        {
          user: 'bob',
          created_at: '2026-03-03T14:00:00Z',
          body: 'The previous attempt missed the comments.',
        },
      ],
    };

    const result = formatIssueContext(issue);
    expect(result).toContain('Issue #111');
    expect(result).toContain('Comments (2)');
    expect(result).toContain('@alice:');
    expect(result).toContain('I added more context here.');
    expect(result).toContain('@bob:');
    expect(result).toContain('The previous attempt missed the comments.');
    expect(result).toContain('[2026-03-02T09:00:00Z]');
    expect(result).toContain('[2026-03-03T14:00:00Z]');
  });

  it('handles empty body gracefully', () => {
    const issue: GitHubIssue = {
      number: 1,
      title: 'No body',
      state: 'closed',
      user: 'x',
      created_at: '2026-01-01T00:00:00Z',
      body: '',
      labels: [],
      comments: [],
    };

    const result = formatIssueContext(issue);
    expect(result).toContain('(no description)');
  });

  it('does not include Labels line when there are none', () => {
    const issue: GitHubIssue = {
      number: 5,
      title: 'Test',
      state: 'open',
      user: 'x',
      created_at: '2026-01-01T00:00:00Z',
      body: 'body',
      labels: [],
      comments: [],
    };

    const result = formatIssueContext(issue);
    expect(result).not.toContain('Labels:');
  });
});

describe('resolveGitHubToken', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns GITHUB_TOKEN from environment', () => {
    process.env.GITHUB_TOKEN = 'ghp_test123';
    delete process.env.GH_TOKEN;
    expect(resolveGitHubToken()).toBe('ghp_test123');
  });

  it('returns GH_TOKEN if GITHUB_TOKEN is not set', () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'ghp_alt456';
    expect(resolveGitHubToken()).toBe('ghp_alt456');
  });

  it('prefers GITHUB_TOKEN over GH_TOKEN', () => {
    process.env.GITHUB_TOKEN = 'ghp_primary';
    process.env.GH_TOKEN = 'ghp_secondary';
    expect(resolveGitHubToken()).toBe('ghp_primary');
  });
});
