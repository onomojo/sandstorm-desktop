import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'child_process';
import {
  githubFetchTicket,
  githubFetchRawBody,
  githubUpdateTicket,
  githubCreateTicket,
  githubListTickets,
  githubCloseTicket,
  jiraFetchTicket,
  jiraFetchRawBody,
  jiraUpdateTicket,
  jiraCreateTicket,
  jiraListTickets,
  jiraCloseTicket,
  jiraTransitionToDone,
  fetchTicketWithConfig,
  fetchRawBodyWithConfig,
  updateTicketWithConfig,
  createTicketWithConfig,
  listTicketsWithConfig,
  closeTicketWithConfig,
  markTicketDoneWithConfig,
  testJiraConnection,
} from '../../src/main/control-plane/ticket-config';
import type { ProjectTicketConfig } from '../../src/main/control-plane/registry';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('https', () => ({
  request: vi.fn(),
}));

import * as https from 'https';

const mockExecFile = vi.mocked(child_process.execFile);
const mockHttpsRequest = vi.mocked(https.request);

function mockExecFileSuccess(stdout: string) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(null, stdout, '');
    return {} as ReturnType<typeof child_process.execFile>;
  });
}

function mockExecFileError(stderr: string) {
  const err = Object.assign(new Error('Command failed'), { stderr });
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(err, '', stderr);
    return {} as ReturnType<typeof child_process.execFile>;
  });
}

const GITHUB_CONFIG: ProjectTicketConfig = { provider: 'github' };
const JIRA_CONFIG: ProjectTicketConfig = {
  provider: 'jira',
  jira_url: 'https://acme.atlassian.net',
  jira_username: 'dev@acme.com',
  jira_api_token: 'secret-token',
  jira_project_key: 'ACME',
  jira_issue_type: 'Task',
};

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

describe('githubFetchTicket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns formatted markdown on success', async () => {
    const issue = {
      title: 'Fix the bug',
      body: 'A detailed description.',
      state: 'OPEN',
      url: 'https://github.com/org/repo/issues/42',
      author: { login: 'alice' },
      labels: [{ name: 'bug' }, { name: 'priority-high' }],
    };
    mockExecFileSuccess(JSON.stringify(issue));

    const result = await githubFetchTicket('42', '/proj');

    expect(result).toContain('# Issue: Fix the bug');
    expect(result).toContain('State: OPEN');
    expect(result).toContain('@alice');
    expect(result).toContain('Labels: bug, priority-high');
    expect(result).toContain('A detailed description.');
  });

  it('invokes gh with correct arguments', async () => {
    mockExecFileSuccess(JSON.stringify({
      title: 'T', body: '', state: 'OPEN',
      url: 'https://github.com/o/r/issues/1',
      author: { login: 'u' }, labels: [],
    }));
    await githubFetchTicket('99', '/myproj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'view', '99', '--json', 'title,body,state,url,author,labels'],
      expect.objectContaining({ cwd: '/myproj' }),
      expect.any(Function)
    );
  });

  it('returns null on gh failure', async () => {
    mockExecFileError('repository not found');
    const result = await githubFetchTicket('1', '/proj');
    expect(result).toBeNull();
  });
});

describe('githubUpdateTicket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls gh issue edit with the body', async () => {
    mockExecFileSuccess('');
    await githubUpdateTicket('42', 'updated body', '/proj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '42', '--body', 'updated body'],
      expect.objectContaining({ cwd: '/proj' }),
      expect.any(Function)
    );
  });

  it('throws a meaningful error on gh failure', async () => {
    mockExecFileError('authentication failed');
    await expect(githubUpdateTicket('1', 'body', '/proj')).rejects.toThrow(/gh issue edit failed.*authentication failed/);
  });
});

describe('githubCreateTicket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns url and ticketId parsed from gh output', async () => {
    mockExecFileSuccess('https://github.com/org/repo/issues/99\n');
    const result = await githubCreateTicket('My Title', 'My Body', '/proj');
    expect(result.url).toBe('https://github.com/org/repo/issues/99');
    expect(result.ticketId).toBe('99');
  });

  it('throws when no URL is in output', async () => {
    mockExecFileSuccess('draft saved, not published');
    await expect(githubCreateTicket('t', 'b', '/proj')).rejects.toThrow(/Could not parse/);
  });

  it('calls gh issue create with title and body', async () => {
    mockExecFileSuccess('https://github.com/o/r/issues/1\n');
    await githubCreateTicket('New Issue', 'Description here', '/myproj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--title', 'New Issue', '--body', 'Description here'],
      expect.objectContaining({ cwd: '/myproj' }),
      expect.any(Function)
    );
  });
});

// ---------------------------------------------------------------------------
// Jira (mocked at the http/https module boundary)
// ---------------------------------------------------------------------------

