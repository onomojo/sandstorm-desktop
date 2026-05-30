import { execFile } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import type { ProjectTicketConfig } from './registry';

export type { ProjectTicketConfig };

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderr: stderr ?? '' }));
      } else {
        resolve({ stdout, stderr: stderr ?? '' });
      }
    });
  });
}

export interface CreatedTicket {
  url: string;
  ticketId: string;
}

/** A ticket as surfaced for the backlog board: stable id, display title, author identity. */
export interface TicketListEntry {
  id: string;
  title: string;
  author: string;
}

/** Discriminated result for ticket list fetches — lets callers distinguish success from failure. */
export type TicketListResult = { ok: true; tickets: TicketListEntry[] } | { ok: false };

// ---------------------------------------------------------------------------
// GitHub: built-in ticket operations via gh CLI
// ---------------------------------------------------------------------------

export async function githubFetchTicket(ticketId: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', ticketId, '--json', 'title,body,state,url,author,labels'],
      { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }
    );
    const issue = JSON.parse(stdout) as {
      title: string;
      body: string | null;
      state: string;
      url: string;
      author: { login: string } | null;
      labels: { name: string }[];
    };
    const lines: string[] = [
      `# Issue: ${issue.title}`,
      '',
      `State: ${issue.state}`,
      `Author: @${issue.author?.login ?? 'unknown'}`,
      `URL: ${issue.url}`,
    ];
    if (issue.labels.length > 0) {
      lines.push(`Labels: ${issue.labels.map((l) => l.name).join(', ')}`);
    }
    lines.push('', '## Description', '', issue.body ?? '');
    return lines.join('\n');
  } catch {
    return null;
  }
}

export async function githubUpdateTicket(ticketId: string, body: string, cwd: string): Promise<void> {
  await execFileAsync(
    'gh',
    ['issue', 'edit', ticketId, '--body', body],
    { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }
  ).catch((err: Error & { stderr?: string }) => {
    const msg = err.stderr?.trim() || err.message;
    throw new Error(`gh issue edit failed: ${msg}`);
  });
}

/**
 * List the authenticated user's open issues for the backlog board.
 * Optionally filter by label. Excludes PRs (gh issue list does so by default).
 * Returns { ok: false } on any failure so callers can distinguish empty-success from error.
 */
export async function githubListTickets(cwd: string, label?: string): Promise<TicketListResult> {
  try {
    const args = [
      'issue', 'list',
      '--author', '@me',
      '--state', 'open',
      '--json', 'number,title,author',
      '--limit', '100',
    ];
    if (label && label.trim()) {
      args.push('--label', label.trim());
    }
    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const issues = JSON.parse(stdout) as {
      number: number;
      title: string;
      author: { login: string } | null;
    }[];
    return {
      ok: true,
      tickets: issues.map((issue) => ({
        id: String(issue.number),
        title: issue.title,
        author: issue.author?.login ?? '',
      })),
    };
  } catch {
    return { ok: false };
  }
}

