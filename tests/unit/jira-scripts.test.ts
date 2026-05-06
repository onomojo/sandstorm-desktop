import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPTS_DIR = path.resolve(__dirname, '../../sandstorm-cli/templates/jira/scripts');

interface RouteEntry {
  method: string;
  urlContains: string;
  status: number;
  body: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

class CurlStub {
  readonly dir: string;
  readonly routesFile: string;
  readonly logFile: string;

  constructor(dir: string) {
    this.dir = dir;
    this.routesFile = path.join(dir, 'routes.json');
    this.logFile = path.join(dir, 'curl.log');
    this.writeShim();
    fs.writeFileSync(this.routesFile, '[]');
  }

  private writeShim() {
    const shimPath = path.join(this.dir, 'curl');
    // Shim parses curl args, logs requests as JSON lines, returns canned responses.
    // Route matching: bind each route as $r so .urlContains resolves on the route
    // object, not on the $url string context. Default-route handled in bash to
    // avoid nested-quote issues in the jq filter string.
    const shim = [
      '#!/bin/bash',
      'ROUTES_FILE="${CURL_ROUTES_FILE}"',
      'LOG_FILE="${CURL_LOG_FILE}"',
      'METHOD="GET"',
      'URL=""',
      'DATA=""',
      '',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -X) METHOD="$2"; shift 2 ;;',
      '    -d) DATA="$2"; shift 2 ;;',
      '    -u|-H|-w) shift 2 ;;',
      '    -s) shift ;;',
      '    http*) URL="$1"; shift ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      '',
      'jq -cn --arg method "$METHOD" --arg url "$URL" --arg data "$DATA" \'{"method":$method,"url":$url,"data":$data}\' >> "$LOG_FILE"',
      '',
      'ROUTE=$(jq -c --arg method "$METHOD" --arg url "$URL" \'',
      '  map(. as $r | select(',
      '    ($r.method == $method or $r.method == "*") and',
      '    ($url | contains($r.urlContains))',
      '  )) | .[0]',
      '\' "$ROUTES_FILE")',
      '',
      'if [ -z "$ROUTE" ] || [ "$ROUTE" = "null" ]; then',
      '  printf \'%s\\n%s\\n\' \'\' \'404\'',
      '  exit 0',
      'fi',
      '',
      'STATUS=$(printf \'%s\' "$ROUTE" | jq -r \'.status\')',
      'BODY=$(printf \'%s\' "$ROUTE" | jq -r \'.body\')',
      '',
      'printf \'%s\\n%s\\n\' "$BODY" "$STATUS"',
    ].join('\n') + '\n';
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });
  }

  setRoutes(routes: RouteEntry[]) {
    fs.writeFileSync(this.routesFile, JSON.stringify(routes));
    if (fs.existsSync(this.logFile)) fs.unlinkSync(this.logFile);
  }

  env(): Record<string, string> {
    return {
      CURL_ROUTES_FILE: this.routesFile,
      CURL_LOG_FILE: this.logFile,
    };
  }

  getLog(): Array<{ method: string; url: string; data: string }> {
    if (!fs.existsSync(this.logFile)) return [];
    return fs.readFileSync(this.logFile, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; url: string; data: string });
  }
}