function mockJiraRequest(responseBody: string, statusCode = 200) {
  const mockRequest = {
    on: vi.fn().mockReturnThis(),
    write: vi.fn(),
    end: vi.fn(),
    setTimeout: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  };
  const mockResponse = {
    statusCode,
    on: vi.fn((event: string, handler: Function) => {
      if (event === 'data') handler(responseBody);
      if (event === 'end') handler();
    }),
  };
  mockHttpsRequest.mockImplementation((_opts: unknown, callback?: Function) => {
    if (callback) callback(mockResponse);
    return mockRequest as unknown as ReturnType<typeof https.request>;
  });
  return mockRequest;
}

describe('jiraFetchTicket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when jira_url is missing', async () => {
    const cfg: ProjectTicketConfig = { provider: 'jira' };
    expect(await jiraFetchTicket('ACME-1', cfg)).toBeNull();
  });

  it('returns null when jira_api_token is missing', async () => {
    const cfg: ProjectTicketConfig = { ...JIRA_CONFIG, jira_api_token: null };
    expect(await jiraFetchTicket('ACME-1', cfg)).toBeNull();
  });

  it('returns formatted markdown from Jira API response', async () => {
    mockJiraRequest(JSON.stringify({
      key: 'ACME-42',
      fields: {
        summary: 'Fix the Jira bug',
        description: 'Bug description here.',
        status: { name: 'In Progress' },
        issuetype: { name: 'Story' },
        reporter: { displayName: 'Alice' },
        assignee: { displayName: 'Bob' },
        labels: ['backend', 'urgent'],
        comment: { comments: [] },
      },
    }));

    const result = await jiraFetchTicket('ACME-42', JIRA_CONFIG);

    expect(result).toContain('# Issue: Fix the Jira bug');
    expect(result).toContain('State: In Progress');
    expect(result).toContain('@Alice');
    expect(result).toContain('Bob');
    expect(result).toContain('Labels: backend, urgent');
    expect(result).toContain('Bug description here.');
  });

  it('returns null on HTTP error (throws internally)', async () => {
    mockJiraRequest('Unauthorized', 401);
    const result = await jiraFetchTicket('ACME-1', JIRA_CONFIG);
    expect(result).toBeNull();
  });
});

describe('jiraUpdateTicket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when credentials are missing', async () => {
    const cfg: ProjectTicketConfig = { provider: 'jira' };
    await expect(jiraUpdateTicket('ACME-1', 'body', cfg)).rejects.toThrow(/credentials are missing/);
  });

  it('sends PUT request with correct body', async () => {
    const req = mockJiraRequest('');
    await jiraUpdateTicket('ACME-1', 'updated desc', JIRA_CONFIG);
    expect(req.write).toHaveBeenCalledWith(
      expect.stringContaining('"description":"updated desc"')
    );
  });
});

describe('jiraCreateTicket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when project key is missing', async () => {
    const cfg: ProjectTicketConfig = { ...JIRA_CONFIG, jira_project_key: null };
    await expect(jiraCreateTicket('t', 'b', cfg)).rejects.toThrow(/project key are missing/);
  });

  it('returns url and ticketId from Jira response', async () => {
    mockJiraRequest(JSON.stringify({ key: 'ACME-123', self: 'https://acme.atlassian.net/rest/api/2/issue/12345' }));
    const result = await jiraCreateTicket('New story', 'Body here', JIRA_CONFIG);
    expect(result.ticketId).toBe('ACME-123');
    expect(result.url).toBe('https://acme.atlassian.net/browse/ACME-123');
  });
});

// ---------------------------------------------------------------------------
// Provider-neutral dispatch
// ---------------------------------------------------------------------------

describe('fetchTicketWithConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes to github for GitHub config', async () => {
    mockExecFileSuccess(JSON.stringify({
      title: 'T', body: 'B', state: 'OPEN',
      url: 'https://github.com/o/r/issues/1',
      author: { login: 'u' }, labels: [],
    }));
    const result = await fetchTicketWithConfig('1', GITHUB_CONFIG, '/proj');
    expect(result).toContain('# Issue: T');
    expect(mockExecFile).toHaveBeenCalled();
  });

  it('routes to jira for Jira config', async () => {
    mockJiraRequest(JSON.stringify({
      key: 'ACME-1',
      fields: {
        summary: 'Jira ticket', description: '', status: { name: 'Open' },
        issuetype: { name: 'Task' }, reporter: { displayName: 'X' },
        assignee: null, labels: [], comment: { comments: [] },
      },
    }));
    const result = await fetchTicketWithConfig('ACME-1', JIRA_CONFIG, '/proj');
    expect(result).toContain('# Issue: Jira ticket');
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('updateTicketWithConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when ticketId is empty', async () => {
    await expect(updateTicketWithConfig('  ', 'body', GITHUB_CONFIG, '/proj')).rejects.toThrow(/Ticket ID is required/);
  });

  it('rejects when body is empty', async () => {
    await expect(updateTicketWithConfig('1', '  ', GITHUB_CONFIG, '/proj')).rejects.toThrow(/body cannot be empty/);
  });
});

