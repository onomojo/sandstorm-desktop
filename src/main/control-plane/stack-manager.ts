import { spawn, execSync, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Registry, Stack, StackHistoryRecord, StackStatus, Task, TokenUsage } from './registry';
import { PortAllocator, ServicePort } from './port-allocator';
import { PortProxy } from './port-proxy';
import { TaskWatcher, WorkflowProgressData } from './task-watcher';
import { ContainerRuntime, Container, ContainerStats } from '../runtime/types';
import { SandstormError, ErrorCode } from '../errors';
import { fetchRawBodyWithConfig, fetchTicketWithConfig, updateTicketWithConfig } from './ticket-config';
import { referencesTicket } from './ticket-fetcher';
import { resolveTicketReferences, renderResolvedReferences } from './ticket-references';
import { workspacePathFor } from './pr-creator';
import { parseTokenUsage } from './token-parser';
import type { TouchpointId } from './routing';

const execFileAsync = promisify(execFile);

declare const __GIT_COMMIT__: string;

export interface CreateStackOpts {
  name: string;
  projectDir: string;
  ticket?: string;
  branch?: string;
  description?: string;
  runtime: 'docker' | 'podman';
  task?: string;
  model?: string;
  gateApproved?: boolean;
  forceBypass?: boolean;
}

export interface StackWithServices extends Stack {
  services: ServiceInfo[];
}

/**
 * Trimmed response for the `dispatch_task` MCP tool. A subset of `Task`
 * that does not echo the `prompt` (or any fetched ticket body) back to the
 * outer Claude — those are already in the prior turn's transcript. See #255.
 */
export interface DispatchTaskResult {
  id: number;
  stack_id: string;
  status: string;
}

/**
 * Trimmed response for the `get_task_status` MCP tool. A subset of `Task`
 * that omits `prompt` and token fields so repeated polling does not re-paste
 * those blocks into the transcript. See #255.
 */
export interface TaskStatusResult {
  status: string;
  id?: number;
  started_at?: string;
  finished_at?: string | null;
  exit_code?: number | null;
}

/** Byte caps for MCP tool response payloads. See #255. */
export const TASK_OUTPUT_MAX_BYTES = 4096;

/** Result type returned by `autoResolveConflicts`. */
export type AutoResolveResult =
  | { status: 'resolved' }
  | { status: 'no_conflicts' }
  | { status: 'unknown_state' }
  | { status: 'failed'; error: string };
export const LOGS_PER_CONTAINER_MAX_BYTES = 8192;
export const LOGS_TOTAL_MAX_BYTES = 32768;

/**
 * Truncate a UTF-8 string to its last `maxBytes` bytes, prefixing a marker
 * that records how many bytes were dropped. When the byte length is at or
 * below the cap, the string is returned unchanged. Safe for multi-byte
 * characters: invalid leading bytes are replaced by U+FFFD on decode.
 */
export function tailBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  const dropped = buf.byteLength - maxBytes;
  const tail = buf.subarray(buf.byteLength - maxBytes).toString('utf8');
  return `...[truncated ${dropped} earlier bytes]...\n${tail}`;
}

export interface PortExposure {
  containerPort: number;
  hostPort?: number;
  exposed: boolean;
}

export interface ServiceInfo {
  name: string;
  status: string;
  exitCode?: number;
  hostPort?: number;
  containerPort?: number;
  containerId: string;
  ports: PortExposure[];
}

export interface ContainerStatsEntry {
  name: string;
  containerId: string;
  memoryUsage: number;
  memoryLimit: number;
  cpuPercent: number;
}

export interface DetailedStackStats {
  stackId: string;
  totalMemory: number;
  containers: ContainerStatsEntry[];
}

export interface TaskMetrics {
  stackId: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks: number;
  avgTaskDurationMs: number;
}

