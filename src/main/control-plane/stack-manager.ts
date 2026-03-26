import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Registry, Stack, StackHistoryRecord, Task, TokenUsage } from './registry';
import { PortAllocator, ServicePort } from './port-allocator';
import { TaskWatcher } from './task-watcher';
import { ContainerRuntime, Container, ContainerStats } from '../runtime/types';
import { SandstormError, ErrorCode } from '../errors';
import { ParsedRateLimit } from './token-parser';

export interface CreateStackOpts {
  name: string;
  projectDir: string;
  ticket?: string;
  branch?: string;
  description?: string;
  runtime: 'docker' | 'podman';
  task?: string;
}

export interface StackWithServices extends Stack {
  services: ServiceInfo[];
}

export interface ServiceInfo {
  name: string;
  status: string;
  exitCode?: number;
  hostPort?: number;
  containerPort?: number;
  containerId: string;
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

export interface GlobalTokenUsage {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  per_stack: TokenUsageStats[];
}

export interface RateLimitState {
  active: boolean;
  reset_at: string | null;
  affected_stacks: string[];
  reason: string | null;
}

/**
 * Sanitize a string for use in Docker Compose project names.
 * Compose project names must consist only of lowercase alphanumeric characters,
 * hyphens, and underscores, and must start with a letter or underscore.
 */
export function sanitizeComposeName(input: string): string {
  let name = input
    .toLowerCase()
    .replace(/\s+/g, '-')       // spaces → hyphens
    .replace(/[^a-z0-9_-]/g, '') // strip invalid chars
    .replace(/-{2,}/g, '-')      // collapse repeated hyphens
    .replace(/^[-]+/, '')         // strip leading hyphens
    .replace(/[-]+$/, '');        // strip trailing hyphens

  // Must start with a letter or underscore
  if (name && !/^[a-z_]/.test(name)) {
    name = `s${name}`;
  }

  return name || 'stack';
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class StackManager {
  private onStackUpdate?: () => void;
  private rateLimitResumeTimers = new Map<string, NodeJS.Timeout>();
  private globalRateLimitActive = false;
  private globalRateLimitReason: string | null = null;

  constructor(
    private registry: Registry,
    private portAllocator: PortAllocator,
    private taskWatcher: TaskWatcher,
    private runtime: ContainerRuntime,
    private cliDir: string = ''
  ) {
    // When the task watcher detects a status change, push a UI update
    this.taskWatcher.setOnStatusChange(() => this.notifyUpdate());

    // Listen for rate limit events from the task watcher
    this.taskWatcher.on('task:rate_limited', ({ stackId, rateLimit }: { stackId: string; rateLimit: ParsedRateLimit }) => {
      this.handleRateLimit(stackId, rateLimit);
    });
  }

  setOnStackUpdate(callback: () => void): void {
    this.onStackUpdate = callback;
  }

  private notifyUpdate(): void {
    this.onStackUpdate?.();
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

  createStack(opts: CreateStackOpts): Stack {
    const projectName = path.basename(opts.projectDir);

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

  private async buildStackInBackground(opts: CreateStackOpts, _projectName: string): Promise<void> {
    try {
      // Allocate ports via PortAllocator (tracks in SQLite, finds free ports)
      const servicePorts = await this.discoverServicePorts(opts.projectDir);
      const portMap = await this.portAllocator.allocate(opts.name, servicePorts);

      // Build port env vars in the format the CLI/compose expects: SANDSTORM_PORT_<service>_<index>
      const portEnv: Record<string, string> = {};
      for (const [serviceKey, hostPort] of portMap) {
        portEnv[`SANDSTORM_PORT_${serviceKey}`] = String(hostPort);
      }

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

      // If a task was provided, dispatch it (with one retry on failure)
      if (opts.task) {
        try {
          await this.dispatchTask(opts.name, opts.task);
        } catch (firstErr) {
          // Wait and retry once — the container may need more time
          await new Promise((resolve) => setTimeout(resolve, 10000));
          try {
            await this.dispatchTask(opts.name, opts.task);
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

  private async startInBackground(stack: Stack, stackId: string): Promise<void> {
    try {
      const result = await this.runCli(stack.project_dir, ['start', stackId]);
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

  teardownStack(stackId: string): void {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    this.taskWatcher.unwatch(stackId);

    // Archive to history before deleting
    const finalStatus =
      stack.status === 'completed' ? 'completed' :
      stack.status === 'failed' ? 'failed' :
      'torn_down' as const;
    this.registry.archiveStack(stackId, finalStatus);

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
    timeoutMs: number = 60000,
    intervalMs: number = 2000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        // Check for readiness file first (most reliable)
        const readyResult = await this.runtime.exec(containerId, [
          'test', '-f', '/tmp/claude-ready',
        ]);
        if (readyResult.exitCode === 0) return;
      } catch {
        // exec failed — container may still be starting
      }

      try {
        // Fallback: check if claude process is running
        const psResult = await this.runtime.exec(containerId, [
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

  async dispatchTask(stackId: string, prompt: string): Promise<Task> {
    // Block dispatch if rate limited
    if (this.isRateLimited()) {
      const state = this.getRateLimitState();
      const resetMsg = state.reset_at
        ? ` Resets at ${new Date(state.reset_at).toLocaleTimeString()}.`
        : '';
      throw new SandstormError(
        ErrorCode.TASK_DISPATCH_FAILED,
        `Task dispatch blocked: rate limit active.${resetMsg} Tasks will auto-resume when limits reset.`
      );
    }

    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    const task = this.registry.createTask(stackId, prompt);

    try {
      const claudeContainer = await this.findClaudeContainer(stack);
      if (!claudeContainer) {
        throw new SandstormError(ErrorCode.CONTAINER_UNREACHABLE, `Agent container not found for stack "${stackId}"`);
      }

      // Wait for the inner Claude agent to be ready before dispatching
      await this.waitForClaudeReady(claudeContainer.id);

      // Use the sandstorm CLI to dispatch the task. The CLI's `task` command
      // handles credential sync (OAuth), writes files as the correct user
      // (`-u claude`), and creates the trigger file with proper ownership —
      // preventing the infinite-loop and not-logged-in bugs.
      const result = await this.runCli(stack.project_dir, ['task', stackId, prompt]);

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

      return task;
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

  async push(stackId: string, message?: string): Promise<void> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    const args = ['push', stackId];
    if (message) args.push(message);

    const result = await this.runCli(stack.project_dir, args);
    if (result.exitCode !== 0) {
      throw new SandstormError(ErrorCode.COMPOSE_FAILED, result.stderr.trim() || result.stdout.trim() || 'Push failed');
    }

    this.registry.updateStackStatus(stackId, 'pushed');
    this.notifyUpdate();
  }

  setPullRequest(stackId: string, prUrl: string, prNumber: number): void {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    this.registry.setPullRequest(stackId, prUrl, prNumber);
    this.notifyUpdate();
  }

  getTaskStatus(stackId: string): { status: string; task?: Task } {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    const runningTask = this.registry.getRunningTask(stackId);
    if (runningTask) {
      return { status: 'running', task: runningTask };
    }

    const tasks = this.registry.getTasksForStack(stackId);
    if (tasks.length > 0) {
      return { status: tasks[0].status, task: tasks[0] };
    }

    return { status: 'idle' };
  }

  async getTaskOutput(stackId: string, lines: number = 50): Promise<string> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    const claudeContainer = await this.findClaudeContainer(stack);
    if (!claudeContainer) {
      throw new SandstormError(ErrorCode.CONTAINER_UNREACHABLE, `Agent container not found for stack "${stackId}"`);
    }

    try {
      const result = await this.runtime.exec(claudeContainer.id, [
        'tail', '-n', String(lines), '/tmp/claude-task.log',
      ]);
      return result.stdout;
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
    const containers = await this.runtime.listContainers({ name: filterName });

    if (containers.length === 0) {
      throw new SandstormError(ErrorCode.CONTAINER_UNREACHABLE, `No containers found for stack "${stackId}"${service ? ` service "${service}"` : ''}`);
    }

    const logParts: string[] = [];
    for (const c of containers) {
      const chunks: string[] = [];
      for await (const chunk of this.runtime.logs(c.id, { tail: 100 })) {
        chunks.push(chunk);
      }
      const serviceName = this.extractServiceName(c.name, composeProjectName);
      logParts.push(`=== ${serviceName} ===\n${chunks.join('')}`);
    }

    return logParts.join('\n\n');
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
    const containers = await this.runtime.listContainers({ name: composeProjectName });

    const entries: ContainerStatsEntry[] = [];
    let totalMemory = 0;

    for (const c of containers) {
      if (c.status !== 'running') continue;
      try {
        const stats = await this.runtime.containerStats(c.id);
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
    }

    return {
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_tokens: totalInput + totalOutput,
      per_stack: perStack.sort((a, b) => b.total_tokens - a.total_tokens),
    };
  }

  // --- Rate Limit Handling ---

  getRateLimitState(): RateLimitState {
    const limitedStacks = this.registry.getRateLimitedStacks();
    const resetAt = this.registry.getGlobalRateLimitReset();

    return {
      active: this.globalRateLimitActive || limitedStacks.length > 0,
      reset_at: resetAt,
      affected_stacks: limitedStacks.map((s) => s.id),
      reason: this.globalRateLimitReason,
    };
  }

  private handleRateLimit(stackId: string, rateLimit: ParsedRateLimit): void {
    this.globalRateLimitActive = true;
    this.globalRateLimitReason = rateLimit.reason;

    // All stacks share the same Claude API account, so a rate limit on one
    // stack means all stacks are affected. Mark all running stacks.
    const stacks = this.registry.listStacks();
    for (const stack of stacks) {
      if (stack.status === 'running') {
        const resetAt = rateLimit.reset_at ?? new Date(Date.now() + 3600000).toISOString();
        this.registry.setRateLimitReset(stack.id, resetAt);
      }
    }

    // Also mark the triggering stack if not already
    if (rateLimit.reset_at) {
      this.registry.setRateLimitReset(stackId, rateLimit.reset_at);
    }

    this.notifyUpdate();

    // Schedule auto-resume
    if (rateLimit.reset_at) {
      this.scheduleAutoResume(rateLimit.reset_at);
    }
  }

  private scheduleAutoResume(resetAt: string): void {
    const resetTime = new Date(resetAt).getTime();
    const delayMs = Math.max(0, resetTime - Date.now()) + 5000; // 5s buffer after reset

    // Clear any existing global resume timer
    for (const [key, timer] of this.rateLimitResumeTimers) {
      if (key === '__global__') {
        clearTimeout(timer);
        this.rateLimitResumeTimers.delete(key);
      }
    }

    const timer = setTimeout(() => {
      this.autoResumeAfterRateLimit().catch(() => {});
    }, delayMs);

    this.rateLimitResumeTimers.set('__global__', timer);
  }

  private async autoResumeAfterRateLimit(): Promise<void> {
    this.globalRateLimitActive = false;
    this.globalRateLimitReason = null;

    const limitedStacks = this.registry.getRateLimitedStacks();

    for (const stack of limitedStacks) {
      // Clear the rate limit status
      this.registry.clearRateLimit(stack.id);

      // Find the last task for this stack to get its session_id
      const tasks = this.registry.getTasksForStack(stack.id);
      const lastTask = tasks[0]; // Most recent (sorted DESC)

      if (lastTask && lastTask.session_id && lastTask.prompt) {
        // Resume the task using the session ID
        try {
          await this.resumeTask(stack.id, lastTask.prompt, lastTask.session_id);
        } catch {
          // If resume fails, just mark stack as failed
          this.registry.updateStackStatus(stack.id, 'failed', 'Auto-resume after rate limit failed');
        }
      } else {
        // No session to resume — mark as idle so user can manually re-dispatch
        this.registry.updateStackStatus(stack.id, 'idle');
      }
    }

    this.notifyUpdate();
  }

  /**
   * Resume a task by dispatching with "continue" prompt using --resume <sessionId>.
   * The inner Claude will pick up where it left off.
   */
  private async resumeTask(stackId: string, originalPrompt: string, sessionId: string): Promise<Task> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);

    const task = this.registry.createTask(stackId, `[resumed] ${originalPrompt}`);

    try {
      const claudeContainer = await this.findClaudeContainer(stack);
      if (!claudeContainer) {
        throw new SandstormError(ErrorCode.CONTAINER_UNREACHABLE, `Agent container not found for stack "${stackId}"`);
      }

      await this.waitForClaudeReady(claudeContainer.id);

      // Store the session ID on the new task for future resume capability
      this.registry.setTaskSessionId(task.id, sessionId);

      // Dispatch with resume session — the CLI task command should support session resume
      const result = await this.runCli(stack.project_dir, [
        'task', stackId, 'continue',
        '--session', sessionId,
      ]);

      if (result.exitCode !== 0) {
        throw new SandstormError(
          ErrorCode.TASK_DISPATCH_FAILED,
          result.stderr.trim() || result.stdout.trim() || 'Task resume failed'
        );
      }

      this.taskWatcher.watch(stackId, claudeContainer.id);
      this.taskWatcher.streamOutput(stackId, claudeContainer.id, () => {}).catch(() => {});

      return task;
    } catch (err) {
      this.registry.completeTask(task.id, 1);
      this.notifyUpdate();
      throw err;
    }
  }

  /**
   * Check if dispatching is currently blocked by rate limits.
   */
  isRateLimited(): boolean {
    if (this.globalRateLimitActive) return true;
    const limitedStacks = this.registry.getRateLimitedStacks();
    return limitedStacks.length > 0;
  }

  // --- Private helpers ---

  private async getServices(stack: Stack): Promise<ServiceInfo[]> {
    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
    const containers = await this.runtime.listContainers({
      name: composeProjectName,
    });

    const ports = this.registry.getPorts(stack.id);
    const portMap = new Map(ports.map((p) => [p.service, p]));

    return containers.map((c) => {
      const serviceName = this.extractServiceName(c.name, composeProjectName);
      const portInfo = portMap.get(serviceName);

      return {
        name: serviceName,
        status: c.status,
        exitCode: c.status === 'exited' ? undefined : undefined,
        hostPort: portInfo?.host_port,
        containerPort: portInfo?.container_port,
        containerId: c.id,
      };
    });
  }

  private async findClaudeContainer(stack: Stack): Promise<Container | undefined> {
    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
    const containers = await this.runtime.listContainers({
      name: `${composeProjectName}-claude`,
    });
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
}