describe('createTicketWithConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when title is empty', async () => {
    await expect(createTicketWithConfig({ title: '  ', body: 'b', config: GITHUB_CONFIG, cwd: '/proj' })).rejects.toThrow(/title is required/);
  });

  it('rejects when body is empty', async () => {
    await expect(createTicketWithConfig({ title: 't', body: '', config: GITHUB_CONFIG, cwd: '/proj' })).rejects.toThrow(/body is required/);
  });
});

// ---------------------------------------------------------------------------
// Listing (backlog board)
// ---------------------------------------------------------------------------

describe('githubListTickets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps gh issue list JSON into TicketListEntry[]', async () => {
    mockExecFileSuccess(JSON.stringify([
      { number: 42, title: 'Fix the bug', author: { login: 'alice' } },
      { number: 7, title: 'Add feature', author: { login: 'bob' } },
    ]));

    const result = await githubListTickets('/proj');

    expect(result).toEqual({
      ok: true,
      tickets: [
        { id: '42', title: 'Fix the bug', author: 'alice' },
        { id: '7', title: 'Add feature', author: 'bob' },
      ],
    });
  });

  it('invokes gh with @me open-issue args and no label filter by default', async () => {
    mockExecFileSuccess('[]');
    await githubListTickets('/myproj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'list', '--author', '@me', '--state', 'open', '--json', 'number,title,author', '--limit', '100'],
      expect.objectContaining({ cwd: '/myproj' }),
      expect.any(Function),
    );
  });

  it('appends --label when a label is provided', async () => {
    mockExecFileSuccess('[]');
    await githubListTickets('/proj', 'needs-spec');
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--label');
    expect(args).toContain('needs-spec');
  });

  it('tolerates a missing author login', async () => {
    mockExecFileSuccess(JSON.stringify([{ number: 1, title: 'Orphan', author: null }]));
    const result = await githubListTickets('/proj');
    expect(result).toEqual({ ok: true, tickets: [{ id: '1', title: 'Orphan', author: '' }] });
  });

  it('returns ok:false with network error when gh fails (graceful degradation)', async () => {
    mockExecFileError('gh not authenticated');
    const result = await githubListTickets('/proj');
    expect(result).toEqual({ ok: false, error: { reason: 'network', message: 'Failed to fetch GitHub tickets' } });
  });

  it('returns ok:false with network error on unparseable output', async () => {
    mockExecFileSuccess('not json');
    const result = await githubListTickets('/proj');
    expect(result).toEqual({ ok: false, error: { reason: 'network', message: 'Failed to fetch GitHub tickets' } });
  });
});

describe('jiraListTickets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ok:false with missing-creds error when credentials are missing', async () => {
    const cfg: ProjectTicketConfig = { provider: 'jira' };
    expect(await jiraListTickets(cfg)).toEqual({ ok: false, error: { reason: 'missing-creds' } });
  });

  it('maps Jira search results into TicketListEntry[]', async () => {
    mockJiraRequest(JSON.stringify({
      issues: [
        { key: 'ACME-42', fields: { summary: 'Fix Jira bug', reporter: { accountId: 'acc-1' } } },
        { key: 'ACME-7', fields: { summary: 'Add Jira feature', reporter: { displayName: 'Bob' } } },
      ],
    }));

    const result = await jiraListTickets(JIRA_CONFIG);

    expect(result).toEqual({
      ok: true,
      tickets: [
        { id: 'ACME-42', title: 'Fix Jira bug', author: 'acc-1' },
        { id: 'ACME-7', title: 'Add Jira feature', author: 'Bob' },
      ],
    });
  });

  it('returns ok:false with http-status error on HTTP 401', async () => {
    mockJiraRequest('Unauthorized', 401);
    const result = await jiraListTickets(JIRA_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('http-status');
      expect((result.error as { reason: 'http-status'; status: number }).status).toBe(401);
    }
  });

  it('returns ok:false with http-status error on HTTP 403', async () => {
    mockJiraRequest('Forbidden', 403);
    const result = await jiraListTickets(JIRA_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('http-status');
      expect((result.error as { reason: 'http-status'; status: number }).status).toBe(403);
    }
  });

  it('returns ok:false with network error on timeout', async () => {
    const mockRequest = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'error') {
          setTimeout(() => handler(new Error('Jira API request timed out')), 0);
        }
        return mockRequest;
      }),
      write: vi.fn(),
      end: vi.fn(),
      setTimeout: vi.fn().mockReturnThis(),
      destroy: vi.fn(),
    };
    mockHttpsRequest.mockImplementation(() => mockRequest as unknown as ReturnType<typeof https.request>);
    const result = await jiraListTickets(JIRA_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('network');
    }
  });

  it('returns ok:true with empty tickets array when JQL matches zero results', async () => {
    mockJiraRequest(JSON.stringify({ issues: [] }));
    const result = await jiraListTickets(JIRA_CONFIG);
    expect(result).toEqual({ ok: true, tickets: [] });
  });

  it('uses /rest/api/3/search/jql endpoint (not /rest/api/2/search)', async () => {
    mockJiraRequest(JSON.stringify({ issues: [] }));
    await jiraListTickets(JIRA_CONFIG);
    const opts = mockHttpsRequest.mock.calls[0][0] as { path: string };
    expect(opts.path).toMatch(/^\/rest\/api\/3\/search\/jql/);
    expect(opts.path).not.toMatch(/\/rest\/api\/2\/search/);
  });
});