function runScript(
  scriptName: string,
  args: string[],
  env: Record<string, string>,
  curlBinDir: string,
): Promise<RunResult> {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath, ...args],
      {
        env: {
          PATH: `${curlBinDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          ...env,
        },
        timeout: 10000,
      },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: (err as NodeJS.ErrnoException & { code?: number } | null)?.code ?? 0,
        });
      },
    );
  });
}

const VALID_ENV = {
  JIRA_URL: 'https://test.atlassian.net',
  JIRA_USERNAME: 'user@example.com',
  JIRA_API_TOKEN: 'secret-token',
};

const ISSUE_RESPONSE = JSON.stringify({
  fields: {
    summary: 'Test issue summary',
    description: 'This is the description.',
    status: { name: 'Open' },
    labels: ['bug', 'urgent'],
    reporter: { displayName: 'John Doe', emailAddress: 'john@example.com', name: 'johndoe' },
    created: '2024-01-15T10:30:00.000+0000',
    comment: {
      comments: [
        {
          author: { displayName: 'Jane Smith' },
          created: '2024-01-16T09:00:00.000+0000',
          body: 'This is a comment.',
        },
      ],
    },
  },
});

const TRANSITIONS_RESPONSE = JSON.stringify({
  transitions: [
    { id: '10', name: 'To Do' },
    { id: '21', name: 'In Progress' },
    { id: '31', name: 'Done' },
  ],
});

const MYSELF_RESPONSE = JSON.stringify({ accountId: 'acc-xyz-123' });

let tmpDir: string;
let stub: CurlStub;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-test-'));
  stub = new CurlStub(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fetch-ticket.sh
// ---------------------------------------------------------------------------

describe('fetch-ticket.sh', () => {
  it('exits 1 with usage message when ticket id is missing', async () => {
    const result = await runScript('fetch-ticket.sh', [], VALID_ENV, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });

  it('exits 1 and names missing JIRA_URL', async () => {
    const { JIRA_URL: _, ...env } = VALID_ENV;
    const result = await runScript('fetch-ticket.sh', ['PROJ-123'], env, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('JIRA_URL');
    expect(result.stderr).toContain('restart the desktop app');
  });

  it('exits 1 and names missing JIRA_USERNAME', async () => {
    const { JIRA_USERNAME: _, ...env } = VALID_ENV;
    const result = await runScript('fetch-ticket.sh', ['PROJ-123'], env, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('JIRA_USERNAME');
  });

  it('exits 1 and names missing JIRA_API_TOKEN', async () => {
    const { JIRA_API_TOKEN: _, ...env } = VALID_ENV;
    const result = await runScript('fetch-ticket.sh', ['PROJ-123'], env, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('JIRA_API_TOKEN');
  });

  it('lists all missing vars when multiple are unset', async () => {
    const result = await runScript('fetch-ticket.sh', ['PROJ-123'], {}, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('JIRA_URL');
    expect(result.stderr).toContain('JIRA_USERNAME');
    expect(result.stderr).toContain('JIRA_API_TOKEN');
  });

  it('rejects JIRA_URL containing a REST path', async () => {
    const env = { ...VALID_ENV, JIRA_URL: 'https://test.atlassian.net/rest/api/2' };
    const result = await runScript('fetch-ticket.sh', ['PROJ-123'], env, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('site root');
  });

  it('normalises JIRA_URL trailing slash (no double-slashes in request)', async () => {
    stub.setRoutes([{ method: 'GET', urlContains: '/rest/api/2/issue/PROJ-123', status: 200, body: ISSUE_RESPONSE }]);
    const env = { ...VALID_ENV, JIRA_URL: 'https://test.atlassian.net/', ...stub.env() };
    const result = await runScript('fetch-ticket.sh', ['PROJ-123'], env, tmpDir);
    expect(result.exitCode).toBe(0);
    const log = stub.getLog();
    expect(log[0].url).not.toContain('//rest');
  });

  it('emits standardized markdown for a populated ticket', async () => {
    stub.setRoutes([{ method: 'GET', urlContains: '/rest/api/2/issue/PROJ-123', status: 200, body: ISSUE_RESPONSE }]);
    const result = await runScript('fetch-ticket.sh', ['PROJ-123'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('# Issue: Test issue summary');
    expect(result.stdout).toContain('Labels: bug, urgent');
    expect(result.stdout).toContain('State: Open');
    expect(result.stdout).toContain('Author: @John Doe');
    expect(result.stdout).toContain('Created: 2024-01-15T10:30:00.000+0000');
    expect(result.stdout).toContain('## Description');
    expect(result.stdout).toContain('This is the description.');
    expect(result.stdout).toContain('## Comments');
    expect(result.stdout).toContain('### @Jane Smith — 2024-01-16T09:00:00.000+0000');
    expect(result.stdout).toContain('This is a comment.');
  });

  it('omits Labels line when there are no labels', async () => {
    const noLabels = JSON.stringify({
      fields: {
        summary: 'No labels',
        description: 'desc',
        status: { name: 'Open' },
        labels: [],
        reporter: { displayName: 'Alice' },
        created: '2024-01-01T00:00:00.000+0000',
        comment: { comments: [] },
      },
    });
    stub.setRoutes([{ method: 'GET', urlContains: '/rest/api/2/issue/PROJ-1', status: 200, body: noLabels }]);
    const result = await runScript('fetch-ticket.sh', ['PROJ-1'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Labels:');
  });

  it('omits Comments section when there are no comments', async () => {
    const noComments = JSON.stringify({
      fields: {
        summary: 'No comments',
        description: 'desc',
        status: { name: 'Open' },
        labels: [],
        reporter: { displayName: 'Alice' },
        created: '2024-01-01T00:00:00.000+0000',
        comment: { comments: [] },
      },
    });
    stub.setRoutes([{ method: 'GET', urlContains: '/rest/api/2/issue/PROJ-2', status: 200, body: noComments }]);
    const result = await runScript('fetch-ticket.sh', ['PROJ-2'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('## Comments');
  });

  it('reporter falls back: displayName → emailAddress → name → "unknown"', async () => {
    const makeIssue = (reporter: Record<string, string | undefined>) =>
      JSON.stringify({
        fields: {
          summary: 'Fallback test',
          description: 'desc',
          status: { name: 'Open' },
          labels: [],
          reporter,
          created: '2024-01-01T00:00:00.000+0000',
          comment: { comments: [] },
        },
      });

    // emailAddress fallback
    stub.setRoutes([{ method: 'GET', urlContains: '/rest/api/2/issue/PROJ-3', status: 200, body: makeIssue({ emailAddress: 'email@example.com' }) }]);
    let result = await runScript('fetch-ticket.sh', ['PROJ-3'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.stdout).toContain('Author: @email@example.com');

    // name fallback
    stub.setRoutes([{ method: 'GET', urlContains: '/rest/api/2/issue/PROJ-3', status: 200, body: makeIssue({ name: 'jdoe' }) }]);
    result = await runScript('fetch-ticket.sh', ['PROJ-3'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.stdout).toContain('Author: @jdoe');

    // unknown fallback
    stub.setRoutes([{ method: 'GET', urlContains: '/rest/api/2/issue/PROJ-3', status: 200, body: makeIssue({}) }]);
    result = await runScript('fetch-ticket.sh', ['PROJ-3'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.stdout).toContain('Author: @unknown');
  });

  it('exits 1 and reports HTTP error on non-2xx response', async () => {
    stub.setRoutes([{ method: 'GET', urlContains: '/rest/api/2/issue/PROJ-404', status: 404, body: '{"errorMessages":["Issue does not exist."]}' }]);
    const result = await runScript('fetch-ticket.sh', ['PROJ-404'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('404');
  });

  it('hits v2 endpoint with basic auth', async () => {
    stub.setRoutes([{ method: 'GET', urlContains: '/rest/api/2/issue/PROJ-123', status: 200, body: ISSUE_RESPONSE }]);
    await runScript('fetch-ticket.sh', ['PROJ-123'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    const log = stub.getLog();
    expect(log[0].url).toContain('/rest/api/2/issue/PROJ-123');
  });
});

// ---------------------------------------------------------------------------
// start-ticket.sh
// ---------------------------------------------------------------------------

describe('start-ticket.sh', () => {
  const startRoutes: RouteEntry[] = [
    { method: 'GET', urlContains: '/transitions', status: 200, body: TRANSITIONS_RESPONSE },
    { method: 'POST', urlContains: '/transitions', status: 204, body: '' },
    { method: 'GET', urlContains: '/myself', status: 200, body: MYSELF_RESPONSE },
    { method: 'PUT', urlContains: '/assignee', status: 204, body: '' },
  ];

  it('exits 1 with usage message when ticket id is missing', async () => {
    const result = await runScript('start-ticket.sh', [], VALID_ENV, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });

  it('exits 1 and names missing env vars', async () => {
    const result = await runScript('start-ticket.sh', ['PROJ-123'], {}, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('JIRA_URL');
    expect(result.stderr).toContain('JIRA_USERNAME');
    expect(result.stderr).toContain('JIRA_API_TOKEN');
    expect(result.stderr).toContain('restart the desktop app');
  });

  it('rejects JIRA_URL with REST path', async () => {
    const env = { ...VALID_ENV, JIRA_URL: 'https://test.atlassian.net/rest/api/2' };
    const result = await runScript('start-ticket.sh', ['PROJ-123'], env, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('site root');
  });

  it('executes transition + myself + assignee sequence on success', async () => {
    stub.setRoutes(startRoutes);
    const result = await runScript('start-ticket.sh', ['PROJ-123'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Transitioned PROJ-123 to In Progress');
    expect(result.stdout).toContain('Assigned PROJ-123');

    const log = stub.getLog();
    expect(log[0]).toMatchObject({ method: 'GET', url: expect.stringContaining('/transitions') });
    expect(log[1]).toMatchObject({ method: 'POST', url: expect.stringContaining('/transitions') });
    expect(log[2]).toMatchObject({ method: 'GET', url: expect.stringContaining('/myself') });
    expect(log[3]).toMatchObject({ method: 'PUT', url: expect.stringContaining('/assignee') });
  });

  it('sends correct transition id in POST body', async () => {
    stub.setRoutes(startRoutes);
    await runScript('start-ticket.sh', ['PROJ-123'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    const log = stub.getLog();
    const postEntry = log.find((e) => e.method === 'POST' && e.url.includes('/transitions'));
    expect(postEntry?.data).toContain('"id":"21"');
  });

  it('sends correct accountId in assignee PUT body', async () => {
    stub.setRoutes(startRoutes);
    await runScript('start-ticket.sh', ['PROJ-123'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    const log = stub.getLog();
    const putEntry = log.find((e) => e.method === 'PUT' && e.url.includes('/assignee'));
    expect(putEntry?.data).toContain('acc-xyz-123');
  });

  it('matches "In Progress" case-insensitively', async () => {
    const lowerCaseTransitions = JSON.stringify({
      transitions: [{ id: '99', name: 'in progress' }],
    });
    stub.setRoutes([
      { method: 'GET', urlContains: '/transitions', status: 200, body: lowerCaseTransitions },
      { method: 'POST', urlContains: '/transitions', status: 204, body: '' },
      { method: 'GET', urlContains: '/myself', status: 200, body: MYSELF_RESPONSE },
      { method: 'PUT', urlContains: '/assignee', status: 204, body: '' },
    ]);
    const result = await runScript('start-ticket.sh', ['PROJ-123'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(0);
  });

  it('matches fuzzy "Start Progress" transition name', async () => {
    const startProgressTransitions = JSON.stringify({
      transitions: [{ id: '77', name: 'Start Progress' }],
    });
    stub.setRoutes([
      { method: 'GET', urlContains: '/transitions', status: 200, body: startProgressTransitions },
      { method: 'POST', urlContains: '/transitions', status: 204, body: '' },
      { method: 'GET', urlContains: '/myself', status: 200, body: MYSELF_RESPONSE },
      { method: 'PUT', urlContains: '/assignee', status: 204, body: '' },
    ]);
    const result = await runScript('start-ticket.sh', ['PROJ-123'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(0);
  });

  it('exits 1 with available transitions when no progress-like option exists', async () => {
    const noProgressTransitions = JSON.stringify({
      transitions: [
        { id: '1', name: 'To Do' },
        { id: '2', name: 'Done' },
      ],
    });
    stub.setRoutes([{ method: 'GET', urlContains: '/transitions', status: 200, body: noProgressTransitions }]);
    const result = await runScript('start-ticket.sh', ['PROJ-123'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('In Progress');
    expect(result.stderr).toContain('To Do');
    expect(result.stderr).toContain('Done');
  });

  it('exits 0 with warning when assignment fails (partial success)', async () => {
    stub.setRoutes([
      { method: 'GET', urlContains: '/transitions', status: 200, body: TRANSITIONS_RESPONSE },
      { method: 'POST', urlContains: '/transitions', status: 204, body: '' },
      { method: 'GET', urlContains: '/myself', status: 200, body: MYSELF_RESPONSE },
      { method: 'PUT', urlContains: '/assignee', status: 403, body: '{"errorMessages":["Not allowed"]}' },
    ]);
    const result = await runScript('start-ticket.sh', ['PROJ-123'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Warning');
    expect(result.stdout).toContain('Transitioned');
  });

  it('exits 0 with warning when myself call fails (partial success)', async () => {
    stub.setRoutes([
      { method: 'GET', urlContains: '/transitions', status: 200, body: TRANSITIONS_RESPONSE },
      { method: 'POST', urlContains: '/transitions', status: 204, body: '' },
      { method: 'GET', urlContains: '/myself', status: 401, body: '{}' },
    ]);
    const result = await runScript('start-ticket.sh', ['PROJ-123'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Warning');
  });
});

// ---------------------------------------------------------------------------
// update-ticket.sh
// ---------------------------------------------------------------------------

describe('update-ticket.sh', () => {
  it('exits 1 with usage when ticket id is missing', async () => {
    const result = await runScript('update-ticket.sh', [], VALID_ENV, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });

  it('exits 1 with usage when body is missing', async () => {
    const result = await runScript('update-ticket.sh', ['PROJ-123'], VALID_ENV, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });

  it('exits 1 and names all missing env vars', async () => {
    const result = await runScript('update-ticket.sh', ['PROJ-123', 'body text'], {}, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('JIRA_URL');
    expect(result.stderr).toContain('JIRA_USERNAME');
    expect(result.stderr).toContain('JIRA_API_TOKEN');
    expect(result.stderr).toContain('restart the desktop app');
  });

  it('rejects JIRA_URL with REST path', async () => {
    const env = { ...VALID_ENV, JIRA_URL: 'https://test.atlassian.net/rest/api/2' };
    const result = await runScript('update-ticket.sh', ['PROJ-123', 'body'], env, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('site root');
  });

  it('PUTs to v2 issue endpoint and exits 0 on success', async () => {
    stub.setRoutes([{ method: 'PUT', urlContains: '/rest/api/2/issue/PROJ-123', status: 204, body: '' }]);
    const result = await runScript('update-ticket.sh', ['PROJ-123', 'Updated body'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Updated PROJ-123');

    const log = stub.getLog();
    expect(log[0]).toMatchObject({ method: 'PUT', url: expect.stringContaining('/rest/api/2/issue/PROJ-123') });
    expect(log[0].data).toContain('"description"');
    expect(log[0].data).toContain('Updated body');
  });

  it('round-trips multi-line body with quotes and backslashes', async () => {
    stub.setRoutes([{ method: 'PUT', urlContains: '/rest/api/2/issue/PROJ-123', status: 204, body: '' }]);
    const body = 'Line 1\nLine 2 with "quotes"\nLine 3 with \\backslash\\';
    const result = await runScript('update-ticket.sh', ['PROJ-123', body], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(0);

    const log = stub.getLog();
    // The jq --arg encoding should preserve the body correctly as valid JSON
    const parsed = JSON.parse(log[0].data) as { fields: { description: string } };
    expect(parsed.fields.description).toBe(body);
  });

  it('exits 1 and reports HTTP error on non-2xx response', async () => {
    stub.setRoutes([{ method: 'PUT', urlContains: '/rest/api/2/issue/PROJ-123', status: 400, body: '{"errorMessages":["Field error."]}' }]);
    const result = await runScript('update-ticket.sh', ['PROJ-123', 'body'], { ...VALID_ENV, ...stub.env() }, tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('400');
  });
});
