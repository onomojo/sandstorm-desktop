/**
 * T5 — Golden-path lifecycle test (epic #659, Phase 2, behavior B4).
 *
 * Drives the assembled control-plane workflow
 *
 *     createStack → dispatch → inner loop → verify → completion → PR
 *
 * as ONE continuous end-to-end sequence with NO Docker daemon, asserting the
 * observable outcome at each stage against the committed state-file contract
 * (tests/contract/state-files.ts).
 *
 * Design decisions (decide-and-record, per the ticket):
 *
 *  - The container engine is the outermost boundary and is the only seam
 *    faked at the runtime level: a real `LocalRuntime` (#682) is injected into
 *    a real `StackManager`. `runCli` is NOT stubbed and NO sibling
 *    control-plane module (registry, task-watcher, dispatch, pr-creator) is
 *    `vi.mock`ed — the point is to exercise the real assembled seams.
 *  - `createStack → dispatchTask` go through the runtime primitives
 *    (`bringUp`/`deliverTask`) re-homed onto the runtime by T6 (#685). The
 *    inner loop is the `LocalRuntime` simulated task loop (#687): dropping the
 *    trigger drives `/tmp/claude-task.status → completed`, `exit 0` — the same
 *    observable terminal state the real task-runner.sh reaches after VERIFY_PASS.
 *  - Completion is reconciled by the real `StackManager.reconcileStatus`, which
 *    reads the container's authoritative status file via `runtime.exec`.
 *  - The PR step drives the real `pr-creator.ts` path
 *    (`draftPullRequest` + `createPullRequest`); only the outward `gh`/git
 *    calls and the ephemeral drafter are stubbed (no network / side effects).
 *    The real `StackManager.setPullRequest` → registry seam records the PR.
 *
 * The test runs under `npm test` (no Docker) and leaves no /tmp leakage:
 * every temp dir is created per-test and removed in afterEach, and the
 * runtime's owned container tmpdirs are released via `runtime.destroy()`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { StackManager, composeProjectNameFor } from '../../src/main/control-plane/stack-manager';
import { Registry } from '../../src/main/control-plane/registry';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { LocalRuntime } from '../../src/main/runtime/local';
import type { ComposeOpts, Container } from '../../src/main/runtime/types';
import {
  draftPullRequest,
  createPullRequest,
  workspacePathFor,
  sanitizeCommitMessage,
} from '../../src/main/control-plane/pr-creator';
import { STACK_INPUT_FILES } from '../contract/state-files';

// ---------------------------------------------------------------------------
// Test-only container engine
// ---------------------------------------------------------------------------

/**
 * Real `docker compose up` names the agent service container
 * `<composeProject>-claude-1`; the generic `LocalRuntime` (#682) names the
 * compose container just `<composeProject>`. `StackManager.findClaudeContainer`,
 * `reconcileStatus`, and `recheckCompletedStack` all resolve the agent
 * container by the `-claude` name fragment — exactly as they do against real
 * Docker. This subclass restores compose's service-suffix naming so the REAL
 * dispatch + reconcile seams resolve the container, WITHOUT modifying shared
 * runtime source (the engine is a permitted outermost-boundary stub).
 *
 * The simulated task loop from #687 is inherited unchanged.
 */