describe('listTicketsWithConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes to github for GitHub config', async () => {
    mockExecFileSuccess(JSON.stringify([{ number: 1, title: 'T', author: { login: 'u' } }]));
    const result = await listTicketsWithConfig(GITHUB_CONFIG, '/proj');
    expect(result).toEqual({ ok: true, tickets: [{ id: '1', title: 'T', author: 'u' }] });
    expect(mockExecFile).toHaveBeenCalled();
  });

  it('routes to jira for Jira config', async () => {
    mockJiraRequest(JSON.stringify({ issues: [{ key: 'ACME-1', fields: { summary: 'J', reporter: { accountId: 'a' } } }] }));
    const result = await listTicketsWithConfig(JIRA_CONFIG, '/proj');
    expect(result).toEqual({ ok: true, tickets: [{ id: 'ACME-1', title: 'J', author: 'a' }] });
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Raw body fetch
// ---------------------------------------------------------------------------

describe('githubFetchRawBody', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the raw issue body without any wrapper', async () => {
    mockExecFileSuccess(JSON.stringify({ body: 'Just the raw description.' }));
    const result = await githubFetchRawBody('42', '/proj');
    expect(result).toBe('Just the raw description.');
    expect(result).not.toMatch(/^# Issue:/);
    expect(result).not.toMatch(/^State:/m);
  });

  it('returns empty string when body is null', async () => {
    mockExecFileSuccess(JSON.stringify({ body: null }));
    const result = await githubFetchRawBody('42', '/proj');
    expect(result).toBe('');
  });

  it('calls gh with --json body only', async () => {
    mockExecFileSuccess(JSON.stringify({ body: 'body text' }));
    await githubFetchRawBody('99', '/myproj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'view', '99', '--json', 'body'],
      expect.objectContaining({ cwd: '/myproj' }),
      expect.any(Function)
    );
  });

  it('returns null on gh failure', async () => {
    mockExecFileError('not found');
    const result = await githubFetchRawBody('1', '/proj');
    expect(result).toBeNull();
  });
});

describe('jiraFetchRawBody', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when credentials are missing', async () => {
    const cfg: ProjectTicketConfig = { provider: 'jira' };
    expect(await jiraFetchRawBody('ACME-1', cfg)).toBeNull();
  });

  it('returns the raw description field without wrapper', async () => {
    mockJiraRequest(JSON.stringify({ fields: { description: 'Raw Jira body text.' } }));
    const result = await jiraFetchRawBody('ACME-42', JIRA_CONFIG);
    expect(result).toBe('Raw Jira body text.');
    expect(result).not.toMatch(/^# Issue:/);
    expect(result).not.toMatch(/^State:/m);
  });

  it('returns empty string when description is null', async () => {
    mockJiraRequest(JSON.stringify({ fields: { description: null } }));
    const result = await jiraFetchRawBody('ACME-1', JIRA_CONFIG);
    expect(result).toBe('');
  });

  it('returns null on HTTP error', async () => {
    mockJiraRequest('Unauthorized', 401);
    const result = await jiraFetchRawBody('ACME-1', JIRA_CONFIG);
    expect(result).toBeNull();
  });
});

describe('fetchRawBodyWithConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes to github for GitHub config', async () => {
    mockExecFileSuccess(JSON.stringify({ body: 'GitHub raw body' }));
    const result = await fetchRawBodyWithConfig('42', GITHUB_CONFIG, '/proj');
    expect(result).toBe('GitHub raw body');
    expect(mockExecFile).toHaveBeenCalled();
  });

  it('routes to jira for Jira config', async () => {
    mockJiraRequest(JSON.stringify({ fields: { description: 'Jira raw body' } }));
    const result = await fetchRawBodyWithConfig('ACME-1', JIRA_CONFIG, '/proj');
    expect(result).toBe('Jira raw body');
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('updateTicketWithConfig routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes GitHub → githubUpdateTicket', async () => {
    mockExecFileSuccess('');
    await updateTicketWithConfig('42', 'updated body', GITHUB_CONFIG, '/proj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'edit', '42', '--body', 'updated body'],
      expect.objectContaining({ cwd: '/proj' }),
      expect.any(Function)
    );
  });

  it('rejects empty ticketId', async () => {
    await expect(updateTicketWithConfig('', 'body', GITHUB_CONFIG, '/proj')).rejects.toThrow('Ticket ID is required');
  });

  it('rejects empty body', async () => {
    await expect(updateTicketWithConfig('42', '   ', GITHUB_CONFIG, '/proj')).rejects.toThrow('Ticket body cannot be empty');
  });
});

