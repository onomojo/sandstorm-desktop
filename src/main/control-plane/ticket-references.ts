import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface TicketReference {
  url: string;
  kind: 'gist' | 'github' | 'other';
  content: string | null;
  error?: string;
  truncated?: boolean;
  capped?: boolean;
}

const PER_FETCH_BYTE_LIMIT = 256 * 1024; // 256 KB
const TOTAL_BYTE_LIMIT = 1024 * 1024;    // 1 MB
const FETCH_TIMEOUT_MS = 10_000;

const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1)$/i;
const PRIVATE_CIDR_RE = /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)$/;

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_RE.test(hostname) || PRIVATE_CIDR_RE.test(hostname);
}

function extractGistId(url: URL): string | null {
  // https://gist.github.com/<user>/<id> or https://gist.github.com/<id>
  const parts = url.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function extractGithubApiPath(url: URL): string | null {
  // Convert github.com or raw.githubusercontent.com to a gh api path
  if (url.hostname === 'raw.githubusercontent.com') {
    // raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>
    // → repos/<owner>/<repo>/contents/<path>?ref=<branch>
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 4) return null;
    const [owner, repo, ref, ...rest] = parts;
    return `/repos/${owner}/${repo}/contents/${rest.join('/')}?ref=${ref}`;
  }
  // github.com/<owner>/<repo>/blob/<branch>/<path>
  const parts = url.pathname.split('/').filter(Boolean);
  const blobIdx = parts.indexOf('blob');
  if (blobIdx >= 2 && blobIdx + 1 < parts.length) {
    const [owner, repo] = parts;
    const ref = parts[blobIdx + 1];
    const filePath = parts.slice(blobIdx + 2).join('/');
    return `/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;
  }
  return null;
}

function classifyUrl(url: URL): 'gist' | 'github' | 'other' {
  if (url.hostname === 'gist.github.com') return 'gist';
  if (url.hostname === 'github.com' || url.hostname === 'raw.githubusercontent.com') return 'github';
  return 'other';
}

async function fetchGist(url: URL): Promise<{ content: string | null; error?: string; truncated?: boolean }> {
  const gistId = extractGistId(url);
  if (!gistId) return { content: null, error: 'invalid-gist-url' };

  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['gist', 'view', gistId, '--raw'],
      { timeout: FETCH_TIMEOUT_MS, maxBuffer: PER_FETCH_BYTE_LIMIT + 1024 }
    );
    if (stdout.length > PER_FETCH_BYTE_LIMIT) {
      return { content: stdout.slice(0, PER_FETCH_BYTE_LIMIT), truncated: true };
    }
    return { content: stdout };
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string; killed?: boolean; code?: string };
    if (e.killed || e.code === 'ETIMEDOUT') return { content: null, error: 'timeout' };
    const msg = e.stderr?.trim() || e.message || 'unknown error';
    return { content: null, error: msg.includes('not found') || msg.includes('404') ? '404' : msg };
  }
}

async function fetchGithub(url: URL): Promise<{ content: string | null; error?: string; truncated?: boolean }> {
  const apiPath = extractGithubApiPath(url);
  if (!apiPath) {
    // Fall back to raw fetch for github URLs we can't parse as file refs
    return fetchOther(url);
  }

  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', apiPath, '--header', 'Accept: application/vnd.github.raw+json'],
      { timeout: FETCH_TIMEOUT_MS, maxBuffer: PER_FETCH_BYTE_LIMIT + 1024 }
    );
    if (stdout.length > PER_FETCH_BYTE_LIMIT) {
      return { content: stdout.slice(0, PER_FETCH_BYTE_LIMIT), truncated: true };
    }
    return { content: stdout };
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string; killed?: boolean; code?: string };
    if (e.killed || e.code === 'ETIMEDOUT') return { content: null, error: 'timeout' };
    const msg = e.stderr?.trim() || e.message || 'unknown error';
    return { content: null, error: msg.includes('404') || msg.includes('Not Found') ? '404' : msg };
  }
}

async function fetchOther(url: URL): Promise<{ content: string | null; error?: string; truncated?: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      return { content: null, error: resp.status === 404 ? '404' : `http-${resp.status}` };
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      const text = await resp.text();
      if (text.length > PER_FETCH_BYTE_LIMIT) {
        return { content: text.slice(0, PER_FETCH_BYTE_LIMIT), truncated: true };
      }
      return { content: text };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > PER_FETCH_BYTE_LIMIT) {
        const remaining = PER_FETCH_BYTE_LIMIT - (total - value.length);
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }

    const decoder = new TextDecoder();
    const content = chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
    return { content, ...(truncated ? { truncated: true } : {}) };
  } catch (err: unknown) {
    clearTimeout(timer);
    const e = err as { name?: string; message?: string };
    if (e.name === 'AbortError') return { content: null, error: 'timeout' };
    return { content: null, error: e.message || 'network-error' };
  }
}

function extractUrls(body: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  const re = /https?:\/\/[^\s\)"'<>]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    // Strip trailing punctuation that's likely not part of the URL
    const raw = m[0].replace(/[.,;:!?]+$/, '');
    if (!seen.has(raw)) {
      seen.add(raw);
      results.push(raw);
    }
  }
  return results;
}

/**
 * Resolves all external http(s) links found in the ticket body.
 * Returns one TicketReference per unique URL, deduplicated.
 */
export async function resolveTicketReferences(ticketBody: string): Promise<TicketReference[]> {
  const rawUrls = extractUrls(ticketBody);
  if (rawUrls.length === 0) return [];

  const references: TicketReference[] = [];
  let totalBytes = 0;

  for (const raw of rawUrls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;

    if (isPrivateHost(url.hostname)) {
      references.push({ url: raw, kind: classifyUrl(url), content: null, error: 'blocked-private-host' });
      continue;
    }

    if (totalBytes >= TOTAL_BYTE_LIMIT) {
      references.push({ url: raw, kind: classifyUrl(url), content: null, capped: true });
      continue;
    }

    const kind = classifyUrl(url);
    let result: { content: string | null; error?: string; truncated?: boolean };

    if (kind === 'gist') {
      result = await fetchGist(url);
    } else if (kind === 'github') {
      result = await fetchGithub(url);
    } else {
      result = await fetchOther(url);
    }

    if (result.content !== null) {
      totalBytes += result.content.length;
    }

    const ref: TicketReference = { url: raw, kind, content: result.content };
    if (result.error) ref.error = result.error;
    if (result.truncated) ref.truncated = true;
    references.push(ref);
  }

  return references;
}

/**
 * Renders a "## Resolved References" section for injection into prompts.
 * Returns empty string if no references were resolved.
 */
export function renderResolvedReferences(references: TicketReference[]): string {
  if (references.length === 0) return '';

  const lines: string[] = ['## Resolved References', ''];
  for (const ref of references) {
    lines.push(`### ${ref.url}`);
    if (ref.capped) {
      lines.push('_Skipped: total fetch budget exceeded._');
    } else if (ref.content === null) {
      lines.push(`_Could not fetch: ${ref.error ?? 'unknown error'}_`);
    } else {
      if (ref.truncated) lines.push('_Note: content truncated at 256 KB._');
      lines.push('');
      lines.push('```');
      lines.push(ref.content);
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}