export async function githubCreateTicket(title: string, body: string, cwd: string): Promise<CreatedTicket> {
  const { stdout } = await execFileAsync(
    'gh',
    ['issue', 'create', '--title', title, '--body', body],
    { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }
  ).catch((err: Error & { stderr?: string }) => {
    const msg = err.stderr?.trim() || err.message;
    throw new Error(`gh issue create failed: ${msg}`);
  });
  const parsed = parseUrlFromOutput(stdout);
  if (!parsed) {
    throw new Error(
      `Could not parse a ticket URL from gh issue create output. Got: ${stdout.trim()}`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Jira: built-in ticket operations via Jira Cloud REST API v2
// ---------------------------------------------------------------------------

function jiraAuth(config: ProjectTicketConfig): string {
  return Buffer.from(`${config.jira_username ?? ''}:${config.jira_api_token ?? ''}`).toString('base64');
}

async function jiraRequest(opts: {
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  auth: string;
  body?: object;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(opts.url);
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string | number> = {
      'Authorization': `Basic ${opts.auth}`,
      'Accept': 'application/json',
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const reqOpts: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port
        ? Number(parsedUrl.port)
        : parsedUrl.protocol === 'https:' ? 443 : 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: opts.method,
      headers,
    };

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Jira API error ${res.statusCode}: ${data.slice(0, 300)}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Jira API request timed out'));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export async function jiraFetchTicket(
  ticketId: string,
  config: ProjectTicketConfig,
): Promise<string | null> {
  if (!config.jira_url || !config.jira_username || !config.jira_api_token) {
    return null;
  }
  try {
    const url = `${config.jira_url.replace(/\/$/, '')}/rest/api/2/issue/${ticketId}?fields=summary,description,status,assignee,reporter,labels,issuetype,comment`;
    const raw = await jiraRequest({ url, method: 'GET', auth: jiraAuth(config) });
    const issue = JSON.parse(raw) as {
      key: string;
      fields: {
        summary: string;
        description: string | null;
        status: { name: string };
        issuetype: { name: string };
        reporter: { displayName: string } | null;
        assignee: { displayName: string } | null;
        labels: string[];
        comment?: { comments: { author: { displayName: string }; body: string }[] };
      };
    };
    const f = issue.fields;
    const lines: string[] = [
      `# Issue: ${f.summary}`,
      '',
      `State: ${f.status.name}`,
      `Type: ${f.issuetype.name}`,
      `Reporter: @${f.reporter?.displayName ?? 'Unknown'}`,
      `Assignee: ${f.assignee?.displayName ?? 'Unassigned'}`,
    ];
    if (f.labels.length > 0) {
      lines.push(`Labels: ${f.labels.join(', ')}`);
    }
    lines.push('', '## Description', '', f.description ?? '');
    const comments = f.comment?.comments ?? [];
    if (comments.length > 0) {
      lines.push('', '## Comments');
      for (const c of comments) {
        lines.push('', `**${c.author.displayName}:**`, c.body);
      }
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * List the reporting user's not-done issues for the backlog board.
 * Optionally filter by label. Returns { ok: false } on any failure or missing credentials.
 */
export async function jiraListTickets(
  config: ProjectTicketConfig,
  label?: string,
): Promise<TicketListResult> {
  if (!config.jira_url || !config.jira_username || !config.jira_api_token) {
    return { ok: false };
  }
  try {
    let jql = 'reporter = currentUser() AND statusCategory != Done';
    if (label && label.trim()) {
      jql += ` AND labels = "${label.trim().replace(/"/g, '\\"')}"`;
    }
    const url =
      `${config.jira_url.replace(/\/$/, '')}/rest/api/2/search` +
      `?jql=${encodeURIComponent(jql)}&fields=summary,reporter&maxResults=100`;
    const raw = await jiraRequest({ url, method: 'GET', auth: jiraAuth(config) });
    const result = JSON.parse(raw) as {
      issues: {
        key: string;
        fields: { summary: string; reporter: { accountId?: string; displayName?: string } | null };
      }[];
    };
    return {
      ok: true,
      tickets: (result.issues ?? []).map((issue) => ({
        id: issue.key,
        title: issue.fields.summary,
        author: issue.fields.reporter?.accountId ?? issue.fields.reporter?.displayName ?? '',
      })),
    };
  } catch {
    return { ok: false };
  }
}

export async function jiraUpdateTicket(
  ticketId: string,
  body: string,
  config: ProjectTicketConfig,
): Promise<void> {
  if (!config.jira_url || !config.jira_username || !config.jira_api_token) {
    throw new Error(
      'Jira credentials are missing. Configure JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN in Project Settings.'
    );
  }
  const url = `${config.jira_url.replace(/\/$/, '')}/rest/api/2/issue/${ticketId}`;
  await jiraRequest({
    url,
    method: 'PUT',
    auth: jiraAuth(config),
    body: { fields: { description: body } },
  });
}

export async function jiraCreateTicket(
  title: string,
  body: string,
  config: ProjectTicketConfig,
): Promise<CreatedTicket> {
  if (!config.jira_url || !config.jira_username || !config.jira_api_token || !config.jira_project_key) {
    throw new Error(
      'Jira credentials or project key are missing. Configure them in Project Settings.'
    );
  }
  const url = `${config.jira_url.replace(/\/$/, '')}/rest/api/2/issue`;
  const raw = await jiraRequest({
    url,
    method: 'POST',
    auth: jiraAuth(config),
    body: {
      fields: {
        project: { key: config.jira_project_key },
        summary: title,
        description: body,
        issuetype: { name: config.jira_issue_type || 'Task' },
      },
    },
  });
  const result = JSON.parse(raw) as { key: string; self: string };
  const issueKey = result.key;
  const issueUrl = `${config.jira_url.replace(/\/$/, '')}/browse/${issueKey}`;
  return { url: issueUrl, ticketId: issueKey };
}

// ---------------------------------------------------------------------------
// Provider-neutral dispatch
// ---------------------------------------------------------------------------

export async function fetchTicketWithConfig(
  ticketId: string,
  config: ProjectTicketConfig,
  cwd: string,
): Promise<string | null> {
  if (config.provider === 'github') {
    return githubFetchTicket(ticketId, cwd);
  }
  return jiraFetchTicket(ticketId, config);
}

export async function listTicketsWithConfig(
  config: ProjectTicketConfig,
  cwd: string,
  label?: string,
): Promise<TicketListResult> {
  if (config.provider === 'github') {
    return githubListTickets(cwd, label);
  }
  return jiraListTickets(config, label);
}

export async function updateTicketWithConfig(
  ticketId: string,
  body: string,
  config: ProjectTicketConfig,
  cwd: string,
): Promise<void> {
  if (!ticketId.trim()) throw new Error('Ticket ID is required');
  if (!body.trim()) throw new Error('Ticket body cannot be empty');
  if (config.provider === 'github') {
    return githubUpdateTicket(ticketId, body, cwd);
  }
  return jiraUpdateTicket(ticketId, body, config);
}

export async function createTicketWithConfig(opts: {
  title: string;
  body: string;
  config: ProjectTicketConfig;
  cwd: string;
}): Promise<CreatedTicket> {
  const title = opts.title.trim();
  const body = opts.body.trim();
  if (!title) throw new Error('Ticket title is required');
  if (!body) throw new Error('Ticket body is required');
  if (opts.config.provider === 'github') {
    return githubCreateTicket(title, body, opts.cwd);
  }
  return jiraCreateTicket(title, body, opts.config);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseUrlFromOutput(stdout: string): CreatedTicket | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/https?:\/\/\S+/);
    if (!match) continue;
    const url = match[0].replace(/[.,;:)\]]+$/, '');
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      const ticketId = segments[segments.length - 1];
      if (!ticketId) continue;
      return { url, ticketId };
    } catch {
      continue;
    }
  }
  return null;
}