// ---------------------------------------------------------------------------
// jiraRequest structured error + testJiraConnection
// ---------------------------------------------------------------------------

describe('jiraRequest structured rejection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('jiraListTickets carries http-status error with status and body on HTTP >= 400', async () => {
    mockJiraRequest('{"errorMessages":["Issue Does Not Exist"]}', 404);
    const result = await jiraListTickets(JIRA_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('http-status');
      expect((result.error as { reason: 'http-status'; status: number; body?: string }).status).toBe(404);
      expect((result.error as { reason: 'http-status'; status: number; body?: string }).body).toContain('errorMessages');
    }
  });
});

describe('testJiraConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns auth ok with displayName on successful myself ping', async () => {
    // First call: myself, Second call: search
    let callCount = 0;
    mockHttpsRequest.mockImplementation((_opts: unknown, callback?: Function) => {
      callCount++;
      const body = callCount === 1
        ? JSON.stringify({ displayName: 'Alice Smith' })
        : JSON.stringify({ issues: [{}, {}, {}] });
      const mockResponse = {
        statusCode: 200,
        on: vi.fn((event: string, handler: Function) => {
          if (event === 'data') handler(body);
          if (event === 'end') handler();
        }),
      };
      const mockReq = { on: vi.fn().mockReturnThis(), write: vi.fn(), end: vi.fn(), setTimeout: vi.fn().mockReturnThis(), destroy: vi.fn() };
      if (callback) callback(mockResponse);
      return mockReq as unknown as ReturnType<typeof https.request>;
    });

    const result = await testJiraConnection({
      jiraUrl: 'https://acme.atlassian.net',
      jiraUsername: 'user@acme.com',
      jiraApiToken: 'token123',
    });

    expect(result.auth.ok).toBe(true);
    if (result.auth.ok) {
      expect(result.auth.displayName).toBe('Alice Smith');
    }
    expect(result.jql).not.toBeNull();
    if (result.jql && result.jql.ok) {
      expect(result.jql.count).toBe(3);
      expect(result.jql.hasMore).toBe(false);
    }
  });

  it('returns auth fail and jql:null when myself ping returns 401', async () => {
    mockJiraRequest('Unauthorized', 401);
    const result = await testJiraConnection({
      jiraUrl: 'https://acme.atlassian.net',
      jiraUsername: 'bad@acme.com',
      jiraApiToken: 'wrong',
    });

    expect(result.auth.ok).toBe(false);
    if (!result.auth.ok) {
      expect(result.auth.status).toBe(401);
    }
    expect(result.jql).toBeNull();
  });

  it('returns auth ok and jql count:0 when JQL returns empty', async () => {
    let callCount = 0;
    mockHttpsRequest.mockImplementation((_opts: unknown, callback?: Function) => {
      callCount++;
      const body = callCount === 1
        ? JSON.stringify({ displayName: 'Bob' })
        : JSON.stringify({ issues: [] });
      const mockResponse = {
        statusCode: 200,
        on: vi.fn((event: string, handler: Function) => {
          if (event === 'data') handler(body);
          if (event === 'end') handler();
        }),
      };
      const mockReq = { on: vi.fn().mockReturnThis(), write: vi.fn(), end: vi.fn(), setTimeout: vi.fn().mockReturnThis(), destroy: vi.fn() };
      if (callback) callback(mockResponse);
      return mockReq as unknown as ReturnType<typeof https.request>;
    });

    const result = await testJiraConnection({
      jiraUrl: 'https://acme.atlassian.net',
      jiraUsername: 'user@acme.com',
      jiraApiToken: 'token',
    });

    expect(result.auth.ok).toBe(true);
    if (result.jql && result.jql.ok) {
      expect(result.jql.count).toBe(0);
    }
  });

  it('returns auth ok and jql fail when JQL returns 400', async () => {
    let callCount = 0;
    mockHttpsRequest.mockImplementation((_opts: unknown, callback?: Function) => {
      callCount++;
      const statusCode = callCount === 1 ? 200 : 400;
      const body = callCount === 1
        ? JSON.stringify({ displayName: 'Carol' })
        : 'Bad JQL';
      const mockResponse = {
        statusCode,
        on: vi.fn((event: string, handler: Function) => {
          if (event === 'data') handler(body);
          if (event === 'end') handler();
        }),
      };
      const mockReq = { on: vi.fn().mockReturnThis(), write: vi.fn(), end: vi.fn(), setTimeout: vi.fn().mockReturnThis(), destroy: vi.fn() };
      if (callback) callback(mockResponse);
      return mockReq as unknown as ReturnType<typeof https.request>;
    });

    const result = await testJiraConnection({
      jiraUrl: 'https://acme.atlassian.net',
      jiraUsername: 'user@acme.com',
      jiraApiToken: 'token',
    });

    expect(result.auth.ok).toBe(true);
    expect(result.jql).not.toBeNull();
    if (result.jql) {
      expect(result.jql.ok).toBe(false);
    }
  });

  it('uses /rest/api/3/search/jql endpoint for JQL search (not /rest/api/2/search)', async () => {
    let callCount = 0;
    mockHttpsRequest.mockImplementation((_opts: unknown, callback?: Function) => {
      callCount++;
      const body = callCount === 1
        ? JSON.stringify({ displayName: 'Dave' })
        : JSON.stringify({ issues: [] });
      const mockResponse = {
        statusCode: 200,
        on: vi.fn((event: string, handler: Function) => {
          if (event === 'data') handler(body);
          if (event === 'end') handler();
        }),
      };
      const mockReq = { on: vi.fn().mockReturnThis(), write: vi.fn(), end: vi.fn(), setTimeout: vi.fn().mockReturnThis(), destroy: vi.fn() };
      if (callback) callback(mockResponse);
      return mockReq as unknown as ReturnType<typeof https.request>;
    });
    await testJiraConnection({
      jiraUrl: 'https://acme.atlassian.net',
      jiraUsername: 'user@acme.com',
      jiraApiToken: 'token',
    });
    // Second call is the JQL search — check its path
    const searchOpts = mockHttpsRequest.mock.calls[1][0] as { path: string };
    expect(searchOpts.path).toMatch(/^\/rest\/api\/3\/search\/jql/);
    expect(searchOpts.path).not.toMatch(/\/rest\/api\/2\/search/);
  });

  it('reports count from issues.length when response omits total', async () => {
    let callCount = 0;
    mockHttpsRequest.mockImplementation((_opts: unknown, callback?: Function) => {
      callCount++;
      const body = callCount === 1
        ? JSON.stringify({ displayName: 'Eve' })
        : JSON.stringify({ issues: [{}, {}] }); // no total field
      const mockResponse = {
        statusCode: 200,
        on: vi.fn((event: string, handler: Function) => {
          if (event === 'data') handler(body);
          if (event === 'end') handler();
        }),
      };
      const mockReq = { on: vi.fn().mockReturnThis(), write: vi.fn(), end: vi.fn(), setTimeout: vi.fn().mockReturnThis(), destroy: vi.fn() };
      if (callback) callback(mockResponse);
      return mockReq as unknown as ReturnType<typeof https.request>;
    });
    const result = await testJiraConnection({
      jiraUrl: 'https://acme.atlassian.net',
      jiraUsername: 'user@acme.com',
      jiraApiToken: 'token',
    });
    expect(result.jql?.ok).toBe(true);
    if (result.jql?.ok) {
      expect(result.jql.count).toBe(2);
      expect(result.jql.hasMore).toBe(false);
    }
  });

  it('sets hasMore:true when response contains nextPageToken', async () => {
    let callCount = 0;
    mockHttpsRequest.mockImplementation((_opts: unknown, callback?: Function) => {
      callCount++;
      const body = callCount === 1
        ? JSON.stringify({ displayName: 'Frank' })
        : JSON.stringify({ issues: new Array(100).fill({}), nextPageToken: 'abc123' });
      const mockResponse = {
        statusCode: 200,
        on: vi.fn((event: string, handler: Function) => {
          if (event === 'data') handler(body);
          if (event === 'end') handler();
        }),
      };
      const mockReq = { on: vi.fn().mockReturnThis(), write: vi.fn(), end: vi.fn(), setTimeout: vi.fn().mockReturnThis(), destroy: vi.fn() };
      if (callback) callback(mockResponse);
      return mockReq as unknown as ReturnType<typeof https.request>;
    });
    const result = await testJiraConnection({
      jiraUrl: 'https://acme.atlassian.net',
      jiraUsername: 'user@acme.com',
      jiraApiToken: 'token',
    });
    expect(result.jql?.ok).toBe(true);
    if (result.jql?.ok) {
      expect(result.jql.count).toBe(100);
      expect(result.jql.hasMore).toBe(true);
    }
  });

});

