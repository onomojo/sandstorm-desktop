import { execFile } from 'child_process';

export interface GitHubComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface GitHubIssue {
  title: string;
  body: string;
  state: string;
  author: string;
  createdAt: string;
  labels: string[];
  comments: GitHubComment[];
}

/**
 * Parse a GitHub issue URL into owner, repo, and issue number.
 * Supports formats like:
 *   https://github.com/owner/repo/issues/123
 *   github.com/owner/repo/issues/123
 */
export function parseIssueUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/**
 * Fetch a GitHub issue with all comments using the `gh` CLI.
 * Returns null if `gh` is unavailable or the fetch fails.
 */
export async function fetchGitHubIssue(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GitHubIssue | null> {
  try {
    const json = await new Promise<string>((resolve, reject) => {
      execFile(
        'gh',
        [
          'issue', 'view', String(issueNumber),
          '--repo', `${owner}/${repo}`,
          '--json', 'title,body,state,author,comments,labels,createdAt',
        ],
        { timeout: 30000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
          } else {
            resolve(stdout);
          }
        }
      );
    });

    const data = JSON.parse(json);

    return {
      title: data.title ?? '',
      body: data.body ?? '',
      state: data.state ?? '',
      author: data.author?.login ?? 'unknown',
      createdAt: data.createdAt ?? '',
      labels: (data.labels ?? []).map((l: { name: string }) => l.name),
      comments: (data.comments ?? []).map((c: { author: { login: string }; body: string; createdAt: string }) => ({
        author: c.author?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.createdAt ?? '',
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Format a GitHub issue (with comments) into a prompt-friendly string.
 */
export function formatIssueForPrompt(issue: GitHubIssue): string {
  const parts: string[] = [];

  parts.push(`## GitHub Issue: ${issue.title}`);
  parts.push(`**State:** ${issue.state} | **Author:** @${issue.author} | **Created:** ${issue.createdAt}`);

  if (issue.labels.length > 0) {
    parts.push(`**Labels:** ${issue.labels.join(', ')}`);
  }

  parts.push('');
  parts.push('### Description');
  parts.push(issue.body || '(no description)');

  if (issue.comments.length > 0) {
    parts.push('');
    parts.push(`### Comments (${issue.comments.length})`);
    for (const comment of issue.comments) {
      parts.push('');
      parts.push(`**@${comment.author}** on ${comment.createdAt}:`);
      parts.push(comment.body);
    }
  }

  return parts.join('\n');
}

/**
 * Given a GitHub issue URL, fetch the issue and return a formatted prompt context string.
 * Returns null if the URL is not a valid GitHub issue URL or the fetch fails.
 */
export async function fetchIssueContext(issueUrl: string): Promise<string | null> {
  const parsed = parseIssueUrl(issueUrl);
  if (!parsed) return null;

  const issue = await fetchGitHubIssue(parsed.owner, parsed.repo, parsed.number);
  if (!issue) return null;

  return formatIssueForPrompt(issue);
}