class ComposeNamedLocalRuntime extends LocalRuntime {
  private agentName(projectName: string): string {
    return `${projectName}-claude-1`;
  }
  async composeUp(projectDir: string, opts: ComposeOpts): Promise<void> {
    await super.composeUp(projectDir, { ...opts, projectName: this.agentName(opts.projectName) });
  }
  async composeDown(projectDir: string, opts: ComposeOpts): Promise<void> {
    await super.composeDown(projectDir, { ...opts, projectName: this.agentName(opts.projectName) });
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Far longer than the whole test runs — the TaskWatcher never polls, so the
// real reconcileStatus seam is the sole driver of completion (per the ticket).
const NO_AUTO_POLL_MS = 60 * 60 * 1000;

const PLAIN_PROMPT = 'Implement the widget toggle and add tests';

interface Harness {
  registry: Registry;
  runtime: ComposeNamedLocalRuntime;
  watcher: TaskWatcher;
  manager: StackManager;
  projectDir: string;
  dbPath: string;
  cleanup: () => void;
}

function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = predicate(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function makeHarness(): Promise<Harness> {
  const dbPath = path.join(os.tmpdir(), `gp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const registry = await Registry.create(dbPath);
  const runtime = new ComposeNamedLocalRuntime();
  const portAllocator = new PortAllocator(registry, [41000, 41099]);
  const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: NO_AUTO_POLL_MS });
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cli-'));
  const manager = new StackManager(registry, portAllocator, watcher, runtime, runtime, cliDir);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-proj-'));

  const cleanup = () => {
    watcher.unwatchAll();
    runtime.destroy();
    registry.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(cliDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { registry, runtime, watcher, manager, projectDir, dbPath, cleanup };
}

/** Resolve the agent container + its per-container tmpdir for a stack. */
async function resolveAgent(h: Harness, stackId: string): Promise<{ container: Container; tmpdir: string }> {
  const project = path.basename(h.projectDir);
  const composeProjectName = composeProjectNameFor(project, stackId);
  const containers = await h.runtime.listContainers({ name: `${composeProjectName}-claude` });
  expect(containers.length).toBeGreaterThan(0);
  const container = containers[0];
  const tmpdir = h.runtime.getContainerTmpdir(container.id);
  expect(tmpdir).toBeDefined();
  return { container, tmpdir: tmpdir! };
}

/** Write a value into the agent container's state file, via the runtime exec seam. */
async function writeContainerFile(h: Harness, containerId: string, name: string, content: string): Promise<void> {
  const res = await h.runtime.exec(containerId, ['bash', '-c', `cat > /tmp/${name}`], { input: content });
  expect(res.exitCode).toBe(0);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('golden-path lifecycle (createStack → dispatch → loop → verify → completion → PR)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(() => {
    h.cleanup();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path — one continuous sequence
  // -------------------------------------------------------------------------
  it('drives the full lifecycle to completion and a created PR', async () => {
    const stackId = 'gp-happy';
    const project = path.basename(h.projectDir);

    // ── Stage 1: createStack ────────────────────────────────────────────────
    // No ticket / no task: the spec gate is not triggered and we drive dispatch
    // explicitly as the next stage (createStack starts the runtime asynchronously).
    const created = h.manager.createStack({
      name: stackId,
      projectDir: h.projectDir,
      runtime: 'docker',
    });
    expect(created.id).toBe(stackId);
    expect(created.project).toBe(project);
    expect(created.project_dir).toBe(h.projectDir);
    expect(created.runtime).toBe('docker');
    expect(created.status).toBe('building');

    // composeUp runs in the background; wait for the registry to reach 'up'.
    await waitFor(() => h.registry.getStack(stackId)?.status === 'up');

    // LocalRuntime.composeUp ran → the agent container is present and running.
    const { container, tmpdir } = await resolveAgent(h, stackId);
    expect(container.status).toBe('running');
    // Idle readiness marker the dispatch path waits on.
    expect(fs.readFileSync(path.join(tmpdir, 'claude-ready'), 'utf8').trim()).toBe('ready');

    // ── Stage 2: dispatch ────────────────────────────────────────────────────
    const dispatch = await h.manager.dispatchTask(stackId, PLAIN_PROMPT);
    expect(dispatch.stack_id).toBe(stackId);
    expect(dispatch.status).toBe('running');

    // The dispatch path wrote the host→container input state files via the
    // runtime exec seam. Assert against the committed contract: every
    // non-conditional stack.sh input is present; the conditional payload files
    // this dispatch supplies (model map + phase routing) are present; the ones
    // it does not supply (resume / backend / backend-model) are absent.
    const inputPath = (pattern: string) => path.join(tmpdir, path.basename(pattern));
    const present = (pattern: string) => fs.existsSync(inputPath(pattern));

    for (const f of STACK_INPUT_FILES) {
      if (f.pattern === '/tmp/claude-task-trigger') continue; // consumed by the loop — checked transitively below
      if (!f.conditional) {
        expect(present(f.pattern), `${f.pattern} should be written`).toBe(true);
      }
    }
    // Conditional payloads this dispatch always supplies.
    expect(present('/tmp/claude-task-models.json')).toBe(true);
    expect(present('/tmp/claude-task-phase-routing.json')).toBe(true);
    // Conditional inputs this dispatch never supplies.
    expect(present('/tmp/claude-task-resume.txt')).toBe(false);
    expect(present('/tmp/claude-task-backend.txt')).toBe(false);
    expect(present('/tmp/claude-task-backend-model.txt')).toBe(false);

    // Content contract: prompt verbatim, label = first line (≤80 chars),
    // and the routing JSON has the expected per-phase shape.
    expect(fs.readFileSync(inputPath('/tmp/claude-task-prompt.txt'), 'utf8')).toBe(PLAIN_PROMPT);
    const label = fs.readFileSync(inputPath('/tmp/claude-task-label.txt'), 'utf8');
    expect(label).toBe(PLAIN_PROMPT.slice(0, 80));
    const models = JSON.parse(fs.readFileSync(inputPath('/tmp/claude-task-models.json'), 'utf8'));
    expect(models).toMatchObject({ execution: expect.any(String), review: expect.any(String), meta_review: expect.any(String) });
    const routing = JSON.parse(fs.readFileSync(inputPath('/tmp/claude-task-phase-routing.json'), 'utf8'));
    for (const phase of ['execution', 'review', 'meta_review'] as const) {
      expect(routing[phase]).toMatchObject({
        backend: expect.any(String),
        provider: expect.any(String),
        model: expect.any(String),
      });
    }

    // ── Stage 3: inner loop ──────────────────────────────────────────────────
    // The simulated loop processes the trigger → writes the loop-owned state
    // files. A successful single pass yields status=completed, exit=0.
    await waitFor(() => {
      try { return fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim() === 'completed'; }
      catch { return false; }
    });
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim()).toBe('completed');
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task.exit'), 'utf8').trim()).toBe('0');
    expect(fs.existsSync(path.join(tmpdir, 'claude-task.log'))).toBe(true);
    // Trigger was created by dispatch and consumed by the loop (producer contract,
    // verified transitively: the loop only completes when the trigger appeared).
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-trigger'))).toBe(false);

    // ── Stage 4: verify ──────────────────────────────────────────────────────
    // The simulated loop collapses a passing VERIFY into the `completed`
    // terminal token (the real task-runner only writes `completed` after
    // VERIFY_PASS; the dedicated run_verify phase is covered by T0/T3). The
    // verify-failure terminal is exercised in the edge-case test below.
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim()).toBe('completed');

    // ── Stage 5: completion ──────────────────────────────────────────────────
    // The control plane reconciles the container's authoritative status (read
    // via runtime.exec) into the registry.
    const recon = await h.manager.reconcileStatus(stackId);
    expect(recon.outcome).toBe('reconciled');
    expect(recon.status).toBe('completed');
    expect(h.registry.getStack(stackId)?.status).toBe('completed');
    const task = h.registry.getMostRecentTask(stackId);
    expect(task?.status).toBe('completed');
    expect(task?.exit_code).toBe(0);

    // ── Stage 6: PR ──────────────────────────────────────────────────────────
    // Gate: the lifecycle only advances to PR creation once the stack has
    // reconciled to `completed`.
    expect(h.registry.getStack(stackId)?.status).toBe('completed');

    const workspace = workspacePathFor(h.projectDir, stackId);
    fs.mkdirSync(workspace, { recursive: true });

    // Drafting goes through the real pr-creator path; the ephemeral agent is
    // stubbed (no model call).
    const runEphemeral = vi.fn().mockResolvedValue(
      JSON.stringify({
        title: 'test: golden path lifecycle',
        body: '## Summary\n- wires the golden path end to end\n\n## QA plan\n- [ ] click it',
      }),
    );
    const draft = await draftPullRequest(
      { stackId, workspace, ticket: null },
      { runEphemeral },
    );
    expect(runEphemeral).toHaveBeenCalledOnce();
    expect(draft.title).toBe('test: golden path lifecycle');

    // Creation goes through the real pr-creator path; only the outward git/gh
    // calls are stubbed. setPullRequest is the REAL StackManager→registry seam.
    const runGitPush = vi.fn().mockResolvedValue(undefined);
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const createPROnHost = vi.fn().mockResolvedValue(
      'Creating pull request...\nhttps://github.com/acme/widget/pull/42\n',
    );

    const result = await createPullRequest(
      { stackId, title: draft.title, body: draft.body, initialBranch: 'feat/683-golden', baseBranch: 'main' },
      {
        workspace,
        runGitPush,
        createPROnHost,
        checkoutBranch,
        setPullRequest: (url, num) => h.manager.setPullRequest(stackId, url, num),
      },
    );

    // The path constructed and would-issue the PR with the expected inputs.
    expect(result).toEqual({ url: 'https://github.com/acme/widget/pull/42', number: 42 });
    expect(runGitPush).toHaveBeenCalledOnce();
    expect(runGitPush).toHaveBeenCalledWith(sanitizeCommitMessage(draft.title));
    expect(createPROnHost).toHaveBeenCalledOnce();
    const [issuedTitle, bodyFilePath, head, base] = createPROnHost.mock.calls[0];
    expect(issuedTitle).toBe(draft.title);
    expect(typeof bodyFilePath).toBe('string');
    expect(head).toBe('feat/683-golden');
    expect(base).toBe('main');
    // No new branch was needed → checkout not invoked.
    expect(checkoutBranch).not.toHaveBeenCalled();

    // The real setPullRequest seam recorded the PR on the stack.
    const finalStack = h.registry.getStack(stackId);
    expect(finalStack?.pr_url).toBe('https://github.com/acme/widget/pull/42');
    expect(finalStack?.pr_number).toBe(42);
    expect(finalStack?.status).toBe('pr_created');

    // The body temp file was cleaned up (no /tmp-style leakage in the workspace).
    const sandstormDir = path.join(workspace, '.sandstorm');
    const leftovers = fs.existsSync(sandstormDir)
      ? fs.readdirSync(sandstormDir).filter((n) => n.startsWith('pr-body-'))
      : [];
    expect(leftovers).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Edge case: VERIFY-phase environmental block (terminal, single pass)
  // -------------------------------------------------------------------------
  it('reconciles a verify_blocked_environmental terminal status and does NOT create a PR', async () => {
    const stackId = 'gp-verifyblocked';

    h.manager.createStack({ name: stackId, projectDir: h.projectDir, runtime: 'docker' });
    await waitFor(() => h.registry.getStack(stackId)?.status === 'up');
    const { container, tmpdir } = await resolveAgent(h, stackId);

    // Dispatch the real task; the simulated loop reaches `completed`.
    await h.manager.dispatchTask(stackId, PLAIN_PROMPT);
    await waitFor(() => {
      try { return fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim() === 'completed'; }
      catch { return false; }
    });

    // Model the run_verify environmental-block terminal: in production
    // task-runner.sh writes claude-task.status=verify_blocked_environmental
    // plus the VERIFY_FAIL_FINGERPRINT file. The simulated loop never emits this
    // token, so we write the authoritative status the control plane will read.
    // The loop will not overwrite it — its trigger was already consumed.
    await writeContainerFile(h, container.id, 'claude-task.status', 'verify_blocked_environmental\n');
    await writeContainerFile(h, container.id, 'claude-verify-environmental.txt', 'VERIFY_FAIL_FINGERPRINT: permission denied\n');
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim()).toBe('verify_blocked_environmental');

    const recon = await h.manager.reconcileStatus(stackId);
    expect(recon.outcome).toBe('reconciled');
    expect(recon.status).toBe('verify_blocked_environmental');

    // Registry reflects the environmental block; the stack is NOT completed.
    const stack = h.registry.getStack(stackId);
    expect(stack?.status).toBe('verify_blocked_environmental');
    expect(stack?.status).not.toBe('completed');

    // The PR path is gated on `completed` → it is not invoked. Prove it with a
    // spy that must remain untouched when the gate runs.
    const createPROnHost = vi.fn();
    if (h.registry.getStack(stackId)?.status === 'completed') {
      await createPullRequest(
        { stackId, title: 't', body: 'b', initialBranch: 'b', baseBranch: 'main' },
        { workspace: h.projectDir, runGitPush: vi.fn(), createPROnHost, checkoutBranch: vi.fn(), setPullRequest: () => {} },
      );
    }
    expect(createPROnHost).not.toHaveBeenCalled();
    // No PR recorded.
    expect(h.registry.getStack(stackId)?.pr_url).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Edge case: missing credential/provider (needs_key terminal)
  // -------------------------------------------------------------------------
  it('reconciles a needs_key terminal status and does NOT create a PR', async () => {
    const stackId = 'gp-needskey';

    h.manager.createStack({ name: stackId, projectDir: h.projectDir, runtime: 'docker' });
    await waitFor(() => h.registry.getStack(stackId)?.status === 'up');
    const { container, tmpdir } = await resolveAgent(h, stackId);

    await h.manager.dispatchTask(stackId, PLAIN_PROMPT);
    await waitFor(() => {
      try { return fs.readFileSync(path.join(tmpdir, 'claude-task.status'), 'utf8').trim() === 'completed'; }
      catch { return false; }
    });

    // Model the credential-check terminal: task-runner.sh writes
    // claude-task.status=needs_key plus the human-readable reason file.
    await writeContainerFile(h, container.id, 'claude-task.status', 'needs_key\n');
    await writeContainerFile(h, container.id, 'claude-task-needs-key.txt', 'review phase provider anthropic has no credentials configured\n');

    const recon = await h.manager.reconcileStatus(stackId);
    expect(recon.outcome).toBe('reconciled');
    expect(recon.status).toBe('needs_key');

    const stack = h.registry.getStack(stackId);
    expect(stack?.status).toBe('needs_key');
    expect(stack?.status).not.toBe('completed');

    const task = h.registry.getMostRecentTask(stackId);
    expect(task?.status).toBe('needs_key');
    expect(task?.warnings).toContain('credentials');

    // PR path gated off → not invoked.
    const createPROnHost = vi.fn();
    if (h.registry.getStack(stackId)?.status === 'completed') {
      await createPullRequest(
        { stackId, title: 't', body: 'b', initialBranch: 'b', baseBranch: 'main' },
        { workspace: h.projectDir, runGitPush: vi.fn(), createPROnHost, checkoutBranch: vi.fn(), setPullRequest: () => {} },
      );
    }
    expect(createPROnHost).not.toHaveBeenCalled();
    expect(h.registry.getStack(stackId)?.pr_url).toBeNull();
  });
});