// ---------------------------------------------------------------------------
// githubCloseTicket (#446)
// ---------------------------------------------------------------------------

describe('githubCloseTicket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls gh issue close with the ticket id', async () => {
    mockExecFileSuccess('');
    await githubCloseTicket('42', '/proj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'close', '42'],
      expect.objectContaining({ cwd: '/proj' }),
      expect.any(Function)
    );
  });

  it('resolves when gh succeeds', async () => {
    mockExecFileSuccess('');
    await expect(githubCloseTicket('42', '/proj')).resolves.toBeUndefined();
  });

  it('resolves when issue is already closed (stderr contains already closed)', async () => {
    const err = Object.assign(new Error('Command failed'), { stderr: 'Issue is already closed.' });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(err, '', 'Issue is already closed.');
      return {} as ReturnType<typeof import('child_process').execFile>;
    });
    await expect(githubCloseTicket('42', '/proj')).resolves.toBeUndefined();
  });

  it('throws a meaningful error on genuine gh failure', async () => {
    mockExecFileError('authentication failed');
    await expect(githubCloseTicket('42', '/proj')).rejects.toThrow(/gh issue close failed.*authentication failed/);
  });
});

// ---------------------------------------------------------------------------
// jiraCloseTicket (#446)
// ---------------------------------------------------------------------------

