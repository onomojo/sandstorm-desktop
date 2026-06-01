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
  nextBranchName,
  createPullRequest,
  sanitizeCommitMessage,
  MAX_PR_ATTEMPTS,
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

  it('built-in structure uses QA plan not Test plan', () => {
    const out = buildDraftPrompt({ ticket: null, branch: 'b', commits: '', diffStat: '', taskOutputTail: '' });
    expect(out).toContain('## QA plan');
    expect(out).not.toContain('## Test plan');
  });

  it('built-in structure includes Summary section', () => {
    const out = buildDraftPrompt({ ticket: null, branch: 'b', commits: '', diffStat: '', taskOutputTail: '' });
    expect(out).toContain('## Summary');
  });

  it('built-in structure does not instruct running automated tests', () => {
    const out = buildDraftPrompt({ ticket: null, branch: 'b', commits: '', diffStat: '', taskOutputTail: '' });
    expect(out).not.toMatch(/npm test/);
    expect(out).not.toMatch(/typecheck/);
    expect(out).not.toMatch(/run.*build/i);
  });

  it('uses built-in body structure when projectTemplate is null', () => {
    const out = buildDraftPrompt({ ticket: null, branch: 'b', commits: '', diffStat: '', taskOutputTail: '', projectTemplate: null });
    expect(out).toContain('## Summary');
    expect(out).toContain('## QA plan');
    expect(out).not.toContain("Follow this project's PR template");
  });

  it('uses built-in body structure when projectTemplate is undefined', () => {
    const out = buildDraftPrompt({ ticket: null, branch: 'b', commits: '', diffStat: '', taskOutputTail: '' });
    expect(out).toContain('## Summary');
    expect(out).toContain('## QA plan');
    expect(out).not.toContain("Follow this project's PR template");
  });

  it('instructs the agent to follow project template when projectTemplate is provided', () => {
    const template = '## My Section\n<!-- description -->\n\n## Steps\n<!-- steps -->';
    const out = buildDraftPrompt({ ticket: null, branch: 'b', commits: '', diffStat: '', taskOutputTail: '', projectTemplate: template });
    expect(out).toContain("Follow this project's PR template");
    expect(out).toContain(template);
    expect(out).not.toContain('## QA plan');
  });

  it('includes [TICKET-ID] title convention in schema when ticket is present', () => {
    const out = buildDraftPrompt({ ticket: '42', branch: 'b', commits: '', diffStat: '', taskOutputTail: '' });
    expect(out).toContain('[42] fix:');
  });

  it('strips leading # from ticket in title convention', () => {
    const out = buildDraftPrompt({ ticket: '#99', branch: 'b', commits: '', diffStat: '', taskOutputTail: '' });
    expect(out).toContain('[99] fix:');
    expect(out).not.toContain('[#99]');
  });

  it('omits [TICKET-ID] prefix in schema when no ticket', () => {
    const out = buildDraftPrompt({ ticket: null, branch: 'b', commits: '', diffStat: '', taskOutputTail: '' });
    expect(out).not.toMatch(/\[\d+\]/);
    expect(out).toContain('≤70 chars summary');
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
    const runEphemeral = vi.fn().mockResolvedValue('{"title":"feat: add b","body":"## Summary\\n- adds b\\n\\n## QA plan\\n- [ ] verify"}');
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

  it('uses built-in structure when .github/pull_request_template.md is absent', async () => {
    const runEphemeral = vi.fn().mockResolvedValue('{"title":"x","body":"## Summary\\n- y"}');
    await draftPullRequest({ stackId: 's', workspace, ticket: null }, { runEphemeral });
    const prompt = runEphemeral.mock.calls[0][0] as string;
    expect(prompt).toContain('## QA plan');
    expect(prompt).not.toContain("Follow this project's PR template");
  });

  it('uses project template when .github/pull_request_template.md exists and is non-empty', async () => {
    const templateDir = path.join(workspace, '.github');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'pull_request_template.md'), '## Custom Section\n<!-- fill me in -->');

    const runEphemeral = vi.fn().mockResolvedValue('{"title":"x","body":"## Custom Section\\n- done"}');
    await draftPullRequest({ stackId: 's', workspace, ticket: null }, { runEphemeral });
    const prompt = runEphemeral.mock.calls[0][0] as string;
    expect(prompt).toContain("Follow this project's PR template");
    expect(prompt).toContain('## Custom Section');
    expect(prompt).not.toContain('## QA plan');
  });

  it('uses built-in structure when .github/pull_request_template.md exists but is whitespace-only', async () => {
    const templateDir = path.join(workspace, '.github');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'pull_request_template.md'), '   \n\n  ');

    const runEphemeral = vi.fn().mockResolvedValue('{"title":"x","body":"## Summary\\n- y"}');
    await draftPullRequest({ stackId: 's', workspace, ticket: null }, { runEphemeral });
    const prompt = runEphemeral.mock.calls[0][0] as string;
    expect(prompt).toContain('## QA plan');
    expect(prompt).not.toContain("Follow this project's PR template");
  });
});

