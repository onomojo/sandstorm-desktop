/**
 * GitHub API client for fetching issue details and comments.
 * Used to enrich task prompts with full issue context so inner agents
 * have complete visibility into issue history, comments, and timeline.
 */

import https from 'https';
import { execSync } from 'child_process';

export interface GitHubComment {
  user: string;
  created_at: string;
  body: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  user: string;
  created_at: string;
  body: string;
  labels: string[];
  comments: GitHubComment[];
}

/**
 * Make an HTTPS GET request to the GitHub API.
 */
function githubGet(
  urlPath: string,
  token: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        port: 443,
        path: urlPath,
        method: 'GET',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Sandstorm-Desktop/1.0',
        },
        timeout: 15_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('GitHub API request timed out'));
    });
    req.end();
  });
}

/**
 * Fetch all comments for an issue, handling pagination.
 */
async function fetchAllComments(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string
): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const result = await githubGet(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`,
      token
    );

    if (result.status !== 200 || !Array.isArray(result.body)) break;

    const batch = result.body as Array<Record<string, unknown>>;
    if (batch.length === 0) break;

    for (const c of batch) {
      comments.push({
        user: (c.user as Record<string, unknown>)?.login as string ?? 'unknown',
        created_at: c.created_at as string,
        body: c.body as string ?? '',
      });
    }

    if (batch.length < perPage) break;
    page++;
  }

  return comments;
}

/**
 * Fetch a GitHub issue with all its comments.
 */
export async function fetchIssueWithComments(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string
): Promise<GitHubIssue> {
  const result = await githubGet(
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    token
  );

  if (result.status !== 200) {
    throw new Error(
      `GitHub API returned status ${result.status} for issue #${issueNumber}`
    );
  }

  const issue = result.body as Record<string, unknown>;
  const labels = Array.isArray(issue.labels)
    ? (issue.labels as Array<Record<string, unknown>>).map(
        (l) => (l.name as string) ?? ''
      )
    : [];

  const comments = await fetchAllComments(owner, repo, issueNumber, token);

  return {
    number: issueNumber,
    title: issue.title as string ?? '',
    state: issue.state as string ?? 'unknown',
    user: (issue.user as Record<string, unknown>)?.login as string ?? 'unknown',
    created_at: issue.created_at as string ?? '',
    body: issue.body as string ?? '',
    labels,
    comments,
  };
}

/**
 * Format a fetched issue with comments into a text block suitable for
 * prepending to a task prompt.
 */
export function formatIssueContext(issue: GitHubIssue): string {
  const lines: string[] = [];

  lines.push('=== GitHub Issue Context ===');
  lines.push(`Issue #${issue.number}: ${issue.title}`);
  lines.push(`State: ${issue.state}`);
  lines.push(`Opened by: ${issue.user} on ${issue.created_at}`);
  if (issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.join(', ')}`);
  }
  lines.push('');
  lines.push('--- Issue Description ---');
  lines.push(issue.body || '(no description)');

  if (issue.comments.length > 0) {
    lines.push('');
    lines.push(`--- Comments (${issue.comments.length}) ---`);
    for (const comment of issue.comments) {
      lines.push('');
      lines.push(`[${comment.created_at}] @${comment.user}:`);
      lines.push(comment.body);
    }
  }

  lines.push('');
  lines.push('=== End GitHub Issue Context ===');
  lines.push('');

  return lines.join('\n');
}

/**
 * Resolve GitHub token from environment or `gh auth token`.
 */
export function resolveGitHubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  try {
    const token = execSync('gh auth token 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Extract owner/repo from a git remote URL.
 * Handles both HTTPS and SSH formats:
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 */
export function parseRepoSlug(
  remoteUrl: string
): { owner: string; repo: string } | null {
  // HTTPS format
  const httpsMatch = remoteUrl.match(
    /github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH format
  const sshMatch = remoteUrl.match(
    /github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Get the remote URL for a git repository.
 */
export function getGitRemoteUrl(projectDir: string): string | null {
  try {
    return execSync('git remote get-url origin', {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Parse a ticket string to extract a GitHub issue number.
 * Accepts formats: "123", "#123", "issue-123", "GH-123"
 * Returns null if the ticket doesn't look like a GitHub issue number.
 */
export function parseIssueNumber(ticket: string): number | null {
  const trimmed = ticket.trim();

  // Pure number: "123"
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  // Hash prefix: "#123"
  const hashMatch = trimmed.match(/^#(\d+)$/);
  if (hashMatch) {
    return parseInt(hashMatch[1], 10);
  }

  // Common prefixes: "issue-123", "GH-123"
  const prefixMatch = trimmed.match(/^(?:issue|gh)[-#](\d+)$/i);
  if (prefixMatch) {
    return parseInt(prefixMatch[1], 10);
  }

  return null;
}