describe('jiraCloseTicket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when credentials are missing', async () => {
    const cfg: ProjectTicketConfig = { provider: 'jira' };
    await expect(jiraCloseTicket('ACME-1', cfg)).rejects.toThrow(/credentials are missing/);
  });

  it('sends PUT request to the archive endpoint', async () => {
    const req = mockJiraRequest('', 204);
    await jiraCloseTicket('ACME-42', JIRA_CONFIG);
    expect(req.end).toHaveBeenCalled();
    // Check that the URL path used was the archive endpoint
    expect(mockHttpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('/archive') }),
      expect.any(Function)
    );
  });

  it('resolves on 204 success', async () => {
    mockJiraRequest('', 204);
    await expect(jiraCloseTicket('ACME-42', JIRA_CONFIG)).resolves.toBeUndefined();
  });

  it('resolves when already archived (body contains already archived)', async () => {
    const mockRequest = {
      on: vi.fn().mockReturnThis(),
      write: vi.fn(),
      end: vi.fn(),
      setTimeout: vi.fn().mockReturnThis(),
      destroy: vi.fn(),
    };
    const mockResponse = {
      statusCode: 400,
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'data') handler('{"errorMessages":["Issue is already archived"]}');
        if (event === 'end') handler();
      }),
    };
    mockHttpsRequest.mockImplementation((_opts: unknown, callback?: Function) => {
      if (callback) callback(mockResponse);
      return mockRequest as unknown as ReturnType<typeof import('https').request>;
    });
    await expect(jiraCloseTicket('ACME-42', JIRA_CONFIG)).resolves.toBeUndefined();
  });

  it('rejects when archive returns a genuine error (e.g. 403 Forbidden)', async () => {
    mockJiraRequest('Forbidden: archive not available on your plan', 403);
    await expect(jiraCloseTicket('ACME-42', JIRA_CONFIG)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// closeTicketWithConfig (#446)
// ---------------------------------------------------------------------------

describe('closeTicketWithConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes GitHub → githubCloseTicket', async () => {
    mockExecFileSuccess('');
    await closeTicketWithConfig('42', GITHUB_CONFIG, '/proj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'close', '42'],
      expect.objectContaining({ cwd: '/proj' }),
      expect.any(Function)
    );
  });

  it('routes JIRA → jiraCloseTicket (archive endpoint)', async () => {
    mockJiraRequest('', 204);
    await closeTicketWithConfig('ACME-42', JIRA_CONFIG, '/proj');
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockHttpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('/archive') }),
      expect.any(Function)
    );
  });

  it('resolves when GitHub issue is already closed', async () => {
    const err = Object.assign(new Error('Command failed'), { stderr: 'Issue is already closed.' });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(err, '', 'Issue is already closed.');
      return {} as ReturnType<typeof import('child_process').execFile>;
    });
    await expect(closeTicketWithConfig('42', GITHUB_CONFIG, '/proj')).resolves.toBeUndefined();
  });

  it('rejects on genuine GitHub failure', async () => {
    mockExecFileError('repository not found');
    await expect(closeTicketWithConfig('42', GITHUB_CONFIG, '/proj')).rejects.toThrow(/gh issue close failed/);
  });

  it('rejects on JIRA archive failure', async () => {
    mockJiraRequest('Forbidden', 403);
    await expect(closeTicketWithConfig('ACME-42', JIRA_CONFIG, '/proj')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// jiraTransitionToDone
// ---------------------------------------------------------------------------

describe('jiraTransitionToDone', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when Jira credentials are missing', async () => {
    const cfg: ProjectTicketConfig = { provider: 'jira' };
    await expect(jiraTransitionToDone('ACME-1', cfg)).rejects.toThrow('Jira credentials are missing');
  });

  it('(a) prefers a transition whose target name is "Done" (case-insensitive)', async () => {
    const mockReq = mockJiraRequest(JSON.stringify({
      transitions: [
        { id: '10', to: { name: "Won't Do", statusCategory: { key: 'done' } } },
        { id: '20', to: { name: 'DONE', statusCategory: { key: 'done' } } },
        { id: '30', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
      ],
    }));
    await jiraTransitionToDone('ACME-1', JIRA_CONFIG);
    const posted = mockReq.write.mock.calls[0]?.[0] as string;
    expect(JSON.parse(posted)).toMatchObject({ transition: { id: '20' } });
  });

  it('(b) falls back to done-category transition excluding won\'t-do/cancel/reject', async () => {
    const mockReq = mockJiraRequest(JSON.stringify({
      transitions: [
        { id: '10', to: { name: "Won't Do", statusCategory: { key: 'done' } } },
        { id: '11', to: { name: 'Cancelled', statusCategory: { key: 'done' } } },
        { id: '12', to: { name: 'Closed', statusCategory: { key: 'done' } } },
      ],
    }));
    await jiraTransitionToDone('ACME-1', JIRA_CONFIG);
    const posted = mockReq.write.mock.calls[0]?.[0] as string;
    const body = JSON.parse(posted);
    expect(body).toMatchObject({ transition: { id: '12' } });
    expect(body.transition.id).not.toBe('10');
    expect(body.transition.id).not.toBe('11');
  });

  it('(c) resolves successfully when transitions list is empty (issue already Done — idempotent)', async () => {
    mockJiraRequest(JSON.stringify({ transitions: [] }));
    await expect(jiraTransitionToDone('ACME-1', JIRA_CONFIG)).resolves.toBeUndefined();
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1); // only the GET, no POST
  });

  it('(e) throws gracefully when only Won\'t Do / Cancelled / Rejected transitions are available', async () => {
    mockJiraRequest(JSON.stringify({
      transitions: [
        { id: '10', to: { name: "Won't Do", statusCategory: { key: 'done' } } },
        { id: '11', to: { name: 'Cancelled', statusCategory: { key: 'done' } } },
        { id: '12', to: { name: 'Rejected', statusCategory: { key: 'done' } } },
      ],
    }));
    await expect(jiraTransitionToDone('ACME-1', JIRA_CONFIG)).rejects.toThrow(
      'No eligible Done transition found',
    );
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1); // no POST attempted
  });

  it('POSTs to /rest/api/2 transitions endpoint (not v3 archive)', async () => {
    mockJiraRequest(JSON.stringify({
      transitions: [{ id: '5', to: { name: 'Done', statusCategory: { key: 'done' } } }],
    }));
    await jiraTransitionToDone('ACME-1', JIRA_CONFIG);
    const calls = mockHttpsRequest.mock.calls;
    // Both GET and POST should use /rest/api/2/...
    for (const call of calls) {
      expect((call[0] as { path: string }).path).toContain('/rest/api/2/');
      expect((call[0] as { path: string }).path).not.toContain('/rest/api/3/');
      expect((call[0] as { path: string }).path).not.toContain('/archive');
    }
  });
});

