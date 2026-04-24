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
  commitAndPush,
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

describe('commitAndPush (#320)', () => {
  let originDir: string;
  let workspace: string;

  beforeEach(() => {
    // Stand up a bare "origin" repo + a cloned workspace on a feature branch
    // so we can exercise commit + push without hitting the network. We force
    // HEAD to `main` via symbolic-ref because older gits don't honor the
    // `-c init.defaultBranch=main` flag (or -b on init).
    originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-origin-'));
    execFileSync('git', ['init', '--bare', '-q'], { cwd: originDir });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: originDir });

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ws-'));
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: workspace });
    execFileSync('git', ['remote', 'add', 'origin', originDir], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'README'), 'hi');
    execFileSync('git', ['add', 'README'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: workspace });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: workspace });
    execFileSync('git', ['checkout', '-q', '-b', 'feat/x'], { cwd: workspace });
  });

  afterEach(() => {
    fs.rmSync(originDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('rejects when the workspace is missing', async () => {
    await expect(
      commitAndPush({ workspace: '/nope', commitMessage: 'x' }),
    ).rejects.toThrow(/workspace not found/);
  });

  it('commits dirty files and pushes the branch to origin', async () => {
    fs.writeFileSync(path.join(workspace, 'new-file'), 'hello');
    await commitAndPush({ workspace, commitMessage: 'feat: add new-file' });

    // Commit landed locally.
    const log = execFileSync('git', ['log', '-1', '--pretty=format:%s'], { cwd: workspace, encoding: 'utf-8' });
    expect(log).toBe('feat: add new-file');

    // Branch exists on origin.
    const remoteBranches = execFileSync('git', ['branch', '-a'], { cwd: workspace, encoding: 'utf-8' });
    expect(remoteBranches).toContain('remotes/origin/feat/x');
  });

  it('skips the commit when nothing is dirty but still pushes', async () => {
    // Make one commit on the feature branch so there is something to push,
    // but leave the working tree clean at call time.
    fs.writeFileSync(path.join(workspace, 'already-committed'), 'a');
    execFileSync('git', ['add', 'already-committed'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'pre-existing'], { cwd: workspace });

    await commitAndPush({ workspace, commitMessage: 'ignored — no dirty files' });

    // Commit count unchanged — nothing added on top of pre-existing.
    const commits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: workspace, encoding: 'utf-8' }).trim();
    expect(commits).toBe('2');

    // But the pre-existing commit did reach origin.
    const originHead = execFileSync(
      'git', ['ls-remote', 'origin', 'refs/heads/feat/x'],
      { cwd: workspace, encoding: 'utf-8' },
    ).trim();
    expect(originHead).not.toBe('');
  });

  it('is idempotent when the branch is already pushed', async () => {
    fs.writeFileSync(path.join(workspace, 'a'), 'a');
    await commitAndPush({ workspace, commitMessage: 'first' });
    // Run a second time with no new changes — should not throw.
    await expect(
      commitAndPush({ workspace, commitMessage: 'second' }),
    ).resolves.toBeUndefined();
  });

  it('uses the provided commit message', async () => {
    fs.writeFileSync(path.join(workspace, 'file'), 'x');
    await commitAndPush({ workspace, commitMessage: 'Deterministic UI polish #320' });
    const subject = execFileSync('git', ['log', '-1', '--pretty=format:%s'], { cwd: workspace, encoding: 'utf-8' });
    expect(subject).toBe('Deterministic UI polish #320');
  });

  it('falls back to a default message when the provided one is empty', async () => {
    fs.writeFileSync(path.join(workspace, 'file'), 'x');
    await commitAndPush({ workspace, commitMessage: '   ' });
    const subject = execFileSync('git', ['log', '-1', '--pretty=format:%s'], { cwd: workspace, encoding: 'utf-8' });
    expect(subject).toMatch(/Changes from Sandstorm stack/);
  });

  it('surfaces git errors with which command failed', async () => {
    // Point at a non-existent remote to force push to fail.
    execFileSync('git', ['remote', 'set-url', 'origin', '/does-not-exist'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'file'), 'x');
    await expect(
      commitAndPush({ workspace, commitMessage: 'x' }),
    ).rejects.toThrow(/git push failed/);
  });
});
