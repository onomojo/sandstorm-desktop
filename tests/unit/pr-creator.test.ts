import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  buildDraftPrompt,
  parseDraftResponse,
  workspacePathFor,
  draftPullRequest,
  PR_BODY_MAX_BYTES,
  PR_TITLE_MAX_CHARS,
} from '../../src/main/control-plane/pr-creator';

describe('workspacePathFor', () => {
  it('joins projectDir + .sandstorm/workspaces + stackId', () => {
    expect(workspacePathFor('/p', 'foo')).toBe('/p/.sandstorm/workspaces/foo');
  });
});

describe('buildDraftPrompt', () => {
  it('includes the branch, commits, diff stat, and task tail', () => {
    const out = buildDraftPrompt({
      ticket: '42',
      branch: 'feat/something',
      commits: 'commit message text',
      diffStat: ' src/foo.ts | 10 +-',
      taskOutputTail: 'last log lines',
    });
    expect(out).toContain('"feat/something"');
    expect(out).toContain('commit message text');
    expect(out).toContain('src/foo.ts');
    expect(out).toContain('last log lines');
    expect(out).toContain('Closes #42');
  });

  it('strips a leading # from the ticket id', () => {
    const out = buildDraftPrompt({
      ticket: '#310',
      branch: 'b',
      commits: '',
      diffStat: '',
      taskOutputTail: '',
    });
    expect(out).toContain('Closes #310');
    expect(out).not.toContain('Closes ##310');
  });

  it('omits the Closes line when no ticket is given', () => {
    const out = buildDraftPrompt({
      ticket: null,
      branch: 'b',
      commits: '',
      diffStat: '',
      taskOutputTail: '',
    });
    expect(out).not.toMatch(/Closes #/);
  });

  it('mentions the body byte cap', () => {
    const out = buildDraftPrompt({ ticket: null, branch: 'b', commits: '', diffStat: '', taskOutputTail: '' });
    expect(out).toContain(`${PR_BODY_MAX_BYTES} bytes`);
  });
});

describe('parseDraftResponse', () => {
  it('parses a clean JSON response', () => {
    const r = parseDraftResponse('{"title":"hi","body":"## Summary\\n- ok"}');
    expect(r.title).toBe('hi');
    expect(r.body).toBe('## Summary\n- ok');
  });

  it('strips ```json fences', () => {
    const r = parseDraftResponse('```json\n{"title":"x","body":"y"}\n```');
    expect(r.title).toBe('x');
  });

  it('extracts JSON from surrounding prose', () => {
    const r = parseDraftResponse('Sure!\n{"title":"a","body":"b"}\n');
    expect(r.title).toBe('a');
    expect(r.body).toBe('b');
  });

  it('throws when no JSON is found', () => {
    expect(() => parseDraftResponse('not json')).toThrow(/did not contain JSON/);
  });

  it('throws when title or body is missing', () => {
    expect(() => parseDraftResponse('{"title":"x"}')).toThrow(/missing title or body/);
  });

  it('throws when title is empty', () => {
    expect(() => parseDraftResponse('{"title":"","body":"b"}')).toThrow(/title was empty/);
  });

  it('throws when body exceeds the byte cap', () => {
    const big = 'a'.repeat(PR_BODY_MAX_BYTES + 100);
    expect(() => parseDraftResponse(JSON.stringify({ title: 'x', body: big }))).toThrow(/exceeds.*bytes/);
  });

  it('truncates titles longer than the char cap', () => {
    const long = 'x'.repeat(PR_TITLE_MAX_CHARS + 10);
    const r = parseDraftResponse(JSON.stringify({ title: long, body: 'b' }));
    expect(r.title.length).toBe(PR_TITLE_MAX_CHARS);
  });
});

describe('draftPullRequest', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-draft-'));
    // Init a tiny git repo with one commit on a branch off main.
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'a'), 'a');
    execFileSync('git', ['add', 'a'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: workspace });
    execFileSync('git', ['checkout', '-q', '-b', 'feat/x'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'b'), 'b');
    execFileSync('git', ['add', 'b'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'feat: add b'], { cwd: workspace });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('rejects when the workspace directory is missing', async () => {
    await expect(
      draftPullRequest(
        { stackId: 's', workspace: '/nope', ticket: null },
        { runEphemeral: vi.fn() },
      ),
    ).rejects.toThrow(/workspace not found/);
  });

  it('calls the ephemeral agent with a prompt that mentions the branch and commit', async () => {
    const runEphemeral = vi.fn().mockResolvedValue('{"title":"feat: add b","body":"## Summary\\n- adds b\\n\\n## Test plan\\n- [ ] verify"}');
    const drafted = await draftPullRequest(
      { stackId: 's', workspace, ticket: '42' },
      { runEphemeral },
    );
    expect(drafted.title).toBe('feat: add b');
    expect(drafted.body).toContain('Summary');
    expect(runEphemeral).toHaveBeenCalledTimes(1);
    const promptArg = runEphemeral.mock.calls[0][0] as string;
    expect(promptArg).toContain('feat/x');
    expect(promptArg).toContain('feat: add b');
    expect(promptArg).toContain('Closes #42');
  });

  it('reuses the workspace as cwd for the ephemeral call', async () => {
    const runEphemeral = vi.fn().mockResolvedValue('{"title":"x","body":"## Summary\\n- y"}');
    await draftPullRequest({ stackId: 's', workspace, ticket: null }, { runEphemeral });
    expect(runEphemeral).toHaveBeenCalledWith(expect.any(String), workspace, expect.any(Number));
  });

  it('passes the task tail through when fetchTaskTail is provided', async () => {
    const runEphemeral = vi.fn().mockResolvedValue('{"title":"x","body":"## Summary\\n- y"}');
    const fetchTaskTail = vi.fn().mockResolvedValue('important task log');
    await draftPullRequest(
      { stackId: 's', workspace, ticket: null },
      { runEphemeral, fetchTaskTail },
    );
    expect(fetchTaskTail).toHaveBeenCalledWith('s');
    expect(runEphemeral.mock.calls[0][0]).toContain('important task log');
  });
});
