import { execFile } from 'child_process';

interface IssueComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

interface IssueData {
  title: string;
  body: string;
  state: string;
  author: { login: string };
  createdAt: string;
  labels: Array<{ name: string }>;
  comments: IssueComment[];
}

/**
 * Fetch a GitHub issue with all comments using the `gh` CLI.
 * Returns a formatted string with the full issue context, or null if fetching fails.
 */
export async function fetchIssueContext(
  issueNumber: string,
  projectDir: string
): Promise<string | null> {
  try {
    const json = await ghIssueView(issueNumber, projectDir);
    const data: IssueData = JSON.parse(json);
    return formatIssueContext(data);
  } catch {
    return null;
  }
}

function ghIssueView(issueNumber: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      [
        'issue',
        'view',
        issueNumber,
        '--json',
        'title,body,state,author,comments,labels,createdAt',
      ],
      { cwd, timeout: 15000 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      }
    );
  });
}

function formatIssueContext(data: IssueData): string {
  const lines: string[] = [];

  lines.push(`# Issue: ${data.title}`);
  lines.push('');
  if (data.labels.length > 0) {
    lines.push(`Labels: ${data.labels.map((l) => l.name).join(', ')}`);
  }
  lines.push(`State: ${data.state}`);
  lines.push(`Author: @${data.author.login}`);
  lines.push(`Created: ${data.createdAt}`);
  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push(data.body);

  if (data.comments.length > 0) {
    lines.push('');
    lines.push('## Comments');
    for (const comment of data.comments) {
      lines.push('');
      lines.push(`### @${comment.author.login} — ${comment.createdAt}`);
      lines.push('');
      lines.push(comment.body);
    }
  }

  return lines.join('\n');
}