// ---------------------------------------------------------------------------
// markTicketDoneWithConfig
// ---------------------------------------------------------------------------

describe('markTicketDoneWithConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes GitHub → gh issue close (NOT archive)', async () => {
    mockExecFileSuccess('');
    await markTicketDoneWithConfig('42', GITHUB_CONFIG, '/proj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'close', '42'],
      expect.objectContaining({ cwd: '/proj' }),
      expect.any(Function),
    );
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('routes Jira → jiraTransitionToDone (NOT jiraCloseTicket / archive)', async () => {
    mockJiraRequest(JSON.stringify({
      transitions: [{ id: '5', to: { name: 'Done', statusCategory: { key: 'done' } } }],
    }));
    await markTicketDoneWithConfig('ACME-1', JIRA_CONFIG, '/proj');
    expect(mockExecFile).not.toHaveBeenCalled();
    // Should NOT call the archive endpoint
    const archiveCalls = mockHttpsRequest.mock.calls.filter(
      (c) => (c[0] as { path: string }).path?.includes('/archive'),
    );
    expect(archiveCalls).toHaveLength(0);
    // Should call the transitions endpoint
    const transitionCalls = mockHttpsRequest.mock.calls.filter(
      (c) => (c[0] as { path: string }).path?.includes('/transitions'),
    );
    expect(transitionCalls.length).toBeGreaterThan(0);
  });

  it('regression: merge path must close ticket (not skip as old code did)', async () => {
    mockExecFileSuccess('');
    // GitHub merge path — closing ticket must be called
    await markTicketDoneWithConfig('42', GITHUB_CONFIG, '/proj');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'close', '42'],
      expect.any(Object),
      expect.any(Function),
    );
  });
});