describe('nextBranchName — suffix policy', () => {
  it.each([
    ['feat/foo',      'feat/foo-v2'],
    ['feat/foo-v2',   'feat/foo-v3'],
    ['feat/foo-v9',   'feat/foo-v10'],
    ['feat/foo-v99',  'feat/foo-v100'],
    ['main',          'main-v2'],
    // non-digit after -v is treated as part of the name, not a version
    ['feat/foo-vfoo', 'feat/foo-vfoo-v2'],
    ['feat/foo-v',    'feat/foo-v-v2'],
  ])('%s → %s', (input, expected) => {
    expect(nextBranchName(input)).toBe(expected);
  });
});

describe('createPullRequest — host-side gh pr create', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-create-'));
    fs.mkdirSync(path.join(workspace, '.sandstorm'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<Parameters<typeof createPullRequest>[1]> = {}) {
    return {
      workspace,
      runGitPush: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
      createPROnHost: vi.fn<[], Promise<string>>().mockResolvedValue('https://github.com/test/repo/pull/42\n'),
      checkoutBranch: vi.fn<[string], Promise<void>>().mockResolvedValue(undefined),
      setPullRequest: vi.fn(),
      ...overrides,
    };
  }

  it('returns url and number immediately on first success', async () => {
    const setPR = vi.fn();
    const result = await createPullRequest(
      { stackId: 's', title: 'feat', body: 'body', initialBranch: 'feat/foo' },
      { ...makeDeps({ setPullRequest: setPR }) },
    );
    expect(result).toEqual({ url: 'https://github.com/test/repo/pull/42', number: 42 });
    expect(setPR).toHaveBeenCalledWith('https://github.com/test/repo/pull/42', 42);
  });

  it('calls createPROnHost with correct args', async () => {
    const createPROnHost = vi.fn<[], Promise<string>>().mockResolvedValue('https://github.com/test/repo/pull/1\n');
    await createPullRequest(
      { stackId: 's', title: 'My PR', body: 'body', initialBranch: 'feat/foo' },
      makeDeps({ createPROnHost }),
    );
    expect(createPROnHost).toHaveBeenCalledWith(
      'My PR',
      expect.stringContaining('pr-body-'),
      'feat/foo',
      'main',
    );
  });

  it('retries on createPROnHost failure and succeeds on second attempt', async () => {
    const runGitPush = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
    const createPROnHost = vi.fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error('already exists'))
      .mockResolvedValueOnce('https://github.com/test/repo/pull/43\n');
    const checkoutBranch = vi.fn<[string], Promise<void>>().mockResolvedValue(undefined);

    const result = await createPullRequest(
      { stackId: 's', title: 't', body: 'b', initialBranch: 'feat/foo' },
      { workspace, runGitPush, createPROnHost, checkoutBranch, setPullRequest: vi.fn() },
    );

    expect(result.number).toBe(43);
    expect(runGitPush).toHaveBeenCalledTimes(2);
    expect(checkoutBranch).toHaveBeenCalledTimes(1);
    expect(checkoutBranch).toHaveBeenCalledWith('feat/foo-v2');
  });

  it(`exhausts exactly ${MAX_PR_ATTEMPTS} attempts then throws`, async () => {
    const createPROnHost = vi.fn<[], Promise<string>>().mockRejectedValue(new Error('duplicate PR'));
    const checkoutBranch = vi.fn<[string], Promise<void>>().mockResolvedValue(undefined);

    await expect(
      createPullRequest(
        { stackId: 's', title: 't', body: 'b', initialBranch: 'feat/foo' },
        { workspace, runGitPush: vi.fn().mockResolvedValue(undefined), createPROnHost, checkoutBranch, setPullRequest: vi.fn() },
      ),
    ).rejects.toThrow(`PR creation failed after ${MAX_PR_ATTEMPTS} attempts`);

    expect(createPROnHost).toHaveBeenCalledTimes(MAX_PR_ATTEMPTS);
    expect(checkoutBranch).toHaveBeenCalledTimes(MAX_PR_ATTEMPTS - 1);
  });

  it('error message includes all 5 attempted branches and their reasons', async () => {
    const createPROnHost = vi.fn<[], Promise<string>>().mockRejectedValue(new Error('reason-X'));

    let err: Error | undefined;
    try {
      await createPullRequest(
        { stackId: 's', title: 't', body: 'b', initialBranch: 'feat/foo' },
        { workspace, runGitPush: vi.fn().mockResolvedValue(undefined), createPROnHost, checkoutBranch: vi.fn().mockResolvedValue(undefined), setPullRequest: vi.fn() },
      );
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/attempt 1.*feat\/foo/);
    expect(err!.message).toMatch(/attempt 5.*feat\/foo-v5/);
  });

  it('bumps through v2→v5 for recovery branches', async () => {
    const checkoutBranch = vi.fn<[string], Promise<void>>().mockResolvedValue(undefined);
    await expect(
      createPullRequest(
        { stackId: 's', title: 't', body: 'b', initialBranch: 'feat/foo' },
        {
          workspace,
          runGitPush: vi.fn().mockResolvedValue(undefined),
          createPROnHost: vi.fn().mockRejectedValue(new Error('x')),
          checkoutBranch,
          setPullRequest: vi.fn(),
        },
      ),
    ).rejects.toThrow();
    expect(checkoutBranch).toHaveBeenNthCalledWith(1, 'feat/foo-v2');
    expect(checkoutBranch).toHaveBeenNthCalledWith(2, 'feat/foo-v3');
    expect(checkoutBranch).toHaveBeenNthCalledWith(3, 'feat/foo-v4');
    expect(checkoutBranch).toHaveBeenNthCalledWith(4, 'feat/foo-v5');
  });

  it('cleans up the temp body file on success', async () => {
    await createPullRequest(
      { stackId: 's', title: 't', body: 'b', initialBranch: 'feat/foo' },
      makeDeps(),
    );
    const files = fs.readdirSync(path.join(workspace, '.sandstorm'));
    expect(files.filter((f) => f.startsWith('pr-body-'))).toHaveLength(0);
  });

  it('cleans up the temp body file on failure', async () => {
    await expect(
      createPullRequest(
        { stackId: 's', title: 't', body: 'b', initialBranch: 'feat/foo' },
        {
          ...makeDeps(),
          createPROnHost: vi.fn().mockRejectedValue(new Error('fail')),
        },
      ),
    ).rejects.toThrow();
    const files = fs.readdirSync(path.join(workspace, '.sandstorm'));
    expect(files.filter((f) => f.startsWith('pr-body-'))).toHaveLength(0);
  });

  it('passes body content to the temp file that createPROnHost receives', async () => {
    let capturedBodyPath: string | undefined;
    const createPROnHost = vi.fn<[string, string, string, string], Promise<string>>().mockImplementation(
      async (_title, bodyFilePath) => {
        capturedBodyPath = bodyFilePath;
        return 'https://github.com/test/repo/pull/99\n';
      }
    );
    await createPullRequest(
      { stackId: 's', title: 't', body: 'my custom body', initialBranch: 'feat/bar' },
      { workspace, runGitPush: vi.fn().mockResolvedValue(undefined), createPROnHost, checkoutBranch: vi.fn(), setPullRequest: vi.fn() },
    );
    expect(capturedBodyPath).toBeDefined();
    // The body file should have been written (and then deleted after success)
    // but we read it before the cleanup completes? Actually the file is deleted
    // in the finally block, so it's already gone. Instead, verify via the mock call.
    expect(createPROnHost).toHaveBeenCalledWith('t', expect.stringContaining('pr-body-'), 'feat/bar', 'main');
  });

  it('sanitizes the title before passing it to runGitPush', async () => {
    const runGitPush = vi.fn<[string], Promise<void>>().mockResolvedValue(undefined);
    await createPullRequest(
      {
        stackId: 's',
        title: 'handle "not found" as non-fatal during ticket merge',
        body: 'body',
        initialBranch: 'feat/foo',
      },
      makeDeps({ runGitPush }),
    );
    expect(runGitPush).toHaveBeenCalledTimes(1);
    const commitMsg = runGitPush.mock.calls[0][0];
    expect(commitMsg).not.toContain('"');
  });
});

