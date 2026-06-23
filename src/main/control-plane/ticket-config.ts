import { execFile } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import type { ProjectTicketConfig } from './registry';
import { CONTRACT_MARKER, parseContractComment } from './contract-generator';

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

/** Structured failure reason carried on the ok:false branch of TicketListResult. */
export type TicketListError =
  | { reason: 'missing-creds' }
  | { reason: 'http-status'; status: number; body?: string }
  | { reason: 'network'; message: string };

/** Discriminated result for ticket list fetches — lets callers distinguish success from failure. */
export type TicketListResult =
  | { ok: true; tickets: TicketListEntry[] }
  | { ok: false; error: TicketListError };

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

export async function githubFetchRawBody(ticketId: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', ticketId, '--json', 'body'],
      { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }
    );
    const issue = JSON.parse(stdout) as { body: string | null };
    return issue.body ?? '';
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
 * Upsert the contract comment on a GitHub issue. Idempotent: any existing
 * contract comment (identified by the marker) is deleted and replaced, so
 * re-generation never piles up duplicate comments. `execFile` passes the body
 * as a single argv entry with no shell, so arbitrary JSON content is safe.
 * Throws on failure so the atomic gate step can fail closed.
 */
export async function githubUpsertContractComment(
  ticketId: string,
  commentBody: string,
  cwd: string,
): Promise<void> {
  const { stdout: nwo } = await execFileAsync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { cwd, timeout: 30000 },
  );
  const repo = nwo.trim();
  if (!repo) throw new Error('Could not resolve repository for contract comment');

  // Remove any pre-existing contract comments so we never accumulate duplicates.
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', '--paginate', `repos/${repo}/issues/${ticketId}/comments`],
      { cwd, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    const comments = JSON.parse(stdout) as { id: number; body: string }[];
    for (const c of comments) {
      if ((c.body || '').includes(CONTRACT_MARKER)) {
        await execFileAsync(
          'gh',
          ['api', `repos/${repo}/issues/comments/${c.id}`, '-X', 'DELETE'],
          { cwd, timeout: 30000 },
        ).catch(() => {});
      }
    }
  } catch {
    // Listing failed — fall through and post a fresh comment anyway.
  }

  await execFileAsync(
    'gh',
    ['issue', 'comment', ticketId, '--body', commentBody],
    { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
  ).catch((err: Error & { stderr?: string }) => {
    const msg = err.stderr?.trim() || err.message;
    throw new Error(`gh issue comment failed: ${msg}`);
  });
}

/** Read the parsed contract JSON from a GitHub issue's contract comment, or null. */
export async function githubFetchContractComment(ticketId: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', ticketId, '--json', 'comments'],
      { cwd, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout) as { comments: { body: string }[] };
    for (const c of data.comments ?? []) {
      const parsed = parseContractComment(c.body ?? '');
      if (parsed) return parsed.json;
    }
    return null;
  } catch {
    return null;
  }
}

type FilterConfig = Pick<
  import('./registry').ProjectTicketConfig,
  'filter_mode' | 'filter_ownership' | 'filter_open_only' | 'filter_query'
>;

function buildGithubSearchQuery(config?: FilterConfig): string {
  const mode = config?.filter_mode ?? 'assisted';
  if (mode === 'advanced') {
    const q = config?.filter_query?.trim();
    if (q) return q;
  }
  const parts: string[] = [];
  parts.push((config?.filter_ownership ?? 'created') === 'assigned' ? 'assignee:@me' : 'author:@me');
  if (config?.filter_open_only !== false) parts.push('is:open');
  return parts.join(' ');
}

function jiraLabelClause(label: string): string {
  return ` AND labels = "${label.trim().replace(/"/g, '\\"')}"`;
}

