import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Registry, Stack, StackHistoryRecord, Task, TokenUsage } from './registry';
import { PortAllocator, ServicePort } from './port-allocator';
import { PortProxy } from './port-proxy';
import { TaskWatcher, WorkflowProgressData } from './task-watcher';
import { ContainerRuntime, Container, ContainerStats } from '../runtime/types';
import { SandstormError, ErrorCode } from '../errors';
import { fetchTicketContext, referencesTicket } from './ticket-fetcher';

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

// referencesGitHubIssue is removed — use referencesTicket from ticket-fetcher.ts instead.
// Re-export for backwards compatibility with any external callers.
export { referencesTicket, referencesTicket as referencesGitHubIssue } from './ticket-fetcher';

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class StackManager {
  private onStackUpdate?: () => void;
  private appVersion: string;
  private portProxy?: PortProxy;

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
   */
  runCli(
    projectDir: string,
    args: string[],
    env?: Record<string, string>
  ): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', [this.getCliBin(), ...args], {
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
      child.on('close', (code) =>
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      );
      child.on('error', reject);
    });
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

    // Launch the heavy work in the background
    this.buildStackInBackground(opts, projectName).catch(() => {
      // Error already stored in registry by buildStackInBackground
    });

    return stack;
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
        // Fallback: check if claude process is running
        const psResult = await runtime.exec(containerId, [
          'pgrep', '-f', 'claude',
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
    opts?: { gateApproved?: boolean; forceBypass?: boolean }
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
    // via the project's fetch-ticket script and prepend it to the prompt
    if (stack.ticket) {
      const ticketContext = await fetchTicketContext(stack.ticket, stack.project_dir);
      if (ticketContext) {
        prompt = `${ticketContext}\n\n---\n\n## Task\n\n${prompt}`;
      }
    }

    const task = this.registry.createTask(stackId, prompt, model);

    const runtime = this.getRuntimeForStack(stack);

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
      const cliArgs = ['task', stackId];
      if (model) cliArgs.push('--model', model);
      cliArgs.push(prompt);
      const result = await this.runCli(stack.project_dir, cliArgs);

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
    this.notifyUpdate();
  }

  async execInContainer(stackId: string, cmd: string[]): Promise<void> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    const runtime = this.getRuntimeForStack(stack);
    const claudeContainer = await this.findClaudeContainer(stack, runtime);
    const result = await runtime.exec(claudeContainer.id, cmd, { workdir: '/app' });
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

    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
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

    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
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
    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
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
    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
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
          const composeProjectName = `sandstorm-${sanitizeComposeName(project.name)}-${sanitizeComposeName(stackId)}`;
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
        const isValidPath = projects.some((project) => {
          const allowedDir = path.resolve(path.join(project.directory, '.sandstorm', 'workspaces'));
          return normalized.startsWith(allowedDir + path.sep) || normalized === allowedDir;
        });

        if (!isValidPath) {
          results.push({ workspacePath, success: false, error: 'Path is not within a registered project workspace directory' });
          continue;
        }

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