export interface TokenUsageStats {
  stackId: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ProjectTokenUsage {
  project: string;
  project_dir: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface GlobalTokenUsage {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  per_stack: TokenUsageStats[];
  per_project: ProjectTokenUsage[];
}

export interface RateLimitState {
  active: boolean;
  reset_at: string | null;
  affected_stacks: string[];
  reason: string | null;
}

/**
 * Sanitize a string for use as a segment in a Docker Compose project name.
 * The full project name is prefixed with "sandstorm-", so individual segments
 * don't need to start with a letter — that constraint is satisfied by the prefix.
 * Segments must consist only of lowercase alphanumeric characters, hyphens, and underscores.
 */
export function sanitizeComposeName(input: string): string {
  const name = (input ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-')       // spaces → hyphens
    .replace(/[^a-z0-9_-]/g, '') // strip invalid chars
    .replace(/-{2,}/g, '-')      // collapse repeated hyphens
    .replace(/^[-]+/, '')         // strip leading hyphens
    .replace(/[-]+$/, '');        // strip trailing hyphens

  return name || 'stack';
}

/**
 * Build the Docker Compose project name for a given project/stack pair.
 * Matches the `COMPOSE_PROJECT` variable in the CLI: "sandstorm-<project>-<stackId>".
 */
export function composeProjectNameFor(projectName: string, stackId: string): string {
  return `sandstorm-${sanitizeComposeName(projectName)}-${sanitizeComposeName(stackId)}`;
}

/**
 * Return the docker CLI args to list volumes for a compose project by label.
 * The returned list is suitable for `spawn('docker', args)`.
 */
export function volumeRemoveArgsForProject(composeProjectName: string): string[] {
  return ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${composeProjectName}`];
}

// referencesGitHubIssue is removed — use referencesTicket from ticket-fetcher.ts instead.
// Re-export for backwards compatibility with any external callers.
export { referencesTicket, referencesTicket as referencesGitHubIssue } from './ticket-fetcher';

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const ASK_CLARIFYING_QUESTIONS_PROMPT =
  'You previously stopped for human input but produced no questions. ' +
  'Step 1: Write the specific clarifying questions you need answered to ' +
  '/tmp/claude-stop-questions.json as a JSON array of objects, each with string fields "id" and "question". ' +
  'Step 2 (required): After writing that file, re-engage the STOP_AND_ASK halt — ' +
  'emit a line STOP_AND_ASK: <one-sentence reason> on its own line and stop immediately ' +
  'without making any further changes. This re-sets the task to needs_human via the harness ' +
  'so your questions are surfaced to the human. Do not continue the work.';

export class StackManager {
  private onStackUpdate?: () => void;
  private appVersion: string;
  private portProxy?: PortProxy;
  private askClarifyingInFlight = new Set<string>();

  constructor(
    private registry: Registry,
    private portAllocator: PortAllocator,
    private taskWatcher: TaskWatcher,
    private dockerRuntime: ContainerRuntime,
    private podmanRuntime: ContainerRuntime,
    private cliDir: string = ''
  ) {
    // When the task watcher detects a status change, push a UI update
    this.taskWatcher.setOnStatusChange(() => this.notifyUpdate());
    this.appVersion = StackManager.resolveAppVersion();
  }

  /** Register a callback invoked when a task completes (used by rollup store for cache invalidation). */
  setOnTaskCompleted(cb: (stackId: string) => void): void {
    this.taskWatcher.onTaskCompleted = cb;
  }

  /**
   * Resolve the app's git commit hash.
   * Prefers the build-time define; falls back to git at runtime (dev mode).
   */
  static resolveAppVersion(): string {
    try {
      if (typeof __GIT_COMMIT__ !== 'undefined' && __GIT_COMMIT__ !== 'unknown') {
        return __GIT_COMMIT__;
      }
    } catch {
      // __GIT_COMMIT__ not defined (e.g. in tests)
    }
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    } catch {
      return 'unknown';
    }
  }

  getAppVersion(): string {
    return this.appVersion;
  }

  setOnStackUpdate(callback: () => void): void {
    this.onStackUpdate = callback;
  }

  setPortProxy(proxy: PortProxy): void {
    this.portProxy = proxy;
  }

  async exposePort(stackId: string, service: string, containerPort: number): Promise<number> {
    if (!this.portProxy) throw new SandstormError(ErrorCode.INTERNAL_ERROR, 'PortProxy not initialized');
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    await this.portProxy.ensureImage();
    const hostPort = await this.portProxy.expose(stackId, stack.project, service, containerPort);
    this.notifyUpdate();
    return hostPort;
  }

  async unexposePort(stackId: string, service: string, containerPort: number): Promise<void> {
    if (!this.portProxy) throw new SandstormError(ErrorCode.INTERNAL_ERROR, 'PortProxy not initialized');
    await this.portProxy.unexpose(stackId, service, containerPort);
    this.notifyUpdate();
  }

  private notifyUpdate(): void {
    this.onStackUpdate?.();
  }

  /**
   * Resolve the correct container runtime for a stack based on its stored
   * runtime preference, rather than relying on the global default.
   */
  getRuntimeForStack(stack: Stack): ContainerRuntime {
    return stack.runtime === 'podman' ? this.podmanRuntime : this.dockerRuntime;
  }

  /**
   * Resolve path to the sandstorm CLI entry point.
   */
  private getCliBin(): string {
    return path.join(this.cliDir, 'bin', 'sandstorm');
  }

  /**
   * Run a sandstorm CLI command in the given project directory.
   *
   * E2BIG protection: Linux's per-argument limit (MAX_ARG_STRLEN) is 128 KB.
   * If the last positional arg (typically a large dispatch prompt) exceeds
   * 64 KB, it is written to a temp file and passed as `--file <path>` instead,
   * so spawn never receives an oversized argument. Callers always pass the
   * prompt as the last positional arg; this method handles the substitution
   * transparently, keeping the spy-visible arg list clean for tests.
   */
  async runCli(
    projectDir: string,
    args: string[],
    env?: Record<string, string>
  ): Promise<CliResult> {
    const MAX_ARG_BYTES = 64 * 1024;
    let spawnArgs = args;
    let tmpDir: string | undefined;

    try {
      const lastArg = args[args.length - 1];
      if (lastArg && !lastArg.startsWith('-') && Buffer.byteLength(lastArg, 'utf8') > MAX_ARG_BYTES) {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sandstorm-task-'));
        const tmpFile = path.join(tmpDir, 'prompt.txt');
        await fs.promises.writeFile(tmpFile, lastArg, 'utf-8');
        spawnArgs = [...args.slice(0, -1), '--file', tmpFile];
      }

      return await new Promise<CliResult>((resolve, reject) => {
        const child = spawn('bash', [this.getCliBin(), ...spawnArgs], {
          cwd: projectDir,
          env: {
            ...process.env,
            ...env,
            PATH: [
              `${process.env.HOME}/.local/bin`,
              '/opt/homebrew/bin',
              '/usr/local/bin',
              '/usr/local/sbin',
              process.env.PATH,
            ].join(':'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
        child.on('error', reject);
      });
    } finally {
      if (tmpDir) {
        fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * Check whether a create/dispatch call requires the spec quality gate.
   * Throws GATE_CHECK_REQUIRED if the task references a ticket
   * but gateApproved and forceBypass are both falsy.
   */
  private enforceSpecGate(opts: { ticket?: string; task?: string; gateApproved?: boolean; forceBypass?: boolean }): void {
    if (opts.gateApproved || opts.forceBypass) {
      if (opts.forceBypass && !opts.gateApproved) {
        console.warn('[sandstorm] Spec quality gate bypassed via forceBypass flag');
      }
      return;
    }

    const hasTicket = !!opts.ticket;
    const hasTicketRef = opts.task ? referencesTicket(opts.task) : false;

    if (hasTicket || hasTicketRef) {
      throw new SandstormError(
        ErrorCode.GATE_CHECK_REQUIRED,
        'Task references a ticket but gateApproved was not set. Run /spec-check on the ticket first, then retry with gateApproved: true.'
      );
    }
  }

  createStack(opts: CreateStackOpts): Stack {
    this.enforceSpecGate(opts);

    const projectName = path.basename(opts.projectDir);

    // If no model specified, use project's effective default
    if (!opts.model) {
      const effective = this.registry.getEffectiveModels(opts.projectDir);
      opts = { ...opts, model: effective.inner_model };
    }

    // Resolve "auto" → undefined so the CLI never receives "--model auto"
    if (opts.model === 'auto') {
      opts = { ...opts, model: undefined };
    }

    // Create registry entry first (ports table has FK to stacks)
    const stack = this.registry.createStack({
      id: opts.name,
      project: projectName,
      project_dir: opts.projectDir,
      ticket: opts.ticket ?? null,
      branch: opts.branch ?? null,
      description: opts.description ?? null,
      status: 'building',
      runtime: opts.runtime,
    });

    // Write the stackId→ticket manifest before launching the build so telemetry
    // readers can resolve ticket attribution as soon as transcripts appear.
    this.writeStackManifest(opts.name, opts.ticket ?? null, projectName, opts.projectDir);

    // Launch the heavy work in the background
    this.buildStackInBackground(opts, projectName).catch(() => {
      // Error already stored in registry by buildStackInBackground
    });

    return stack;
  }

  private writeStackManifest(
    stackId: string,
    ticket: string | null,
    project: string,
    projectDir: string
  ): void {
    try {
      const usageDir = path.join(projectDir, '.sandstorm', 'usage');
      fs.mkdirSync(usageDir, { recursive: true });
      const manifestPath = path.join(usageDir, `${stackId}.manifest.json`);
      const manifest = {
        stackId,
        ticket,
        project,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      // Non-fatal — telemetry degrades to ticket=null for this stack
    }
  }

  /**
   * Check whether the project's Claude base image needs rebuilding.
   * Compares the image's sandstorm.app-version label to the current app version.
   * Returns true if the image is outdated or missing a version stamp.
   */
  async checkImageNeedsRebuild(projectDir: string): Promise<boolean> {
    if (this.appVersion === 'unknown') return false;

    try {
      const projectName = path.basename(projectDir).toLowerCase().replace(/[^a-z0-9]/g, '-');
      const imageName = `sandstorm-${projectName}-claude`;

      // Use docker CLI to inspect the image label (works with any runtime)
      const result = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
        const child = spawn('docker', [
          'image', 'inspect', imageName,
          '--format', '{{index .Config.Labels "sandstorm.app-version"}}',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.on('close', (code) => resolve({ stdout: stdout.trim(), exitCode: code ?? 1 }));
        child.on('error', () => resolve({ stdout: '', exitCode: 1 }));
      });

      if (result.exitCode !== 0) {
        // Image doesn't exist — will be built from scratch, no rebuild needed
        return false;
      }

      const imageVersion = result.stdout;
      if (!imageVersion || imageVersion === '<no value>') {
        // Image exists but has no version label — needs rebuild to stamp it
        return true;
      }

      return imageVersion !== this.appVersion;
    } catch {
      return false;
    }
  }

  private async buildStackInBackground(opts: CreateStackOpts, _projectName: string): Promise<void> {
    try {
      // Check if the base image needs rebuilding due to app version change
      const needsRebuild = await this.checkImageNeedsRebuild(opts.projectDir);
      if (needsRebuild) {
        this.registry.updateStackStatus(opts.name, 'rebuilding');
        this.notifyUpdate();
      }

      // Ports are now exposed on-demand via proxy containers — no static allocation at creation time.
      const portEnv: Record<string, string> = {};

      // Pass the app version so the CLI can stamp the Docker image label
      portEnv['SANDSTORM_APP_VERSION'] = this.appVersion;

      // Build CLI args
      const args = ['up', opts.name];
      if (opts.ticket) args.push('--ticket', opts.ticket);
      if (opts.branch) args.push('--branch', opts.branch);

      const result = await this.runCli(opts.projectDir, args, portEnv);

      if (result.exitCode !== 0) {
        throw new SandstormError(ErrorCode.COMPOSE_FAILED, result.stderr.trim() || result.stdout.trim() || 'Stack creation failed');
      }

      this.registry.updateStackStatus(opts.name, 'up');
      this.notifyUpdate();

      // If a task was provided, dispatch it (with one retry on failure).
      // Propagate forceBypass/gateApproved so the inner dispatchTask call
      // doesn't re-run the spec gate check that already passed in createStack.
      if (opts.task) {
        const gateOpts = { gateApproved: opts.gateApproved, forceBypass: opts.forceBypass };
        try {
          await this.dispatchTask(opts.name, opts.task, opts.model, gateOpts);
        } catch (firstErr) {
          // Wait and retry once — the container may need more time
          await new Promise((resolve) => setTimeout(resolve, 10000));
          try {
            await this.dispatchTask(opts.name, opts.task, opts.model, gateOpts);
          } catch (retryErr) {
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            this.registry.updateStackStatus(opts.name, 'failed', `Task dispatch failed after retry: ${msg}`);
            this.notifyUpdate();
            return;
          }
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.registry.updateStackStatus(opts.name, 'failed', errorMessage);
      this.notifyUpdate();
    }
  }

  stopStack(stackId: string): void {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    this.taskWatcher.unwatch(stackId);
    this.registry.updateStackStatus(stackId, 'stopped');
    this.notifyUpdate();

    // Stop containers in background (keeps containers/volumes/images intact)
    this.stopInBackground(stack, stackId).catch(() => {});
  }

  private async stopInBackground(stack: Stack, stackId: string): Promise<void> {
    try {
      await this.runCli(stack.project_dir, ['stop', stackId]);
    } catch {
      // Best effort
    }
  }

  startStack(stackId: string): void {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    this.registry.updateStackStatus(stackId, 'building');
    this.notifyUpdate();

    // Start containers in background
    this.startInBackground(stack, stackId).catch(() => {});
  }

  /**
   * Synchronously bring the stack's containers up. Used by `dispatchTask`
   * to recover from a paused-stack state (env-friction fix, #273). Unlike
   * `startInBackground`, this awaits completion and re-throws so the
   * caller can surface failure to the user.
   */
  private async ensureStackContainersRunning(stack: Stack, stackId: string): Promise<void> {
    const result = await this.runCli(stack.project_dir, ['up', stackId]);
    if (result.exitCode !== 0) {
      throw new SandstormError(
        ErrorCode.COMPOSE_FAILED,
        result.stderr.trim() || result.stdout.trim() || 'Failed to start stack containers before dispatch'
      );
    }
    this.registry.updateStackStatus(stackId, 'up');
    this.notifyUpdate();
  }

  private async startInBackground(stack: Stack, stackId: string): Promise<void> {
    try {
      const result = await this.runCli(stack.project_dir, ['up', stackId]);
      if (result.exitCode !== 0) {
        throw new SandstormError(ErrorCode.COMPOSE_FAILED, result.stderr.trim() || result.stdout.trim() || 'Stack start failed');
      }
      this.registry.updateStackStatus(stackId, 'up');
      this.notifyUpdate();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.registry.updateStackStatus(stackId, 'failed', errorMessage);
      this.notifyUpdate();
    }
  }

  /**
   * Pause all running stacks due to session token limit.
   * Uses docker stop (not teardown) so stacks can be resumed.
   * Returns the list of stack IDs that were paused.
   */
  sessionPauseAllStacks(): string[] {
    const stacks = this.registry.listStacks();
    const runningStatuses = new Set(['running', 'up', 'building', 'rebuilding', 'idle', 'completed', 'pushed', 'pr_created']);
    const paused: string[] = [];

    for (const stack of stacks) {
      if (runningStatuses.has(stack.status)) {
        this.taskWatcher.unwatch(stack.id);
        this.registry.updateStackStatus(stack.id, 'session_paused');
        paused.push(stack.id);
        // Stop containers in background
        this.stopInBackground(stack, stack.id).catch(() => {});
      }
    }

    if (paused.length > 0) {
      this.notifyUpdate();
    }
    return paused;
  }

  /**
   * Resume a stack that was paused due to session limit.
   */
  sessionResumeStack(stackId: string): void {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    if (stack.status !== 'session_paused') return;

    this.registry.updateStackStatus(stackId, 'building');
    this.notifyUpdate();
    this.startInBackground(stack, stackId).catch(() => {});
  }

  /**
   * Resume all stacks that were paused due to session limit.
   */
  sessionResumeAllStacks(): string[] {
    const stacks = this.registry.listStacks();
    const resumed: string[] = [];

    for (const stack of stacks) {
      if (stack.status === 'session_paused') {
        this.registry.updateStackStatus(stack.id, 'building');
        resumed.push(stack.id);
        this.startInBackground(stack, stack.id).catch(() => {});
      }
    }

    if (resumed.length > 0) {
      this.notifyUpdate();
    }
    return resumed;
  }

  /**
   * Resume a session_paused stack and continue the in-flight task.
   * Cases:
   *   A — running task with session_id  → resume Claude session with --resume
   *   B — running task, no session_id   → interrupt old task, dispatch fresh
   *   C — no running task               → containers come up, status → idle
   * Throws if the stack is not found or containers cannot be started.
   */
  async resumeStackWithContinuation(
    stackId: string,
    isHalted: () => boolean = () => false,
    manual: boolean = false
  ): Promise<{
    outcome: 'resuming_with_session' | 'resumed_fresh' | 'idle';
  }> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    // Pre-flight: block resume if session token limit hasn't refreshed yet.
    // Manual resumes (user clicking Resume) bypass this — if the session is
    // still limited the inner agent will hit it again, and the per-stack
    // token-limit detector will re-classify the stack back to session_paused.
    if (!manual && isHalted()) {
      throw new SandstormError(ErrorCode.SESSION_HALTED, 'Session token limit has not refreshed yet');
    }

    // Guard: only act on session_paused stacks
    if (stack.status !== 'session_paused') {
      return { outcome: 'idle' };
    }

    // Bring containers up synchronously
    this.registry.updateStackStatus(stackId, 'building');
    this.notifyUpdate();
    try {
      await this.ensureStackContainersRunning(stack, stackId);
    } catch (err) {
      // Revert to session_paused on container failure so the user can retry
      this.registry.updateStackStatus(stackId, 'session_paused');
      this.notifyUpdate();
      throw err;
    }

    let runningTask = this.registry.getRunningTask(stackId);

    if (!runningTask) {
      // Q-A fallback: try most-recent task + reopenTaskForResume before idling.
      // Covers session_paused stacks whose task was already completed/closed
      // (e.g. after recheckCompletedStack transitions a 'completed' stack here).
      const mostRecentTask = this.registry.getMostRecentTask(stackId);
      if (!mostRecentTask) {
        // Case C: no task at all — leave stack idle
        this.registry.updateStackStatus(stackId, 'idle');
        this.notifyUpdate();
        return { outcome: 'idle' };
      }
      this.registry.reopenTaskForResume(mostRecentTask.id);
      runningTask = { ...mostRecentTask, status: 'running' as const };
    }

    if (runningTask.session_id) {
      // Case A: resume with existing Claude session
      try {
        await this.dispatchContinuation(stack, stackId, runningTask);
      } catch (err) {
        this.registry.updateStackStatus(stackId, 'session_paused');
        this.notifyUpdate();
        throw err;
      }
      return { outcome: 'resuming_with_session' };
    } else {
      // Case B: session not yet logged — interrupt and redispatch fresh
      this.registry.interruptTask(runningTask.id);
      try {
        await this.dispatchTask(stackId, runningTask.prompt, runningTask.model ?? undefined, {
          skipTicketFetch: true,
        });
      } catch (err) {
        this.registry.updateStackStatus(stackId, 'session_paused');
        this.notifyUpdate();
        throw err;
      }
      return { outcome: 'resumed_fresh' };
    }
  }

  /**
   * Re-dispatch an existing running task using `--resume <session_id>`.
   * Does NOT create a new task row — the caller's existing task is reused and
   * `resumed_at` is stamped so the UI can distinguish continuations.
   */
  private async dispatchContinuation(
    stack: Stack,
    stackId: string,
    task: Task,
    continuationPrompt: string = 'Continue the work that was halted by token limits. Keep going from where you left off.'
  ): Promise<void> {
    const runtime = this.getRuntimeForStack(stack);
    let claudeContainer = await this.findClaudeContainer(stack, runtime);

    if (claudeContainer.status !== 'running') {
      await this.ensureStackContainersRunning(stack, stackId);
      claudeContainer = await this.findClaudeContainer(stack, runtime);
    }

    await this.waitForClaudeReady(claudeContainer.id, runtime);

    this.registry.setTaskResumedAt(task.id, new Date().toISOString());
    this.registry.updateStackStatus(stackId, 'running');
    this.notifyUpdate();

    const cliArgs = ['task', stackId, '--resume', task.session_id!];
    if (task.model) cliArgs.push('--model', task.model);
    cliArgs.push(continuationPrompt);

    const result = await this.runCli(stack.project_dir, cliArgs);
    if (result.exitCode !== 0) {
      this.registry.updateStackStatus(stackId, 'session_paused');
      this.notifyUpdate();
      throw new SandstormError(
        ErrorCode.TASK_DISPATCH_FAILED,
        result.stderr.trim() || result.stdout.trim() || 'Resume dispatch failed'
      );
    }

    this.taskWatcher.watch(stackId, claudeContainer.id);
    this.taskWatcher.streamOutput(stackId, claudeContainer.id, () => {}).catch(() => {});
  }

  /**
   * Dispatch an investigation-and-finish session for a stalled task.
   * Called by the TaskWatcher liveness check when a running task's process
   * has died without writing a terminal status. Uses --resume <session_id>
   * so the original session can inspect its own prior work and either finish
   * or write a terminal status. Distinct from dispatchContinuation (token-limit
   * resume) — this path delivers the INVESTIGATE_AND_FINISH_PROMPT.
   */
  async dispatchInvestigation(stackId: string, task: Task, investigationPrompt: string): Promise<void> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    const runtime = this.getRuntimeForStack(stack);
    let claudeContainer = await this.findClaudeContainer(stack, runtime);

    if (claudeContainer.status !== 'running') {
      await this.ensureStackContainersRunning(stack, stackId);
      claudeContainer = await this.findClaudeContainer(stack, runtime);
    }

    await this.waitForClaudeReady(claudeContainer.id, runtime);

    this.registry.setTaskResumedAt(task.id, new Date().toISOString());
    this.registry.updateStackStatus(stackId, 'running');
    this.notifyUpdate();

    const cliArgs = ['task', stackId, '--resume', task.session_id!];
    if (task.model) cliArgs.push('--model', task.model);
    cliArgs.push(investigationPrompt);

    const result = await this.runCli(stack.project_dir, cliArgs);
    if (result.exitCode !== 0) {
      this.registry.updateStackStatus(stackId, 'needs_human');
      this.notifyUpdate();
      throw new SandstormError(
        ErrorCode.TASK_DISPATCH_FAILED,
        result.stderr.trim() || result.stdout.trim() || 'Investigation dispatch failed'
      );
    }

    this.taskWatcher.watch(stackId, claudeContainer.id);
    this.taskWatcher.streamOutput(stackId, claudeContainer.id, () => {}).catch(() => {});
  }

  /**
   * Re-check a `completed` stack to determine if it was actually token-limited.
   * Execs a two-stage grep against the container log (mirroring check_for_token_limit
   * in task-runner.sh:63-72) and, on confirmation, drives the stack through the
   * existing continuation machinery (Case A with session_id, Case B without).
   *
   * Returns `container_gone` when the claude container is absent or not running.
   * Returns `not_token_limited` when the grep finds no marker.
   * Returns `idle` when confirmed but no task record exists.
   * Returns the resumeStackWithContinuation outcome otherwise.
   */
  async recheckCompletedStack(stackId: string): Promise<{
    outcome: 'resuming_with_session' | 'resumed_fresh' | 'not_token_limited' | 'container_gone' | 'idle';
  }> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    // Idempotency guard — abort if status has already changed
    if (stack.status !== 'completed') {
      return { outcome: 'idle' };
    }

    const runtime = this.getRuntimeForStack(stack);
    const composeProjectName = composeProjectNameFor(stack.project, stack.id);

    let containers;
    try {
      containers = await runtime.listContainers({ name: `${composeProjectName}-claude` });
    } catch (err) {
      console.debug(`[StackManager] recheckCompletedStack: container list failed for ${stackId}:`, err);
      return { outcome: 'container_gone' };
    }

    const container = containers[0] ?? null;
    if (!container || container.status !== 'running') {
      console.debug(`[StackManager] recheckCompletedStack: container absent or not running for ${stackId}`);
      return { outcome: 'container_gone' };
    }

    // Structured detection mirrors check_for_token_limit() in task-runner.sh:63-72.
    // Checks JSON lines for rate_limit_event (rejected) or result (is_error:true, api_error_status:429).
    // Falls back to plain-text grep for legacy/stderr output.
    let grepResult;
    try {
      grepResult = await runtime.exec(container.id, [
        'sh', '-c',
        [
          "grep -E '^[[:space:]]*\\{' /tmp/claude-raw.log 2>/dev/null",
          "| jq -c 'select((.type == \"rate_limit_event\" and .rate_limit_info.status == \"rejected\") or (.type == \"result\" and .is_error == true and .api_error_status == 429))' 2>/dev/null",
          '| grep -q .',
          "|| grep -vE '^[[:space:]]*\\{' /tmp/claude-raw.log 2>/dev/null | grep -qi \"You've hit your session limit\"",
        ].join(' '),
      ]);
    } catch {
      return { outcome: 'not_token_limited' };
    }

    if (grepResult.exitCode !== 0) {
      // Genuine completion — marker not found
      return { outcome: 'not_token_limited' };
    }

    // Token limit confirmed. Get the most-recent task to update session_id.
    const task = this.registry.getMostRecentTask(stackId);
    if (!task) {
      return { outcome: 'idle' };
    }

    // Best-effort: read session_id from log so resumeStackWithContinuation can use Case A.
    try {
      const rawResult = await runtime.exec(container.id, ['cat', '/tmp/claude-raw.log']);
      if (rawResult.stdout) {
        const usage = parseTokenUsage(rawResult.stdout);
        if (usage.session_id) {
          this.registry.setTaskSessionId(task.id, usage.session_id);
        }
      }
    } catch {
      // Non-fatal — resume falls back to Case B (fresh re-dispatch)
    }

    // Transition to session_paused so resumeStackWithContinuation can proceed.
    // The task is still 'completed'; the Q-A fallback in resumeStackWithContinuation
    // will call getMostRecentTask + reopenTaskForResume before Case A/B.
    this.registry.updateStackStatus(stackId, 'session_paused');
    this.notifyUpdate();

    try {
      const result = await this.resumeStackWithContinuation(stackId, () => false, true);
      return result;
    } catch (err) {
      // Revert: close any reopened task and restore stack to completed.
      // Include 'interrupted' because Case B calls interruptTask before dispatchTask;
      // if dispatchTask throws, the task is 'interrupted', not 'running'.
      const reopenedTask = this.registry.getMostRecentTask(stackId);
      if (reopenedTask && (reopenedTask.status === 'running' || reopenedTask.status === 'interrupted')) {
        this.registry.completeTask(reopenedTask.id, 0); // also sets stack to 'completed'
      } else {
        this.registry.updateStackStatus(stackId, 'completed');
      }
      this.notifyUpdate();
      throw err;
    }
  }

  /**
   * Reconcile a stale terminal stack status by reading the container's
   * authoritative /tmp/claude-task.status file and driving the registry to match.
   * Mirrors the status→registry mapping in task-watcher.ts exactly.
   * Guards against overwriting session_paused or rate_limited stacks.
   */
  async reconcileStatus(stackId: string): Promise<{
    outcome: 'reconciled' | 'container_gone' | 'guarded';
    status?: StackStatus;
  }> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    if (stack.status === 'session_paused' || stack.status === 'rate_limited') {
      return { outcome: 'guarded' };
    }

    const runtime = this.getRuntimeForStack(stack);
    const composeProjectName = composeProjectNameFor(stack.project, stack.id);

    let containers;
    try {
      containers = await runtime.listContainers({ name: `${composeProjectName}-claude` });
    } catch (err) {
      console.debug(`[StackManager] reconcileStatus: container list failed for ${stackId}:`, err);
      return { outcome: 'container_gone' };
    }

    const container = containers[0] ?? null;
    if (!container || container.status !== 'running') {
      console.debug(`[StackManager] reconcileStatus: container absent or not running for ${stackId}`);
      return { outcome: 'container_gone' };
    }

    let containerStatus: string;
    try {
      const result = await runtime.exec(container.id, ['cat', '/tmp/claude-task.status']);
      containerStatus = result.stdout.trim();
    } catch {
      return { outcome: 'container_gone' };
    }

    const task = this.registry.getMostRecentTask(stackId);

    if (containerStatus === 'running') {
      this.registry.updateStackStatus(stackId, 'running');
      if (task) this.registry.reopenTaskForResume(task.id);
      this.taskWatcher.watch(stackId, container.id);
      this.notifyUpdate();
      return { outcome: 'reconciled', status: 'running' };
    }

    if (containerStatus === 'token_limited') {
      this.registry.updateStackStatus(stackId, 'session_paused');
      this.notifyUpdate();
      return { outcome: 'reconciled', status: 'session_paused' };
    }

    if (containerStatus === 'needs_human' || containerStatus === 'unknown') {
      let stopReason = containerStatus === 'unknown'
        ? 'Investigation returned unknown state — needs human review'
        : 'Agent signaled STOP_AND_ASK — needs human intervention';
      let questionsJson: string | null = null;

      if (containerStatus === 'needs_human') {
        try {
          const reasonResult = await runtime.exec(container.id, ['cat', '/tmp/claude-stop-reason.txt']);
          if (reasonResult.stdout.trim()) stopReason = reasonResult.stdout.trim();
        } catch { /* best effort */ }
        try {
          const questionsResult = await runtime.exec(container.id, ['cat', '/tmp/claude-stop-questions.json']);
          if (questionsResult.stdout.trim()) {
            const parsed = JSON.parse(questionsResult.stdout.trim());
            if (Array.isArray(parsed) && parsed.every(
              (q: unknown) => q && typeof q === 'object' &&
                typeof (q as Record<string, unknown>).id === 'string' &&
                typeof (q as Record<string, unknown>).question === 'string'
            )) {
              questionsJson = questionsResult.stdout.trim();
            }
          }
        } catch { /* best effort — malformed/absent JSON falls back to null */ }
      }

      if (task) {
        this.registry.completeTaskNeedsHuman(task.id, stopReason, questionsJson);
      } else {
        this.registry.updateStackStatus(stackId, 'needs_human');
      }
      this.notifyUpdate();
      return { outcome: 'reconciled', status: 'needs_human' };
    }

    if (containerStatus === 'needs_key') {
      let keyReason = 'A phase provider has no credentials configured — add credentials in provider settings';
      try {
        const reasonResult = await runtime.exec(container.id, ['cat', '/tmp/claude-task-needs-key.txt']);
        if (reasonResult.stdout.trim()) keyReason = reasonResult.stdout.trim();
      } catch { /* best effort */ }

      if (task) {
        this.registry.completeTaskNeedsKey(task.id, keyReason);
      } else {
        this.registry.updateStackStatus(stackId, 'needs_key');
      }
      this.notifyUpdate();
      return { outcome: 'reconciled', status: 'needs_key' };
    }

    if (containerStatus === 'verify_blocked_environmental') {
      let envReason = 'Verify failed repeatedly — likely an environmental issue (missing binary, missing service, etc.)';
      try {
        const envResult = await runtime.exec(container.id, ['cat', '/tmp/claude-verify-environmental.txt']);
        if (envResult.stdout.trim()) envReason = `Verify blocked (environmental): ${envResult.stdout.trim()}`;
      } catch { /* best effort */ }

      if (task) {
        this.registry.completeTaskVerifyBlockedEnvironmental(task.id, envReason);
      } else {
        this.registry.updateStackStatus(stackId, 'verify_blocked_environmental');
      }
      this.notifyUpdate();
      return { outcome: 'reconciled', status: 'verify_blocked_environmental' };
    }

    if (containerStatus === 'completed' || containerStatus === 'failed') {
      let exitCode = containerStatus === 'completed' ? 0 : 1;
      try {
        const exitResult = await runtime.exec(container.id, ['cat', '/tmp/claude-task.exit']);
        const parsed = parseInt(exitResult.stdout.trim(), 10);
        if (!isNaN(parsed)) exitCode = parsed;
      } catch { /* best effort */ }

      if (task) {
        this.registry.completeTask(task.id, exitCode);
      } else {
        this.registry.updateStackStatus(stackId, containerStatus as 'completed' | 'failed');
      }
      this.notifyUpdate();
      return { outcome: 'reconciled', status: containerStatus as 'completed' | 'failed' };
    }

    // Unrecognized status — surface to user as needs_human
    if (task) {
      this.registry.completeTaskNeedsHuman(task.id, `Unrecognized container status: ${containerStatus}`);
    } else {
      this.registry.updateStackStatus(stackId, 'needs_human');
    }
    this.notifyUpdate();
    return { outcome: 'reconciled', status: 'needs_human' };
  }

  /**
   * Resume a needs_human stack by providing answers to the agent's questions.
   * Uses --resume <session_id> if available; falls back to fresh dispatch if not.
   */
  async resumeNeedsHumanStack(stackId: string, answers: string): Promise<void> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    if (stack.status !== 'needs_human' && stack.status !== 'failed' && stack.status !== 'verify_blocked_environmental') {
      throw new SandstormError(ErrorCode.INVALID_INPUT, `Stack "${stackId}" is not in a resumable state (needs_human, failed, or verify_blocked_environmental)`);
    }

    const task = this.registry.getMostRecentTask(stackId);
    if (!task) throw new SandstormError(ErrorCode.INTERNAL_ERROR, `No task found for stack "${stackId}"`);

    const originalStatus = stack.status;

    // Bring containers up
    this.registry.updateStackStatus(stackId, 'building');
    this.notifyUpdate();
    try {
      await this.ensureStackContainersRunning(stack, stackId);
    } catch (err) {
      this.registry.updateStackStatus(stackId, originalStatus);
      this.notifyUpdate();
      throw err;
    }

    const continuationPrompt =
      `The agent was waiting for human input. Here are the answers to the questions:\n\n${answers}\n\nPlease continue the work from where you left off.`;

    try {
      if (task.session_id) {
        // Case A: resume with existing Claude session — reopen task then dispatch continuation
        this.registry.reopenTaskForResume(task.id);
        await this.dispatchContinuation(stack, stackId, { ...task, status: 'running' }, continuationPrompt);
      } else {
        // Case B: no session_id — close the original task and redispatch fresh with original prompt + answers
        this.registry.interruptTask(task.id);
        const freshPrompt = `${task.prompt}\n\n---\nAdditional context from human:\n${answers}`;
        try {
          await this.dispatchTask(stackId, freshPrompt, task.model ?? undefined, {
            skipTicketFetch: true,
          });
        } catch (err) {
          // Revert task to terminal state so it doesn't strand in interrupted
          this.registry.completeTaskNeedsHuman(task.id, 'Resume dispatch failed', task.needs_human_questions);
          this.registry.updateStackStatus(stackId, originalStatus);
          this.notifyUpdate();
          throw err;
        }
      }
    } catch (err) {
      if (task.session_id) {
        // Revert task to terminal state so it doesn't strand in running
        this.registry.completeTaskNeedsHuman(task.id, 'Resume dispatch failed', task.needs_human_questions);
        this.registry.updateStackStatus(stackId, originalStatus);
        this.notifyUpdate();
      }
      throw err;
    }
  }

  /**
   * Resume a needs_human stack to generate clarifying questions.
   * Resumes the in-container agent with a fixed prompt instructing it to write
   * /tmp/claude-stop-questions.json and emit STOP_AND_ASK so the harness re-populates
   * needs_human_questions. If no session_id, falls back to fresh dispatch.
   * Idempotent: no-op while a resume is already in flight for this stack.
   */
  async askClarifyingQuestions(stackId: string): Promise<void> {
    // In-flight check first — status may have been changed to 'building' by the first call
    if (this.askClarifyingInFlight.has(stackId)) {
      return;
    }

    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    if (stack.status !== 'needs_human') {
      throw new SandstormError(ErrorCode.INVALID_INPUT, `Stack "${stackId}" is not in needs_human state`);
    }

    this.askClarifyingInFlight.add(stackId);

    const task = this.registry.getMostRecentTask(stackId);
    if (!task) {
      this.askClarifyingInFlight.delete(stackId);
      throw new SandstormError(ErrorCode.INTERNAL_ERROR, `No task found for stack "${stackId}"`);
    }

    this.registry.updateStackStatus(stackId, 'building');
    this.notifyUpdate();
    try {
      await this.ensureStackContainersRunning(stack, stackId);
    } catch (err) {
      this.askClarifyingInFlight.delete(stackId);
      this.registry.updateStackStatus(stackId, 'needs_human');
      this.notifyUpdate();
      throw err;
    }

    try {
      if (task.session_id) {
        // Case A: resume in-container session with fixed prompt to trigger STOP_AND_ASK
        this.registry.reopenTaskForResume(task.id);
        await this.dispatchContinuation(stack, stackId, { ...task, status: 'running' }, ASK_CLARIFYING_QUESTIONS_PROMPT);
      } else {
        // Case B: no session_id — re-dispatch fresh with original prompt
        // The fixed clarifying-questions prompt does not apply; the original prompt is re-run.
        this.registry.interruptTask(task.id);
        try {
          await this.dispatchTask(stackId, task.prompt, task.model ?? undefined, {
            skipTicketFetch: true,
          });
        } catch (err) {
          this.registry.completeTaskNeedsHuman(task.id, 'Resume dispatch failed', task.needs_human_questions);
          this.registry.updateStackStatus(stackId, 'needs_human');
          this.notifyUpdate();
          throw err;
        }
      }
    } catch (err) {
      if (task.session_id) {
        this.registry.completeTaskNeedsHuman(task.id, 'Resume dispatch failed', task.needs_human_questions);
        this.registry.updateStackStatus(stackId, 'needs_human');
        this.notifyUpdate();
      }
      throw err;
    } finally {
      this.askClarifyingInFlight.delete(stackId);
    }
  }

  async teardownStack(stackId: string): Promise<void> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    this.taskWatcher.unwatch(stackId);

    // Mark any running tasks as interrupted and capture partial metadata
    const runningTask = this.registry.getRunningTask(stackId);
    if (runningTask) {
      // Try to capture whatever metadata exists before teardown
      try {
        const runtime = this.getRuntimeForStack(stack);
        const claudeContainer = await this.findClaudeContainer(stack, runtime).catch(() => null);
        if (claudeContainer) {
          await this.taskWatcher.capturePartialMetadata(
            runningTask.id, stackId, claudeContainer.id
          ).catch(() => {});
        }
      } catch {
        // Best effort — container may already be gone
      }
      this.registry.interruptTask(runningTask.id);
    }

    // Archive to history before deleting
    const finalStatus =
      stack.status === 'completed' ? 'completed' :
      stack.status === 'failed' ? 'failed' :
      'torn_down' as const;
    this.registry.archiveStack(stackId, finalStatus);

    // Remove proxy containers before releasing ports
    if (this.portProxy) {
      await this.portProxy.removeAllForStack(stackId).catch(() => {
        // Best effort — proxy containers may already be gone
      });
    }

    // Delete from registry and release ports immediately so the UI updates
    this.portAllocator.release(stackId);
    this.registry.deleteStack(stackId);
    this.notifyUpdate();

    // Run Docker teardown in background (best effort)
    this.teardownInBackground(stack, stackId).catch(() => {
      // Best effort
    });
  }

  private async teardownInBackground(stack: Stack, stackId: string): Promise<void> {
    try {
      await this.runCli(stack.project_dir, ['down', stackId]);
    } catch {
      // Best effort — if CLI fails, containers may need manual cleanup
    }
    // Defense-in-depth: remove any volumes the CLI may have missed (e.g. when
    // the workspace compose file was absent and down -v couldn't resolve them).
    await this.removeVolumesForProject(composeProjectNameFor(stack.project, stackId));
  }

  private async removeVolumesForProject(composeProjectName: string): Promise<void> {
    try {
      const listArgs = volumeRemoveArgsForProject(composeProjectName);
      const stdout = await new Promise<string>((resolve) => {
        const child = spawn('docker', listArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', () => resolve(out));
        child.on('error', () => resolve(''));
      });

      const volumes = stdout.split('\n').map((v) => v.trim()).filter(Boolean);
      for (const volume of volumes) {
        await new Promise<void>((resolve) => {
          const child = spawn('docker', ['volume', 'rm', volume], { stdio: ['ignore', 'pipe', 'pipe'] });
          child.on('close', () => resolve());
          child.on('error', () => resolve());
        });
      }
    } catch {
      // Best effort — volume cleanup must never block teardown
    }
  }

  /**
   * Wait for the inner Claude agent to be ready inside the container.
   * Checks every `intervalMs` for up to `timeoutMs` by exec-ing into
   * the container and looking for a running claude process or readiness file.
   */
  async waitForClaudeReady(
    containerId: string,
    runtime: ContainerRuntime,
    timeoutMs: number = 60000,
    intervalMs: number = 2000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        // Check for readiness file first (most reliable)
        const readyResult = await runtime.exec(containerId, [
          'test', '-f', '/tmp/claude-ready',
        ]);
        if (readyResult.exitCode === 0) return;
      } catch {
        // exec failed — container may still be starting
      }

      try {
        // Fallback: check if claude or opencode process is running.
        // The marker file check above is load-bearing; this is a secondary signal only.
        const psResult = await runtime.exec(containerId, [
          'pgrep', '-f', 'claude|opencode',
        ]);
        if (psResult.exitCode === 0 && psResult.stdout.trim()) return;
      } catch {
        // exec failed — container may still be starting
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Claude agent in container "${containerId}" not ready after ${timeoutMs / 1000}s`
    );
  }

  async dispatchTask(
    stackId: string,
    prompt: string,
    model?: string,
    opts?: {
      gateApproved?: boolean;
      forceBypass?: boolean;
      skipTicketFetch?: boolean;
      /** Override which touchpoint drives the execution phase routing (default: 'execution'). */
      executionTouchpoint?: TouchpointId;
    }
  ): Promise<DispatchTaskResult> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    // If no model specified, use project's effective default
    if (!model) {
      const effective = this.registry.getEffectiveModels(stack.project_dir);
      model = effective.inner_model;
    }

    // Resolve "auto" → undefined so the CLI never receives "--model auto"
    if (model === 'auto') {
      model = undefined;
    }

    // Spec quality gate: enforced on the FIRST dispatch (usually the one
    // `createStack` issues with the ticket body). If the stack already has
    // prior task history, treat this call as a resume/continuation — the
    // gate ran at creation time, and re-enforcing it now would block every
    // legitimate resume. This is the #273 env-friction fix.
    const priorTasks = this.registry.getTasksForStack(stackId);
    const isResume = priorTasks.length > 0;
    if (!isResume) {
      this.enforceSpecGate({
        ticket: stack.ticket ?? undefined,
        task: prompt,
        gateApproved: opts?.gateApproved,
        forceBypass: opts?.forceBypass,
      });
    }

    // If the stack has a ticket number, fetch the full ticket context
    // via the built-in provider and prepend it to the prompt.
    // Skipped when the caller has already embedded ticket context in the prompt
    // (e.g. re-dispatch of an interrupted task whose stored prompt includes it).
    if (stack.ticket && !opts?.skipTicketFetch) {
      const ticketConfig = this.registry.getProjectTicketConfig(stack.project_dir);
      if (ticketConfig) {
        const ticketContext = await fetchTicketWithConfig(stack.ticket, ticketConfig, stack.project_dir);
        if (ticketContext) {
          prompt = `${ticketContext}\n\n---\n\n## Task\n\n${prompt}`;
        }
      }
    }

    // Resolve any external references (gists, mockups, docs) cited in the prompt
    // and append their content so the inner agent has the full spec without egress.
    const references = await resolveTicketReferences(prompt);
    const referencesSection = renderResolvedReferences(references);
    if (referencesSection) {
      prompt = `${prompt}\n\n---\n\n${referencesSection}`;
    }

    const task = this.registry.createTask(stackId, prompt, model);

    const runtime = this.getRuntimeForStack(stack);
    let promptTmpDir: string | undefined;

    try {
      let claudeContainer = await this.findClaudeContainer(stack, runtime);

      // Env-friction fix: if containers are exited (common pause/resume
      // scenario), bring the stack up synchronously before dispatching
      // rather than failing and forcing the caller to re-probe. Status is
      // re-checked after the start so we act on the fresh container.
      if (claudeContainer.status !== 'running') {
        await this.ensureStackContainersRunning(stack, stackId);
        claudeContainer = await this.findClaudeContainer(stack, runtime);
      }

      // Wait for the inner Claude agent to be ready before dispatching
      await this.waitForClaudeReady(claudeContainer.id, runtime);

      // Use the sandstorm CLI to dispatch the task. The CLI's `task` command
      // handles credential sync (OAuth), writes files as the correct user
      // (`-u claude`), and creates the trigger file with proper ownership —
      // preventing the infinite-loop and not-logged-in bugs.
      const execTouchpoint = opts?.executionTouchpoint ?? 'execution';
      const execDesc = this.registry.getEffectiveTouchpointDescriptor(stack.project_dir, execTouchpoint);
      const reviewDesc = this.registry.getEffectiveTouchpointDescriptor(stack.project_dir, 'review');
      const metaDesc = this.registry.getEffectiveTouchpointDescriptor(stack.project_dir, 'meta_review');

      // --models-json: kept for backward-compat single-backend stacks
      const phaseModelsJson = JSON.stringify({
        execution:   execDesc.model   || 'auto',
        review:      reviewDesc.model || 'auto',
        meta_review: metaDesc.model   || 'auto',
      });
      // --phase-routing-json: per-phase backend+provider+model for mixed-backend stacks
      const phaseRoutingJson = JSON.stringify({
        execution:   { backend: execDesc.backend,   provider: execDesc.provider,   model: execDesc.model   || 'auto' },
        review:      { backend: reviewDesc.backend, provider: reviewDesc.provider, model: reviewDesc.model || 'auto' },
        meta_review: { backend: metaDesc.backend,   provider: metaDesc.provider,   model: metaDesc.model   || 'auto' },
      });
      const cliArgs = ['task', stackId];
      if (model) cliArgs.push('--model', model);
      cliArgs.push('--models-json', phaseModelsJson);
      cliArgs.push('--phase-routing-json', phaseRoutingJson);
      promptTmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sandstorm-task-'));
      const promptTmpFile = path.join(promptTmpDir, 'prompt.txt');
      await fs.promises.writeFile(promptTmpFile, prompt, 'utf-8');
      cliArgs.push('--file', promptTmpFile);

      const result = await this.runCli(stack.project_dir, cliArgs);
      fs.promises.rm(promptTmpDir, { recursive: true, force: true }).catch(() => {});

      if (result.exitCode !== 0) {
        throw new SandstormError(
          ErrorCode.TASK_DISPATCH_FAILED,
          result.stderr.trim() || result.stdout.trim() || 'Task dispatch failed'
        );
      }

      // Start watching for completion
      this.taskWatcher.watch(stackId, claudeContainer.id);

      // Stream live output to renderer (fire-and-forget)
      this.taskWatcher.streamOutput(stackId, claudeContainer.id, () => {}).catch(() => {});

      return { id: task.id, stack_id: stackId, status: task.status };
    } catch (err) {
      if (promptTmpDir) {
        fs.promises.rm(promptTmpDir, { recursive: true, force: true }).catch(() => {});
      }
      // Task was created but dispatch failed — mark it as failed so the
      // stack doesn't stay stuck in 'running' status forever.
      this.registry.completeTask(task.id, 1);
      this.notifyUpdate();
      throw err;
    }
  }

