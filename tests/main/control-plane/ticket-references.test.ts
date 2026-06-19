import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks so vi.mock factories can reference them.
// ---------------------------------------------------------------------------
const { mockExecFile, mockFetch } = vi.hoisted(() => {
  const mockExecFile = vi.fn();
  const mockFetch = vi.fn();
  return { mockExecFile, mockFetch };
});

vi.mock('child_process', async () => {
  const util = await import('util');
  const execFileFn = vi.fn();
  // Make promisify(execFile) return our mockExecFile
  (execFileFn as any)[util.promisify.custom] = mockExecFile;
  return { execFile: execFileFn };
});

// Replace global fetch
vi.stubGlobal('fetch', mockFetch);

import { resolveTicketReferences, renderResolvedReferences } from '../../../src/main/control-plane/ticket-references';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

function makeResponse(body: string, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = makeReadableStream([encoder.encode(body)]);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: stream,
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockFetch.mockResolvedValue(makeResponse(''));
  mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
});

// ---------------------------------------------------------------------------
// URL extraction / classification
// ---------------------------------------------------------------------------
describe('resolveTicketReferences — no links', () => {
  it('returns [] for a body with no http(s) links', async () => {
    const refs = await resolveTicketReferences('No links here at all.');
    expect(refs).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ignores non-http(s) schemes', async () => {
    const refs = await resolveTicketReferences('See ftp://example.com and file:///tmp/foo');
    expect(refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gist links → gh gist view --raw
// ---------------------------------------------------------------------------
describe('resolveTicketReferences — gist', () => {
  it('fetches a gist via gh gist view --raw', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'gist content here', stderr: '' });
    const body = 'Check the mockup at https://gist.github.com/user/abc123def456';
    const refs = await resolveTicketReferences(body);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('gist');
    expect(refs[0].content).toBe('gist content here');
    expect(refs[0].url).toBe('https://gist.github.com/user/abc123def456');
    // Assert the correct mechanism (promisified — 3 args, no callback)
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['gist', 'view', 'abc123def456', '--raw'],
      expect.any(Object)
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error for an unreachable gist', async () => {
    mockExecFile.mockRejectedValue(Object.assign(new Error('not found'), { stderr: 'gist not found (404)' }));
    const refs = await resolveTicketReferences('https://gist.github.com/user/badid');
    expect(refs[0].content).toBeNull();
    expect(refs[0].error).toBe('404');
  });

  it('returns timeout error for a killed process', async () => {
    mockExecFile.mockRejectedValue(Object.assign(new Error('timeout'), { killed: true }));
    const refs = await resolveTicketReferences('https://gist.github.com/user/slowid');
    expect(refs[0].content).toBeNull();
    expect(refs[0].error).toBe('timeout');
  });

  it('truncates gist content at 256 KB', async () => {
    const big = 'x'.repeat(300 * 1024);
    mockExecFile.mockResolvedValue({ stdout: big, stderr: '' });
    const refs = await resolveTicketReferences('https://gist.github.com/user/bigid');
    expect(refs[0].truncated).toBe(true);
    expect(refs[0].content!.length).toBe(256 * 1024);
  });
});

// ---------------------------------------------------------------------------
// GitHub links → gh api
// ---------------------------------------------------------------------------
describe('resolveTicketReferences — github', () => {
  it('fetches a github file link via gh api', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'file content', stderr: '' });
    const url = 'https://github.com/owner/repo/blob/main/src/foo.ts';
    const refs = await resolveTicketReferences(url);
    expect(refs[0].kind).toBe('github');
    expect(refs[0].content).toBe('file content');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['api', '/repos/owner/repo/contents/src/foo.ts?ref=main', '--header', 'Accept: application/vnd.github.raw+json'],
      expect.any(Object)
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches raw.githubusercontent.com via gh api', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'raw file', stderr: '' });
    const url = 'https://raw.githubusercontent.com/owner/repo/main/README.md';
    const refs = await resolveTicketReferences(url);
    expect(refs[0].kind).toBe('github');
    expect(refs[0].content).toBe('raw file');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['api', '/repos/owner/repo/contents/README.md?ref=main', '--header', 'Accept: application/vnd.github.raw+json'],
      expect.any(Object)
    );
  });

  it('returns 404 error for missing github file', async () => {
    mockExecFile.mockRejectedValue(Object.assign(new Error('not found'), { stderr: 'HTTP 404 Not Found' }));
    const refs = await resolveTicketReferences('https://github.com/owner/repo/blob/main/missing.ts');
    expect(refs[0].content).toBeNull();
    expect(refs[0].error).toBe('404');
  });
});