function buildJiraFilterJql(config: FilterConfig & { jira_project_key?: string | null }): string {
  const mode = config.filter_mode ?? 'assisted';
  let jql: string;
  let trailingOrderBy: string | null = null;
  if (mode === 'advanced' && config.filter_query?.trim()) {
    const raw = config.filter_query.trim();
    // JQL requires ORDER BY to be last. If the user's advanced query ends with ORDER BY ...,
    // extract it so any appended "AND project = ..." clause is placed before it.
    // The greedy [\s\S]* matches as much as possible, finding the LAST ORDER BY occurrence.
    const orderByMatch = raw.match(/^([\s\S]*\S)\s+\b(ORDER\s+BY\b[\s\S]*)$/i);
    if (orderByMatch) {
      jql = `(${orderByMatch[1].trim()})`;
      trailingOrderBy = orderByMatch[2];
    } else {
      // The user's query is wrapped in parens so the AND project clause applies to the whole expression.
      // Limitation: a query with unmatched/leading-close parens (e.g. "a) OR (b") will break JQL precedence.
      jql = `(${raw})`;
    }
  } else {
    const parts: string[] = [];
    parts.push((config.filter_ownership ?? 'created') === 'assigned'
      ? 'assignee = currentUser()'
      : 'reporter = currentUser()');
    if (config.filter_open_only !== false) parts.push('statusCategory != Done');
    jql = parts.join(' AND ');
  }
  if (config.jira_project_key?.trim()) {
    const key = config.jira_project_key.trim().replace(/"/g, '\\"');
    jql += ` AND project = "${key}"`;
  }
  if (trailingOrderBy) {
    jql += ` ${trailingOrderBy}`;
  }
  return jql;
}

/**
 * List issues for the backlog board using gh issue list --search.
 * Filter config drives ownership and open-only presets, or passes a raw query.
 * Returns { ok: false } on any failure so callers can distinguish empty-success from error.
 */
export async function githubListTickets(cwd: string, label?: string, config?: FilterConfig): Promise<TicketListResult> {
  try {
    const searchQuery = buildGithubSearchQuery(config);
    const mode = config?.filter_mode ?? 'assisted';
    const args = [
      'issue', 'list',
      '--search', searchQuery,
    ];
    if (mode !== 'advanced' && config?.filter_open_only === false) {
      args.push('--state', 'all');
    }
    args.push('--json', 'number,title,author', '--limit', '100');
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
    return { ok: false, error: { reason: 'network', message: 'Failed to fetch GitHub tickets' } };
  }
}

export async function githubCloseTicket(ticketId: string, cwd: string): Promise<void> {
  try {
    await execFileAsync(
      'gh',
      ['issue', 'close', ticketId],
      { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }
    );
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const text = `${e.stderr ?? ''} ${e.message ?? ''}`;
    if (/already closed/i.test(text)) return;
    throw new Error(`gh issue close failed: ${e.stderr?.trim() || (err as Error).message}`);
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
          reject(Object.assign(
            new Error(`Jira API error ${res.statusCode}: ${data.slice(0, 300)}`),
            { status: res.statusCode, body: data.slice(0, 300) },
          ));
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
 * List issues for the backlog board using configured filter and always project-scoped.
 * Returns { ok: false } on any failure or missing credentials.
 */
export async function jiraListTickets(
  config: ProjectTicketConfig,
  label?: string,
): Promise<TicketListResult> {
  if (!config.jira_url || !config.jira_username || !config.jira_api_token) {
    return { ok: false, error: { reason: 'missing-creds' } };
  }
  try {
    let jql = buildJiraFilterJql(config);
    if (label && label.trim()) {
      jql += jiraLabelClause(label);
    }
    const url =
      `${config.jira_url.replace(/\/$/, '')}/rest/api/3/search/jql` +
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
  } catch (err: unknown) {
    const e = err as { status?: number; body?: string; message?: string };
    if (typeof e.status === 'number') {
      return { ok: false, error: { reason: 'http-status', status: e.status, body: e.body } };
    }
    return { ok: false, error: { reason: 'network', message: (err as Error).message ?? String(err) } };
  }
}

export async function jiraFetchRawBody(
  ticketId: string,
  config: ProjectTicketConfig,
): Promise<string | null> {
  if (!config.jira_url || !config.jira_username || !config.jira_api_token) {
    return null;
  }
  try {
    const url = `${config.jira_url.replace(/\/$/, '')}/rest/api/2/issue/${ticketId}?fields=description`;
    const raw = await jiraRequest({ url, method: 'GET', auth: jiraAuth(config) });
    const issue = JSON.parse(raw) as { fields: { description: string | null } };
    return issue.fields.description ?? '';
  } catch {
    return null;
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

export async function jiraCloseTicket(
  ticketId: string,
  config: ProjectTicketConfig,
): Promise<void> {
  if (!config.jira_url || !config.jira_username || !config.jira_api_token) {
    throw new Error(
      'Jira credentials are missing. Configure JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN in Project Settings.'
    );
  }
  const url = `${config.jira_url.replace(/\/$/, '')}/rest/api/3/issue/${ticketId}/archive`;
  try {
    await jiraRequest({ url, method: 'PUT', auth: jiraAuth(config) });
  } catch (err: unknown) {
    const e = err as { status?: number; body?: string; message?: string };
    const body = e.body ?? e.message ?? '';
    if (/already archived/i.test(body)) return;
    throw err;
  }
}

/**
 * Transition a Jira issue to its "Done" status via the transitions API (REST v2).
 * Selection algorithm:
 *   1. Prefer a transition whose target status name === 'Done' (case-insensitive).
 *   2. Else first done-statusCategory transition not matching won't-do/cancel/reject.
 *   3. Empty transitions list → treat as already Done (idempotent success).
 *   4. No eligible transition found → throw so the Q5 retry+notify path handles it.
 */
export async function jiraTransitionToDone(
  ticketId: string,
  config: ProjectTicketConfig,
): Promise<void> {
  if (!config.jira_url || !config.jira_username || !config.jira_api_token) {
    throw new Error(
      'Jira credentials are missing. Configure JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN in Project Settings.'
    );
  }
  const base = config.jira_url.replace(/\/$/, '');
  const auth = jiraAuth(config);
  const raw = await jiraRequest({
    url: `${base}/rest/api/2/issue/${ticketId}/transitions`,
    method: 'GET',
    auth,
  });
  const result = JSON.parse(raw) as {
    transitions: { id: string; to: { name: string; statusCategory: { key: string } } }[];
  };
  const transitions = result.transitions ?? [];
  // Empty list means no further transitions are available — issue is already Done.
  if (transitions.length === 0) return;
  const CANCEL = /won['']?t\s*do|cancel|reject/i;
  let chosen = transitions.find((t) => t.to.name.toLowerCase() === 'done');
  if (!chosen) {
    chosen = transitions.find(
      (t) => t.to.statusCategory.key === 'done' && !CANCEL.test(t.to.name),
    );
  }
  if (!chosen) {
    const names = transitions.map((t) => t.to.name).join(', ');
    throw new Error(
      `No eligible Done transition found for Jira issue ${ticketId}. Available: ${names}`,
    );
  }
  await jiraRequest({
    url: `${base}/rest/api/2/issue/${ticketId}/transitions`,
    method: 'POST',
    auth,
    body: { transition: { id: chosen.id } },
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
    return githubListTickets(cwd, label, config);
  }
  return jiraListTickets(config, label);
}

export async function fetchRawBodyWithConfig(
  ticketId: string,
  config: ProjectTicketConfig,
  cwd: string,
): Promise<string | null> {
  if (config.provider === 'github') {
    return githubFetchRawBody(ticketId, cwd);
  }
  return jiraFetchRawBody(ticketId, config);
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

export async function closeTicketWithConfig(
  ticketId: string,
  config: ProjectTicketConfig,
  cwd: string,
): Promise<void> {
  if (config.provider === 'github') {
    return githubCloseTicket(ticketId, cwd);
  }
  return jiraCloseTicket(ticketId, config);
}

/**
 * Store the contract comment on a ticket. GitHub-only for now; other providers
 * no-op gracefully (the contract still travels via the dispatch prompt path,
 * which falls back to whatever storage the provider supports).
 */
export async function upsertContractCommentWithConfig(
  ticketId: string,
  commentBody: string,
  config: ProjectTicketConfig | null,
  cwd: string,
): Promise<void> {
  if (config?.provider === 'github') {
    return githubUpsertContractComment(ticketId, commentBody, cwd);
  }
  // Non-GitHub providers: no contract-comment storage yet.
}

/** Read the stored contract JSON for a ticket, or null. GitHub-only for now. */
export async function fetchContractCommentWithConfig(
  ticketId: string,
  config: ProjectTicketConfig | null,
  cwd: string,
): Promise<string | null> {
  if (config?.provider === 'github') {
    return githubFetchContractComment(ticketId, cwd);
  }
  return null;
}

/**
 * Mark a ticket as done after a merge — provider-neutral dispatch.
 * GitHub → gh issue close (idempotent). Jira → transition to Done status.
 * Does NOT archive; the discard/archive path uses closeTicketWithConfig.
 */
export async function markTicketDoneWithConfig(
  ticketId: string,
  config: ProjectTicketConfig,
  cwd: string,
): Promise<void> {
  if (config.provider === 'github') {
    return githubCloseTicket(ticketId, cwd);
  }
  return jiraTransitionToDone(ticketId, config);
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

/** Result shape for the Test Connection feature in JIRA settings. */
export interface TestJiraConnectionResult {
  auth: { ok: true; displayName: string } | { ok: false; status?: number; message: string };
  jql: { ok: true; count: number; hasMore: boolean } | { ok: false; status?: number; message: string } | null;
}

/**
 * Test a JIRA connection using unsaved form values.
 * Pings /rest/api/2/myself for auth, then runs the standard list JQL if auth succeeds.
 */
export async function testJiraConnection(params: {
  jiraUrl: string;
  jiraUsername: string;
  jiraApiToken: string;
  jiraProjectKey?: string | null;
  filterMode?: 'assisted' | 'advanced' | null;
  filterOwnership?: 'created' | 'assigned' | null;
  filterOpenOnly?: boolean | null;
  filterQuery?: string | null;
  label?: string;
}): Promise<TestJiraConnectionResult> {
  const { jiraUrl, jiraUsername, jiraApiToken, jiraProjectKey, label } = params;
  const auth = Buffer.from(`${jiraUsername}:${jiraApiToken}`).toString('base64');
  const baseUrl = jiraUrl.replace(/\/$/, '');

  let displayName: string;
  try {
    const raw = await jiraRequest({ url: `${baseUrl}/rest/api/2/myself`, method: 'GET', auth });
    const myself = JSON.parse(raw) as { displayName?: string };
    displayName = myself.displayName ?? 'Unknown User';
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    return {
      auth: { ok: false, status: e.status, message: e.message ?? String(err) },
      jql: null,
    };
  }

  let jql = buildJiraFilterJql({
    filter_mode: params.filterMode,
    filter_ownership: params.filterOwnership,
    filter_open_only: params.filterOpenOnly,
    filter_query: params.filterQuery,
    jira_project_key: jiraProjectKey,
  });
  if (label && label.trim()) {
    jql += jiraLabelClause(label);
  }
  const searchUrl =
    `${baseUrl}/rest/api/3/search/jql` +
    `?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=100`;
  try {
    const raw = await jiraRequest({ url: searchUrl, method: 'GET', auth });
    const result = JSON.parse(raw) as { issues?: unknown[]; nextPageToken?: string };
    const count = result.issues?.length ?? 0;
    const hasMore = Boolean(result.nextPageToken);
    return { auth: { ok: true, displayName }, jql: { ok: true, count, hasMore } };
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    return {
      auth: { ok: true, displayName },
      jql: { ok: false, status: e.status, message: e.message ?? String(err) },
    };
  }
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
