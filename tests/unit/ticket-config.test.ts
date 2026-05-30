import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'child_process';
import {
  githubFetchTicket,
  githubUpdateTicket,
  githubCreateTicket,
  githubListTickets,
  jiraFetchTicket,
  jiraUpdateTicket,
  jiraCreateTicket,
  jiraListTickets,
  fetchTicketWithConfig,
  updateTicketWithConfig,
  createTicketWithConfig,
  listTicketsWithConfig,
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

  it('returns ok:false when gh fails (graceful degradation)', async () => {
    mockExecFileError('gh not authenticated');
    const result = await githubListTickets('/proj');
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:false on unparseable output', async () => {
    mockExecFileSuccess('not json');
    const result = await githubListTickets('/proj');
    expect(result).toEqual({ ok: false });
  });
});

describe('jiraListTickets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ok:false when credentials are missing', async () => {
    const cfg: ProjectTicketConfig = { provider: 'jira' };
    expect(await jiraListTickets(cfg)).toEqual({ ok: false });
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

  it('returns ok:false on HTTP error', async () => {
    mockJiraRequest('Unauthorized', 401);
    expect(await jiraListTickets(JIRA_CONFIG)).toEqual({ ok: false });
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