// ---------------------------------------------------------------------------
// Non-GitHub http(s) links → Node fetch()
// ---------------------------------------------------------------------------
describe('resolveTicketReferences — other', () => {
  it('fetches a non-GitHub http(s) link via fetch()', async () => {
    mockFetch.mockResolvedValue(makeResponse('page content', 200));
    const refs = await resolveTicketReferences('https://example.com/mockup.html');
    expect(refs[0].kind).toBe('other');
    expect(refs[0].content).toBe('page content');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns http-404 error for a 404 response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, body: null } as unknown as Response);
    const refs = await resolveTicketReferences('https://example.com/gone');
    expect(refs[0].content).toBeNull();
    expect(refs[0].error).toBe('404');
  });

  it('returns http-500 error for a 500 response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, body: null } as unknown as Response);
    const refs = await resolveTicketReferences('https://example.com/broken');
    expect(refs[0].content).toBeNull();
    expect(refs[0].error).toBe('http-500');
  });

  it('returns timeout error on AbortError', async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const refs = await resolveTicketReferences('https://example.com/slow');
    expect(refs[0].content).toBeNull();
    expect(refs[0].error).toBe('timeout');
  });

  it('truncates content at 256 KB via streamed read', async () => {
    const big = 'y'.repeat(300 * 1024);
    mockFetch.mockResolvedValue(makeResponse(big, 200));
    const refs = await resolveTicketReferences('https://example.com/bigfile');
    expect(refs[0].truncated).toBe(true);
    expect(refs[0].content!.length).toBeLessThanOrEqual(256 * 1024);
  });
});

// ---------------------------------------------------------------------------
// SSRF guard — private/loopback hosts
// ---------------------------------------------------------------------------
describe('resolveTicketReferences — SSRF guard', () => {
  const privateHosts = [
    'http://localhost/admin',
    'http://127.0.0.1/secret',
    'http://0.0.0.0/bad',
    'http://10.0.0.1/internal',
    'http://172.16.5.5/private',
    'http://192.168.1.1/router',
    'http://169.254.169.254/metadata',
  ];

  for (const url of privateHosts) {
    it(`blocks ${url} as blocked-private-host`, async () => {
      const refs = await resolveTicketReferences(url);
      expect(refs).toHaveLength(1);
      expect(refs[0].content).toBeNull();
      expect(refs[0].error).toBe('blocked-private-host');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------
describe('resolveTicketReferences — deduplication', () => {
  it('fetches each unique URL only once', async () => {
    mockFetch.mockResolvedValue(makeResponse('content', 200));
    const body = 'https://example.com/page https://example.com/page https://example.com/page';
    const refs = await resolveTicketReferences(body);
    expect(refs).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches two different URLs separately', async () => {
    mockFetch.mockResolvedValue(makeResponse('content', 200));
    const body = 'https://example.com/a https://example.com/b';
    const refs = await resolveTicketReferences(body);
    expect(refs).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Total cap
// ---------------------------------------------------------------------------
describe('resolveTicketReferences — total cap', () => {
  it('marks remaining references as capped when total exceeds 1 MB', async () => {
    // Each URL returns 300 KB → truncated to 256 KB per fetch.
    // After 4 fetches: 4 × 256 KB = 1 MB total → 5th URL is capped.
    const big = 'z'.repeat(300 * 1024);
    // Use mockImplementation so each fetch call gets a fresh Response (fresh stream)
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(big, 200)));

    const urls = [
      'https://example.com/u1',
      'https://example.com/u2',
      'https://example.com/u3',
      'https://example.com/u4',
      'https://example.com/u5',
    ];
    const refs = await resolveTicketReferences(urls.join(' '));
    const capped = refs.filter(r => r.capped);
    expect(capped.length).toBeGreaterThan(0);
    // The 5th URL should have been skipped without calling fetch
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// Mixed body with multiple kinds
// ---------------------------------------------------------------------------
describe('resolveTicketReferences — mixed body', () => {
  it('extracts gist, github, and other links from the same body', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'fetched content', stderr: '' });
    mockFetch.mockResolvedValue(makeResponse('other content', 200));

    const body = [
      'Gist: https://gist.github.com/user/abc123',
      'File: https://github.com/owner/repo/blob/main/src/foo.ts',
      'Docs: https://docs.example.com/spec',
    ].join('\n');

    const refs = await resolveTicketReferences(body);
    expect(refs).toHaveLength(3);
    expect(refs.find(r => r.kind === 'gist')).toBeDefined();
    expect(refs.find(r => r.kind === 'github')).toBeDefined();
    expect(refs.find(r => r.kind === 'other')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// renderResolvedReferences
// ---------------------------------------------------------------------------
describe('renderResolvedReferences', () => {
  it('returns empty string for empty array', () => {
    expect(renderResolvedReferences([])).toBe('');
  });

  it('renders a section header with content', () => {
    const refs = [{ url: 'https://example.com/doc', kind: 'other' as const, content: 'hello world' }];
    const rendered = renderResolvedReferences(refs);
    expect(rendered).toContain('## Resolved References');
    expect(rendered).toContain('https://example.com/doc');
    expect(rendered).toContain('hello world');
  });

  it('renders broken-link error', () => {
    const refs = [{ url: 'https://example.com/gone', kind: 'other' as const, content: null, error: '404' }];
    const rendered = renderResolvedReferences(refs);
    expect(rendered).toContain('Could not fetch');
    expect(rendered).toContain('404');
  });

  it('renders capped reference', () => {
    const refs = [{ url: 'https://example.com/large', kind: 'other' as const, content: null, capped: true }];
    const rendered = renderResolvedReferences(refs);
    expect(rendered).toContain('total fetch budget exceeded');
  });

  it('renders truncated flag', () => {
    const refs = [{ url: 'https://example.com/big', kind: 'other' as const, content: 'abcd', truncated: true }];
    const rendered = renderResolvedReferences(refs);
    expect(rendered).toContain('truncated');
  });
});