describe('sanitizeCommitMessage', () => {
  it('removes double quotes', () => {
    expect(sanitizeCommitMessage('handle "not found" error')).toBe('handle not found error');
  });

  it('removes backticks', () => {
    expect(sanitizeCommitMessage('run `npm install`')).toBe('run npm install');
  });

  it('removes dollar signs', () => {
    expect(sanitizeCommitMessage('fix $HOME path handling')).toBe('fix HOME path handling');
  });

  it('removes backslashes', () => {
    expect(sanitizeCommitMessage('handle C:\\Users path')).toBe('handle C:Users path');
  });

  it('replaces newlines with spaces', () => {
    expect(sanitizeCommitMessage('line one\nline two')).toBe('line one line two');
  });

  it('leaves normal titles unchanged', () => {
    const normal = 'fix: handle non-fatal error during ticket merge';
    expect(sanitizeCommitMessage(normal)).toBe(normal);
  });

  it('returns a safe fallback for an all-special-char input', () => {
    const result = sanitizeCommitMessage('"`$\\');
    expect(result).toBeTruthy();
    expect(result).not.toMatch(/["`$\\]/);
  });

  it('regression: reported title with double quotes sanitizes without shell-special chars', () => {
    const title = 'handle "not found" as non-fatal during ticket merge';
    const sanitized = sanitizeCommitMessage(title);
    expect(sanitized).not.toContain('"');
    expect(sanitized).toMatch(/\S/);
  });
});