  async getStackWithServices(stackId: string): Promise<StackWithServices | undefined> {
    const stack = this.registry.getStack(stackId);
    if (!stack) return undefined;

    const services = await this.getServices(stack);
    return { ...stack, services };
  }

  async listStacksWithServices(): Promise<StackWithServices[]> {
    const stacks = this.registry.listStacks();
    const results: StackWithServices[] = [];

    for (const stack of stacks) {
      const services = await this.getServices(stack);
      results.push({ ...stack, services });
    }

    return results;
  }

  async getDiff(stackId: string): Promise<string> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    const result = await this.runCli(stack.project_dir, ['diff', stackId]);
    return result.stdout;
  }

  async push(
    stackId: string,
    message?: string,
    opts?: { prTitle?: string; prBodyFile?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    // Always include the message positionally so flags can follow without
    // colliding with `${POSITIONAL[2]}` in the bash arg parser.
    const args = ['push', stackId, message ?? `Changes from Sandstorm stack ${stackId}`];
    if (opts?.prTitle) args.push('--pr-title', opts.prTitle);
    if (opts?.prBodyFile) args.push('--pr-body-file', opts.prBodyFile);

    const result = await this.runCli(stack.project_dir, args);
    if (result.exitCode !== 0) {
      throw new SandstormError(ErrorCode.COMPOSE_FAILED, result.stderr.trim() || result.stdout.trim() || 'Push failed');
    }

    this.registry.updateStackStatus(stackId, 'pushed');
    this.notifyUpdate();
    return { stdout: result.stdout, stderr: result.stderr };
  }

  setPullRequest(stackId: string, prUrl: string, prNumber: number): void {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    this.registry.setPullRequest(stackId, prUrl, prNumber);

    if (stack.ticket) {
      this.registry.advanceTicketToPrOpenIfInStack(stack.ticket, stack.project_dir);
    }

    this.notifyUpdate();
  }

  async execInContainer(stackId: string, cmd: string[]): Promise<void> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    const runtime = this.getRuntimeForStack(stack);
    const claudeContainer = await this.findClaudeContainer(stack, runtime);
    const result = await runtime.exec(claudeContainer.id, cmd, { workdir: '/app', user: 'claude' });
    if (result.exitCode !== 0) {
      throw new Error(
        `exec in container failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
  }

  getTaskStatus(stackId: string): TaskStatusResult {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    const runningTask = this.registry.getRunningTask(stackId);
    if (runningTask) {
      return {
        status: 'running',
        id: runningTask.id,
        started_at: runningTask.started_at,
        finished_at: runningTask.finished_at,
        exit_code: runningTask.exit_code,
      };
    }

    const tasks = this.registry.getTasksForStack(stackId);
    if (tasks.length > 0) {
      const t = tasks[0];
      return {
        status: t.status,
        id: t.id,
        started_at: t.started_at,
        finished_at: t.finished_at,
        exit_code: t.exit_code,
      };
    }

    return { status: 'idle' };
  }

  async getTaskOutput(stackId: string, lines: number = 50): Promise<string> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    const runtime = this.getRuntimeForStack(stack);
    const claudeContainer = await this.findClaudeContainer(stack, runtime);

    try {
      const result = await runtime.exec(claudeContainer.id, [
        'tail', '-n', String(lines), '/tmp/claude-task.log',
      ]);
      return tailBytes(result.stdout, TASK_OUTPUT_MAX_BYTES);
    } catch {
      return '(no task output available)';
    }
  }

  async getLogs(stackId: string, service?: string): Promise<string> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    const composeProjectName = composeProjectNameFor(stack.project, stack.id);
    const filterName = service
      ? `${composeProjectName}-${service}`
      : composeProjectName;
    const runtime = this.getRuntimeForStack(stack);
    const containers = await runtime.listContainers({ name: filterName });

    if (containers.length === 0) {
      throw new SandstormError(ErrorCode.CONTAINER_UNREACHABLE, `No containers found for stack "${stackId}"${service ? ` service "${service}"` : ''}`);
    }

    const logParts: string[] = [];
    for (const c of containers) {
      const chunks: string[] = [];
      for await (const chunk of runtime.logs(c.id, { tail: 100 })) {
        chunks.push(chunk);
      }
      const serviceName = this.extractServiceName(c.name, composeProjectName);
      const capped = tailBytes(chunks.join(''), LOGS_PER_CONTAINER_MAX_BYTES);
      logParts.push(`=== ${serviceName} ===\n${capped}`);
    }

    return tailBytes(logParts.join('\n\n'), LOGS_TOTAL_MAX_BYTES);
  }

  getTasksForStack(stackId: string): Task[] {
    return this.registry.getTasksForStack(stackId);
  }

  listStackHistory(): StackHistoryRecord[] {
    return this.registry.listStackHistory();
  }

  async getStackMemoryUsage(stackId: string): Promise<number> {
    const stats = await this.getStackDetailedStats(stackId);
    return stats.totalMemory;
  }

  async getStackDetailedStats(stackId: string): Promise<DetailedStackStats> {
    const stack = this.registry.getStack(stackId);
    if (!stack) return { stackId, totalMemory: 0, containers: [] };

    const composeProjectName = composeProjectNameFor(stack.project, stack.id);
    const runtime = this.getRuntimeForStack(stack);
    const containers = await runtime.listContainers({ name: composeProjectName });

    const entries: ContainerStatsEntry[] = [];
    let totalMemory = 0;

    for (const c of containers) {
      if (c.status !== 'running') continue;
      try {
        const stats = await runtime.containerStats(c.id);
        const serviceName = this.extractServiceName(c.name, composeProjectName);
        entries.push({
          name: serviceName,
          containerId: c.id,
          memoryUsage: stats.memoryUsage,
          memoryLimit: stats.memoryLimit,
          cpuPercent: stats.cpuPercent,
        });
        totalMemory += stats.memoryUsage;
      } catch {
        // Container may have stopped between list and stats call
      }
    }

    return { stackId, totalMemory, containers: entries };
  }

  getStackTaskMetrics(stackId: string): TaskMetrics {
    const tasks = this.registry.getTasksForStack(stackId);
    let completedTasks = 0;
    let failedTasks = 0;
    let runningTasks = 0;
    let totalDurationMs = 0;
    let durationCount = 0;

    for (const task of tasks) {
      if (task.status === 'completed') {
        completedTasks++;
        if (task.finished_at && task.started_at) {
          const dur = new Date(task.finished_at).getTime() - new Date(task.started_at).getTime();
          if (dur > 0) { totalDurationMs += dur; durationCount++; }
        }
      } else if (task.status === 'failed') {
        failedTasks++;
      } else {
        runningTasks++;
      }
    }

    return {
      stackId,
      totalTasks: tasks.length,
      completedTasks,
      failedTasks,
      runningTasks,
      avgTaskDurationMs: durationCount > 0 ? totalDurationMs / durationCount : 0,
    };
  }

  // --- Workflow Progress ---

  async getWorkflowProgress(stackId: string) {
    // Try live progress first (running tasks)
    const liveProgress = await this.taskWatcher.getWorkflowProgress(stackId);
    if (liveProgress) return liveProgress;

    // Fall back to reconstructed progress from the most recent completed task
    return this.reconstructWorkflowProgress(stackId);
  }

  private reconstructWorkflowProgress(stackId: string): WorkflowProgressData | null {
    const task = this.registry.getMostRecentTask(stackId);
    if (!task) return null;

    const tokenSteps = this.registry.getTaskTokenSteps(task.id);

    // Determine final phase statuses based on task status and timing data
    type PhaseStatus = 'pending' | 'running' | 'passed' | 'failed';
    const phases: Array<{ phase: string; status: PhaseStatus }> = [];
    let currentPhase: WorkflowProgressData['currentPhase'] = 'idle';

    if (task.status === 'running') {
      // Should have been caught by live progress, but handle gracefully
      return null;
    } else if (task.status === 'completed') {
      currentPhase = 'idle';
      phases.push({ phase: 'execution', status: 'passed' });
      phases.push({ phase: 'review', status: 'passed' });
      phases.push({ phase: 'verify', status: 'passed' });
    } else if (task.status === 'failed') {
      // Determine which phase failed based on timing data
      if (task.verify_started_at && !task.verify_finished_at) {
        currentPhase = 'verify';
        phases.push({ phase: 'execution', status: 'passed' });
        phases.push({ phase: 'review', status: 'passed' });
        phases.push({ phase: 'verify', status: 'failed' });
      } else if (task.review_started_at && !task.review_finished_at) {
        currentPhase = 'review';
        phases.push({ phase: 'execution', status: 'passed' });
        phases.push({ phase: 'review', status: 'failed' });
        phases.push({ phase: 'verify', status: 'pending' });
      } else {
        currentPhase = 'execution';
        phases.push({ phase: 'execution', status: 'failed' });
        phases.push({ phase: 'review', status: 'pending' });
        phases.push({ phase: 'verify', status: 'pending' });
      }
    } else {
      // stopped, cancelled, etc.
      currentPhase = 'idle';
      phases.push({ phase: 'execution', status: task.execution_started_at ? 'passed' : 'pending' });
      phases.push({ phase: 'review', status: task.review_started_at ? 'passed' : 'pending' });
      phases.push({ phase: 'verify', status: task.verify_started_at ? 'passed' : 'pending' });
    }

    const steps = tokenSteps.map((s) => ({
      phase: s.phase,
      iteration: s.iteration,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      live: false,
    }));

    return {
      stackId,
      currentPhase,
      outerIteration: task.verify_retries + 1,
      innerIteration: task.review_iterations + 1,
      phases,
      steps,
      taskPrompt: task.prompt,
      startedAt: task.started_at,
      model: task.resolved_model || task.model,
    };
  }

  // --- Token Usage ---

  getStackTokenUsage(stackId: string): TokenUsageStats {
    const usage = this.registry.getStackTokenUsage(stackId);
    return {
      stackId,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
    };
  }

  getGlobalTokenUsage(): GlobalTokenUsage {
    // Use token columns already on the Stack objects to avoid N+1 queries
    const stacks = this.registry.listStacks();
    let totalInput = 0;
    let totalOutput = 0;
    const perStack: TokenUsageStats[] = [];
    const projectMap = new Map<string, { project: string; project_dir: string; input: number; output: number }>();

    for (const stack of stacks) {
      totalInput += stack.total_input_tokens;
      totalOutput += stack.total_output_tokens;
      if (stack.total_input_tokens > 0 || stack.total_output_tokens > 0) {
        perStack.push({
          stackId: stack.id,
          input_tokens: stack.total_input_tokens,
          output_tokens: stack.total_output_tokens,
          total_tokens: stack.total_input_tokens + stack.total_output_tokens,
        });
      }

      // Aggregate per-project
      const existing = projectMap.get(stack.project_dir);
      if (existing) {
        existing.input += stack.total_input_tokens;
        existing.output += stack.total_output_tokens;
      } else {
        projectMap.set(stack.project_dir, {
          project: stack.project,
          project_dir: stack.project_dir,
          input: stack.total_input_tokens,
          output: stack.total_output_tokens,
        });
      }
    }

    const perProject: ProjectTokenUsage[] = [];
    for (const entry of projectMap.values()) {
      if (entry.input > 0 || entry.output > 0) {
        perProject.push({
          project: entry.project,
          project_dir: entry.project_dir,
          input_tokens: entry.input,
          output_tokens: entry.output,
          total_tokens: entry.input + entry.output,
        });
      }
    }

    return {
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_tokens: totalInput + totalOutput,
      per_stack: perStack.sort((a, b) => b.total_tokens - a.total_tokens),
      per_project: perProject.sort((a, b) => b.total_tokens - a.total_tokens),
    };
  }

  getRateLimitState(): RateLimitState {
    const stacks = this.registry.listStacks();
    const rateLimitedStacks = stacks.filter(s => s.status === 'rate_limited');

    if (rateLimitedStacks.length === 0) {
      return { active: false, reset_at: null, affected_stacks: [], reason: null };
    }

    // Find the latest reset_at among all rate-limited stacks
    const resetTimes = rateLimitedStacks
      .map(s => s.rate_limit_reset_at)
      .filter((t): t is string => t !== null);
    const reset_at = resetTimes.length > 0
      ? resetTimes.reduce((latest, t) => (t > latest ? t : latest))
      : null;

    const reasons = rateLimitedStacks
      .map(s => s.error)
      .filter((e): e is string => e !== null);
    const reason = reasons.length > 0 ? reasons[0] : null;

    return {
      active: true,
      reset_at,
      affected_stacks: rateLimitedStacks.map(s => s.id),
      reason,
    };
  }

  // --- Private helpers ---

  private async getServices(stack: Stack): Promise<ServiceInfo[]> {
    const composeProjectName = composeProjectNameFor(stack.project, stack.id);
    const runtime = this.getRuntimeForStack(stack);
    const containers = await runtime.listContainers({
      name: composeProjectName,
    });

    // Get exposed ports from registry (only ports that have been exposed via proxy)
    const exposedPorts = this.registry.getPorts(stack.id);
    const exposedByService = new Map<string, Array<{ host_port: number; container_port: number; proxy_container_id: string | null }>>();
    for (const p of exposedPorts) {
      const list = exposedByService.get(p.service) ?? [];
      list.push(p);
      exposedByService.set(p.service, list);
    }

    // Get known internal ports from PORT_MAP in config
    const knownPorts = this.discoverKnownPorts(stack.project_dir);

    return containers.map((c) => {
      const serviceName = this.extractServiceName(c.name, composeProjectName);
      const exposed = exposedByService.get(serviceName) ?? [];
      const known = knownPorts.get(serviceName) ?? [];

      // Build port exposure list: merge known internal ports with exposed state
      const portExposures: PortExposure[] = [];
      const seenPorts = new Set<number>();

      for (const exp of exposed) {
        seenPorts.add(exp.container_port);
        portExposures.push({
          containerPort: exp.container_port,
          hostPort: exp.host_port,
          exposed: !!exp.proxy_container_id,
        });
      }

      for (const cp of known) {
        if (!seenPorts.has(cp)) {
          portExposures.push({ containerPort: cp, exposed: false });
        }
      }

      // Legacy compat: pick the first exposed port for hostPort/containerPort
      const firstExposed = exposed.find(e => !!e.proxy_container_id);

      return {
        name: serviceName,
        status: c.status,
        exitCode: c.status === 'exited' ? undefined : undefined,
        hostPort: firstExposed?.host_port,
        containerPort: firstExposed?.container_port,
        containerId: c.id,
        ports: portExposures,
      };
    });
  }

  /**
   * Read known internal ports per service from .sandstorm/config PORT_MAP.
   */
  private discoverKnownPorts(projectDir: string): Map<string, number[]> {
    const result = new Map<string, number[]>();
    try {
      const configPath = path.join(projectDir, '.sandstorm', 'config');
      if (!fs.existsSync(configPath)) return result;

      const config = fs.readFileSync(configPath, 'utf-8');
      const portMapLine = config.split('\n').find((l) => l.startsWith('PORT_MAP='));
      if (!portMapLine) return result;

      const portMapValue = portMapLine.split('=')[1]?.replace(/"/g, '');
      if (!portMapValue) return result;

      for (const entry of portMapValue.split(',')) {
        const [service, , containerPort] = entry.split(':');
        const cp = parseInt(containerPort, 10);
        if (service && !isNaN(cp)) {
          const list = result.get(service) ?? [];
          list.push(cp);
          result.set(service, list);
        }
      }
    } catch {
      // Best effort
    }
    return result;
  }

  private async findClaudeContainer(stack: Stack, runtime?: ContainerRuntime): Promise<Container> {
    const resolvedRuntime = runtime ?? this.getRuntimeForStack(stack);
    const composeProjectName = composeProjectNameFor(stack.project, stack.id);
    const containers = await resolvedRuntime.listContainers({
      name: `${composeProjectName}-claude`,
    });
    if (!containers[0]) {
      // Surface the expected container name to help diagnose naming mismatches
      // (e.g. stack ID starts with a digit but CLI used a different convention).
      throw new SandstormError(
        ErrorCode.CONTAINER_UNREACHABLE,
        `Agent container not found for stack "${stack.id}". Expected container matching "${composeProjectName}-claude". ` +
        `Check that Docker containers are running (docker ps) and that the compose project name matches.`
      );
    }
    return containers[0];
  }

  private extractServiceName(containerName: string, projectName: string): string {
    // Container names are typically: projectName-service-1
    const withoutProject = containerName.replace(`${projectName}-`, '');
    return withoutProject.replace(/-\d+$/, '');
  }

  private discoverServicePorts(projectDir: string): Promise<ServicePort[]> {
    try {
      // Read .sandstorm/config for PORT_MAP
      const configPath = path.join(projectDir, '.sandstorm', 'config');
      if (!fs.existsSync(configPath)) return Promise.resolve([]);

      const config = fs.readFileSync(configPath, 'utf-8');
      const portMapLine = config
        .split('\n')
        .find((l) => l.startsWith('PORT_MAP='));
      if (!portMapLine) return Promise.resolve([]);

      const portMapValue = portMapLine.split('=')[1]?.replace(/"/g, '');
      if (!portMapValue) return Promise.resolve([]);

      // Format: service:host_port:container_port:index,...
      // Use service_index as the key to match compose env var format: SANDSTORM_PORT_<service>_<index>
      return Promise.resolve(
        portMapValue.split(',').map((entry) => {
          const [service, , containerPort, index] = entry.split(':');
          return {
            service: `${service}_${index || '0'}`,
            containerPort: parseInt(containerPort, 10),
          };
        })
      );
    } catch {
      // Project directory not accessible — return empty ports
      return Promise.resolve([]);
    }
  }

  // --- Stale Workspace Detection & Cleanup ---

  /**
   * Detect stale/orphaned workspace directories by cross-referencing:
   * 1. Workspace directories on disk (.sandstorm/workspaces/<id>/)
   * 2. Active stacks in the SQLite registry
   * 3. Running Docker containers
   *
   * A workspace is considered stale if:
   * - It has no matching active stack in the registry, OR
   * - Its matching stack has status "completed" or "failed"
   * AND there are no running containers for it.
   */
  async detectStaleWorkspaces(): Promise<StaleWorkspace[]> {
    const projects = this.registry.listProjects();
    const activeStacks = this.registry.listStacks();
    const activeStackIds = new Set(activeStacks.map((s) => s.id));
    const staleWorkspaces: StaleWorkspace[] = [];

    for (const project of projects) {
      const workspacesDir = path.join(project.directory, '.sandstorm', 'workspaces');
      if (!fs.existsSync(workspacesDir)) continue;

      let entries: string[];
      try {
        entries = fs.readdirSync(workspacesDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const workspacePath = path.join(workspacesDir, entry);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(workspacePath);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;

        const stackId = entry;
        const matchingStack = activeStacks.find((s) => s.id === stackId);

        // Skip if stack is in an active/transitional state
        if (matchingStack) {
          const activeStatuses = new Set([
            'building', 'rebuilding', 'up', 'running', 'idle',
            'stopped', 'pushed', 'pr_created', 'rate_limited',
          ]);
          if (activeStatuses.has(matchingStack.status)) continue;
        }

        // Check for running containers
        let hasRunningContainers = false;
        try {
          const composeProjectName = composeProjectNameFor(project.name, stackId);
          const containers = await this.dockerRuntime.listContainers({ name: composeProjectName });
          hasRunningContainers = containers.some((c) => c.status === 'running');
        } catch {
          // Docker query failed — be conservative, don't flag as stale
        }

        if (hasRunningContainers) continue;

        // Calculate directory size (best effort, top-level only for speed)
        let sizeBytes = 0;
        try {
          sizeBytes = this.estimateDirectorySize(workspacePath);
        } catch {
          // Size estimation failed — proceed with 0
        }

        // Check for unpushed git changes
        let hasUnpushedChanges = false;
        try {
          hasUnpushedChanges = this.checkUnpushedChanges(workspacePath);
        } catch {
          // Git check failed — be conservative, assume unpushed
          hasUnpushedChanges = true;
        }

        const reason: StaleWorkspace['reason'] = !matchingStack && !activeStackIds.has(stackId)
          ? 'orphaned'
          : 'completed';

        staleWorkspaces.push({
          stackId,
          project: project.name,
          projectDir: project.directory,
          workspacePath,
          sizeBytes,
          hasUnpushedChanges,
          reason,
          lastModified: stat.mtime.toISOString(),
        });
      }
    }

    return staleWorkspaces;
  }

  /**
   * Clean up specific stale workspace directories.
   * Uses a Docker container to handle files owned by container users.
   */
  async cleanupStaleWorkspaces(workspacePaths: string[]): Promise<CleanupResult[]> {
    const results: CleanupResult[] = [];
    const projects = this.registry.listProjects();

    for (const workspacePath of workspacePaths) {
      try {
        // Validate path is within a registered project's .sandstorm/workspaces/ directory
        const normalized = path.resolve(workspacePath);
        const owningProject = projects.find((project) => {
          const allowedDir = path.resolve(path.join(project.directory, '.sandstorm', 'workspaces'));
          return normalized.startsWith(allowedDir + path.sep) || normalized === allowedDir;
        });

        if (!owningProject) {
          results.push({ workspacePath, success: false, error: 'Path is not within a registered project workspace directory' });
          continue;
        }

        // Remove volumes before the workspace dir (best effort; failure never flips success)
        const stackId = path.basename(normalized);
        await this.removeVolumesForProject(composeProjectNameFor(owningProject.name, stackId));

        // Use Docker to remove (handles files owned by container users)
        const parentDir = path.dirname(normalized);
        const dirName = path.basename(normalized);

        try {
          const child = spawn('docker', [
            'run', '--rm',
            '-v', `${parentDir}:/workspaces`,
            'alpine',
            'rm', '-rf', `/workspaces/${dirName}`,
          ], { stdio: ['ignore', 'pipe', 'pipe'] });

          await new Promise<void>((resolve, reject) => {
            child.on('close', (code) => {
              if (code === 0 || !fs.existsSync(workspacePath)) {
                resolve();
              } else {
                reject(new Error(`Docker rm exited with code ${code}`));
              }
            });
            child.on('error', reject);
          });
        } catch {
          // Fallback: try direct rm
          fs.rmSync(workspacePath, { recursive: true, force: true });
        }

        results.push({ workspacePath, success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ workspacePath, success: false, error: message });
      }
    }

    return results;
  }

  /**
   * Rough estimate of directory size by summing immediate children.
   * Not recursive for performance — gives a lower bound.
   */
  private estimateDirectorySize(dirPath: string): number {
    let totalSize = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        try {
          const entryPath = path.join(dirPath, entry.name);
          const stat = fs.statSync(entryPath);
          totalSize += stat.size;
          // For directories, add a rough estimate based on the stat block size
          if (entry.isDirectory()) {
            totalSize += 4096; // minimum directory overhead
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    } catch {
      // Directory not readable
    }
    return totalSize;
  }

  /**
   * Check if a workspace git repo has unpushed changes.
   */
  private checkUnpushedChanges(workspacePath: string): boolean {
    try {
      // Check for uncommitted changes
      const statusResult = execSync('git status --porcelain', {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (statusResult.trim().length > 0) return true;

      // Check for commits ahead of remote
      try {
        const logResult = execSync('git log @{upstream}..HEAD --oneline 2>/dev/null', {
          cwd: workspacePath,
          encoding: 'utf-8',
          timeout: 5000,
          shell: '/bin/sh',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (logResult.trim().length > 0) return true;
      } catch {
        // No upstream configured — check if there are any commits at all
        try {
          const logResult = execSync('git log --oneline -1', {
            cwd: workspacePath,
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          if (logResult.trim().length > 0) return true;
        } catch {
          // Empty repo or not a git repo
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Wait for a specific dispatched task to reach a terminal state.
   * Event-driven via TaskWatcher, with a 2-second polling backstop and a
   * bounded timeout (default 30 minutes).
   */
  awaitTaskCompletion(
    stackId: string,
    taskId: number,
    opts?: { timeoutMs?: number }
  ): Promise<Task> {
    const timeoutMs = opts?.timeoutMs ?? 30 * 60 * 1000;

    return new Promise<Task>((resolve, reject) => {
      let settled = false;
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const settle = (task?: Task, err?: Error) => {
        if (settled) return;
        settled = true;
        this.taskWatcher.removeListener('task:completed', onCompleted);
        this.taskWatcher.removeListener('task:failed', onFailed);
        if (pollInterval !== null) clearInterval(pollInterval);
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        if (err) reject(err);
        else resolve(task!);
      };

      const isTerminal = (t: Task) =>
        t.status === 'completed' || t.status === 'failed' || t.status === 'needs_human';

      const onCompleted = ({ stackId: sid, task }: { stackId: string; task: Task }) => {
        if (sid === stackId && task.id === taskId) settle(task);
      };
      const onFailed = ({ stackId: sid, task }: { stackId: string; task: Task }) => {
        if (sid === stackId && task.id === taskId) settle(task);
      };

      this.taskWatcher.on('task:completed', onCompleted);
      this.taskWatcher.on('task:failed', onFailed);

      // Backstop: poll every 2 s in case the terminal event was emitted before
      // the listener was registered.
      pollInterval = setInterval(() => {
        try {
          const tasks = this.registry.getTasksForStack(stackId);
          const task = tasks.find(t => t.id === taskId);
          if (task && isTerminal(task)) settle(task);
        } catch { /* best effort */ }
      }, 2000);

      timeoutHandle = setTimeout(() => {
        settle(
          undefined,
          new SandstormError(
            ErrorCode.TASK_DISPATCH_FAILED,
            'Auto-resolve timed out waiting for task completion'
          )
        );
      }, timeoutMs);

      // Immediate backstop: task may already be terminal before we set up listeners.
      try {
        const tasks = this.registry.getTasksForStack(stackId);
        const task = tasks.find(t => t.id === taskId);
        if (task && isTerminal(task)) { settle(task); return; }
      } catch { /* ignore */ }
    });
  }

  /**
   * Resolve merge conflicts for the PR associated with `ticketId` / `projectDir`.
   * Queries GitHub for the PR's merge state, dispatches the inner agent to merge
   * the base branch and resolve conflicts, waits for the task to complete, and
   * pushes the result on success.
   *
   * The associated stack is reused if it exists; if it was torn down, it is
   * recreated from the branch stored in history and torn down again afterwards.
   */
  async autoResolveConflicts(ticketId: string, projectDir: string): Promise<AutoResolveResult> {
    // Find live stack for this ticket
    const liveStack = this.registry.listStacks().find(
      s => s.ticket === ticketId && s.project_dir === projectDir
    ) ?? null;

    let stackId: string | null = liveStack?.id ?? null;
    let autoCreated = false;

    // Workspace dir for gh commands: use the stack workspace if it exists, else projectDir
    const ghCwd = liveStack
      ? workspacePathFor(projectDir, liveStack.id)
      : projectDir;

    // === Determine PR info ===
    let mergeable: string;
    let baseRefName: string;

    if (liveStack && liveStack.pr_number != null) {
      // Live stack with a known PR number
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'view', String(liveStack.pr_number), '--json', 'mergeable,mergeStateStatus,baseRefName'],
        { cwd: ghCwd, timeout: 30000, maxBuffer: 1024 * 1024 }
      );
      const pr = JSON.parse(stdout.trim()) as { mergeable: string; mergeStateStatus: string; baseRefName: string };
      mergeable = pr.mergeable ?? 'UNKNOWN';
      baseRefName = pr.baseRefName;
    } else if (!liveStack) {
      // Stack torn down — look in history for the branch
      const history = this.registry.listStackHistory()
        .filter(h => h.ticket === ticketId && h.project_dir === projectDir)
        .sort((a, b) => new Date(b.finished_at).getTime() - new Date(a.finished_at).getTime())[0];

      if (!history?.branch) {
        throw new SandstormError(
          ErrorCode.STACK_NOT_FOUND,
          `No stack found for ticket ${ticketId} in project ${projectDir}`
        );
      }

      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'list', '--head', history.branch, '--json', 'number,mergeable,mergeStateStatus,baseRefName', '--state', 'open', '--limit', '1'],
        { cwd: projectDir, timeout: 30000, maxBuffer: 1024 * 1024 }
      );
      const prList = JSON.parse(stdout.trim()) as Array<{ number: number; mergeable: string; mergeStateStatus: string; baseRefName: string }>;

      if (prList.length === 0) {
        throw new SandstormError(
          ErrorCode.STACK_NOT_FOUND,
          `No open PR found for branch '${history.branch}'`
        );
      }

      const pr = prList[0];
      mergeable = pr.mergeable ?? 'UNKNOWN';
      baseRefName = pr.baseRefName;

      // Early-exit non-conflicting states before creating a new stack
      if (mergeable === 'MERGEABLE') return { status: 'no_conflicts' };
      if (mergeable !== 'CONFLICTING') return { status: 'unknown_state' };

      // CONFLICTING — recreate the stack from the branch
      const name = `auto-${ticketId.replace(/[^a-z0-9]/gi, '-').slice(0, 20)}-${Date.now().toString(36)}`;
      this.createStack({
        name,
        projectDir,
        ticket: ticketId,
        branch: history.branch,
        runtime: history.runtime,
        gateApproved: true,
      });
      stackId = name;
      autoCreated = true;

      // Wait for the build to complete (up to 3 min) before dispatching
      const buildDeadline = Date.now() + 180_000;
      while (Date.now() < buildDeadline) {
        const s = this.registry.getStack(stackId);
        if (!s || s.status === 'failed') {
          throw new SandstormError(ErrorCode.COMPOSE_FAILED, s?.error || 'Stack creation failed');
        }
        if (['up', 'idle', 'running', 'completed', 'pushed', 'pr_created'].includes(s.status)) break;
        await new Promise(r => setTimeout(r, 2000));
      }
    } else {
      // Live stack exists but has no pr_number
      return { status: 'failed', error: 'Stack has no associated PR number' };
    }

    // === Handle non-conflicting states ===
    if (mergeable === 'MERGEABLE') return { status: 'no_conflicts' };
    if (mergeable !== 'CONFLICTING') return { status: 'unknown_state' };

    // === Dispatch resolution task ===
    const resolvePrompt = [
      'Resolve merge conflicts with the base branch.',
      '',
      'Steps:',
      '1. Run `git fetch origin`',
      `2. Merge the base branch into the current branch: \`git merge origin/${baseRefName}\``,
      '3. Resolve any merge conflicts',
      '4. Ensure the working tree builds and all tests pass',
      '',
      'Do not force-push. Produce a clean merge commit.',
    ].join('\n');

    try {
      const dispatchResult = await this.dispatchTask(stackId!, resolvePrompt, undefined, {
        gateApproved: true,
        skipTicketFetch: true,
        executionTouchpoint: 'merge_conflict',
      });

      const terminalTask = await this.awaitTaskCompletion(stackId!, dispatchResult.id);

      if (terminalTask.exit_code !== 0) {
        return { status: 'failed', error: 'Auto-resolve failed: inner agent could not resolve conflicts or verify failed' };
      }

      await this.push(stackId!, 'Auto-resolve merge conflicts');
      return { status: 'resolved' };
    } finally {
      if (autoCreated && stackId) {
        await this.teardownStack(stackId).catch(() => {});
      }
    }
  }

  /**
   * Continue a failed stack on the same branch, repeatable.
   * Uses --resume <session_id> when available (Case A) so the agent retains context;
   * falls back to fresh dispatch (Case B) when session_id is null.
   * The guard is used as a within-call race lock only — reset to 0 on success and on failure.
   */
  async selfHealContinue(stackId: string): Promise<void> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    if (stack.status !== 'failed') {
      throw new SandstormError(ErrorCode.INVALID_INPUT, `Stack "${stackId}" is not in failed state`);
    }

    const task = this.registry.getMostRecentTask(stackId);
    if (!task) throw new SandstormError(ErrorCode.INTERNAL_ERROR, `No task found for stack "${stackId}"`);

    // Set guard as within-call race lock before dispatch
    this.registry.setSelfhealContinueUsed(stackId, 1);

    this.registry.updateStackStatus(stackId, 'building');
    this.notifyUpdate();
    try {
      await this.ensureStackContainersRunning(stack, stackId);
    } catch (err) {
      this.registry.setSelfhealContinueUsed(stackId, 0);
      this.registry.updateStackStatus(stackId, 'failed');
      this.notifyUpdate();
      throw err;
    }

    try {
      if (task.session_id) {
        // Case A: resume with existing Claude session — reopen task, reset iterations, dispatch continuation
        this.registry.reopenTaskForResume(task.id);
        this.registry.setTaskIterations(task.id, 0, task.verify_retries);
        const continuationPrompt =
          'Continue the prior work on this task. The review loop count has been reset — you have fresh review iterations to work with. Resume from where you left off.';
        await this.dispatchContinuation(stack, stackId, { ...task, status: 'running' }, continuationPrompt);
      } else {
        // Case B: no session_id — fresh dispatch of original task prompt
        await this.dispatchTask(stackId, task.prompt, task.model ?? undefined, {
          gateApproved: true,
          skipTicketFetch: true,
        });
      }
      // Reset guard on success so the stack remains continuable
      this.registry.setSelfhealContinueUsed(stackId, 0);
    } catch (err) {
      if (task.session_id) {
        // Revert reopened task to terminal state so it doesn't strand in running
        this.registry.completeTask(task.id, 1);
      }
      // Reset guard so the stack is not permanently blocked
      this.registry.setSelfhealContinueUsed(stackId, 0);
      this.registry.updateStackStatus(stackId, 'failed');
      this.notifyUpdate();
      throw err;
    }
  }

  /**
   * Compute the next `-rN` branch name for a ticket restart.
   * The original branch counts as r1, so the first restart is `-r2`.
   * N = 1 + max existing rK across active stacks + stack_history.
   */
  nextRestartBranch(ticketId: string, baseStackId: string): string {
    const existing = this.registry.getBranchesForTicket(ticketId);
    const prefix = `feat/${ticketId}-`;
    let maxR = 1;
    for (const branch of existing) {
      if (!branch.startsWith(prefix)) continue;
      const suffix = branch.slice(prefix.length);
      const parts = suffix.split('-');
      // Look for a trailing -rN segment
      const last = parts[parts.length - 1];
      if (/^r\d+$/.test(last)) {
        const n = parseInt(last.slice(1), 10);
        if (n > maxR) maxR = n;
      }
    }
    // Derive base name from the stack id (strip ticket prefix)
    const baseName = baseStackId.startsWith(prefix)
      ? baseStackId.slice(prefix.length).replace(/-r\d+$/, '')
      : baseStackId;
    return `${prefix}${baseName}-r${maxR + 1}`;
  }

  /**
   * Push the old failed branch to remote before teardown so the diff is preserved.
   * Runs commit-if-dirty then push. Throws on push failure (teardown must not proceed).
   */
  async pushOldBranchBeforeTeardown(stackId: string, ticketId: string): Promise<void> {
    await this.push(stackId, `wip: preserve failed-review state for ${ticketId}`);
  }

  /**
   * Re-incorporate findings into the ticket spec and restart on a fresh branch.
   * Sequence: update ticket body → push old branch → create new stack → dispatch → teardown old.
   * Teardown is skipped if push fails (guard against data loss).
   */
  async restartWithFindings(
    stackId: string,
    findings: string,
  ): Promise<{ newStackId: string }> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    if (stack.status !== 'failed') {
      throw new SandstormError(ErrorCode.INVALID_INPUT, `Stack "${stackId}" is not in failed state`);
    }
    const ticketId = stack.ticket;
    if (!ticketId) throw new SandstormError(ErrorCode.INVALID_INPUT, 'Stack has no associated ticket');

    // 1. Compose updated ticket body: original spec + appended findings
    const ticketConfig = this.registry.getProjectTicketConfig(stack.project_dir);
    let updatedTicketBody = findings;
    if (ticketConfig) {
      const originalBody = await fetchRawBodyWithConfig(ticketId, ticketConfig, stack.project_dir);
      if (originalBody) {
        updatedTicketBody = `${originalBody}\n\n---\n\n## Findings from failed attempt\n\n${findings}`;
      }
      await updateTicketWithConfig(ticketId, updatedTicketBody, ticketConfig, stack.project_dir);
    }

    // 2. Compute new branch name
    const newBranch = this.nextRestartBranch(ticketId, stackId);
    const newStackId = newBranch.replace(/^feat\//, '');

    // 3. Push old branch (commit-if-dirty + push) — MUST succeed before teardown
    await this.pushOldBranchBeforeTeardown(stackId, ticketId);

    // 4. Create new stack on new branch
    const newStack = this.createStack({
      name: newStackId,
      projectDir: stack.project_dir,
      ticket: ticketId,
      branch: newBranch,
      description: stack.description ?? undefined,
      runtime: stack.runtime,
      task: updatedTicketBody,
      forceBypass: true,
    });

    // 5. Tear down old stack (push already succeeded)
    await this.teardownStack(stackId);

    return { newStackId: newStack.id };
  }

  destroy(): void {
    // No-op: retained for API compatibility
  }
}

// --- Stale workspace types ---

export interface StaleWorkspace {
  stackId: string;
  project: string;
  projectDir: string;
  workspacePath: string;
  sizeBytes: number;
  hasUnpushedChanges: boolean;
  reason: 'orphaned' | 'completed';
  lastModified: string;
}

export interface CleanupResult {
  workspacePath: string;
  success: boolean;
  error?: string;
}
