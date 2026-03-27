import { EventEmitter } from 'events';
import { Registry, Task } from './registry';
import { ContainerRuntime } from '../runtime/types';
import { parseTokenUsage, parseHttpError, ParsedRateLimit, ParsedHttpError } from './token-parser';

export interface TaskEvents {
  'task:started': { stackId: string; task: Task };
  'task:completed': { stackId: string; task: Task };
  'task:failed': { stackId: string; task: Task };
  'task:output': { stackId: string; taskId: number; data: string };
  'task:rate_limited': { stackId: string; rateLimit: ParsedRateLimit };
  'task:auth_required': { stackId: string; error: ParsedHttpError };
  'task:server_error': { stackId: string; error: ParsedHttpError };
}

/** Max consecutive exec failures before marking a task as failed */
const MAX_CONSECUTIVE_ERRORS = 30;
/** Max consecutive polls that return a stale terminal status (completed/failed)
 *  before we accept it as valid even without seeing "running" first.
 *  Acts as a safety net if the task runner crashes before writing "running". */
const MAX_STALE_POLLS = 30;
/** Tasks completing in less than this many ms with no changes are suspicious */
const SUSPICIOUS_DURATION_MS = 30_000;

/** Backoff configuration */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export class TaskWatcher extends EventEmitter {
  private watchers = new Map<string, NodeJS.Timeout>();
  private errorCounts = new Map<string, number>();
  /** Tracks whether we've seen "running" status for the current watch cycle.
   *  Prevents stale "completed" from a prior task from triggering false completion.
   *  Assumes the task runner always writes "running" before completion and that
   *  at least one poll lands while the task is in "running" state (safe because
   *  Claude tasks take many seconds and the default poll interval is 2 s). */
  private seenRunning = new Map<string, boolean>();
  private stalePollCounts = new Map<string, number>();
  private pollInterval: number;
  private onStatusChange?: () => void;

  /** Track active output streams for cleanup */
  private activeOutputStreams = new Map<string, AbortController>();

  constructor(
    private registry: Registry,
    private runtime: ContainerRuntime,
    options?: { pollInterval?: number }
  ) {
    super();
    this.pollInterval = options?.pollInterval ?? 2000;
  }

  /** Register a callback invoked whenever a task status changes (for UI notifications) */
  setOnStatusChange(callback: () => void): void {
    this.onStatusChange = callback;
  }

  watch(stackId: string, containerId: string): void {
    // If already watching this stack, stop the old watcher first so
    // we pick up the (possibly new) containerId.
    if (this.watchers.has(stackId)) {
      this.unwatch(stackId);
    }

    this.errorCounts.set(stackId, 0);
    this.seenRunning.set(stackId, false);
    this.stalePollCounts.set(stackId, 0);

    this.schedulePoll(stackId, containerId, this.pollInterval);
  }

  unwatch(stackId: string): void {
    const timeout = this.watchers.get(stackId);
    if (timeout) {
      clearTimeout(timeout);
      this.watchers.delete(stackId);
    }
    this.errorCounts.delete(stackId);
    this.seenRunning.delete(stackId);
    this.stalePollCounts.delete(stackId);

    // Abort any active output stream
    const controller = this.activeOutputStreams.get(stackId);
    if (controller) {
      controller.abort();
      this.activeOutputStreams.delete(stackId);
    }
  }

  unwatchAll(): void {
    for (const [id] of this.watchers) {
      this.unwatch(id);
    }
  }

  private completeTaskAndNotify(
    task: Task,
    stackId: string,
    status: 'completed' | 'failed',
    exitCode: number,
    containerId?: string
  ): void {
    this.registry.completeTask(task.id, exitCode);

    // Check for suspicious completion: fast exit with no changes
    let warning: string | null = null;
    if (status === 'completed' && exitCode === 0 && task.started_at) {
      const durationMs = Date.now() - new Date(task.started_at + 'Z').getTime();
      if (durationMs < SUSPICIOUS_DURATION_MS) {
        warning = `Task completed suspiciously fast (${Math.round(durationMs / 1000)}s) — may not have produced real changes`;
        this.registry.setTaskWarning(task.id, warning);
      }
    }

    // Read token usage, session ID, and loop iterations from task log (async, best-effort)
    if (containerId) {
      this.readTaskTokens(task.id, stackId, containerId).catch(() => {});
      this.readTaskIterations(task.id, containerId).catch(() => {});
    }

    const updatedTask = {
      ...task,
      status,
      exit_code: exitCode,
      warnings: warning,
      finished_at: new Date().toISOString(),
    };

    const event = status === 'completed' ? 'task:completed' : 'task:failed';
    this.emit(event, { stackId, task: updatedTask });
    this.onStatusChange?.();
    this.unwatch(stackId);
  }

  /**
   * Read token usage from the task log file inside the container.
   * Also detects HTTP errors (rate limits, auth failures, server errors)
   * and emits typed events accordingly.
   */
  private async readTaskTokens(
    taskId: number,
    stackId: string,
    containerId: string
  ): Promise<void> {
    let errorEmitted = false;

    try {
      const result = await this.runtime.exec(containerId, [
        'cat', '/tmp/claude-raw.log',
      ]);
      const output = result.stdout;

      // Parse token usage
      const usage = parseTokenUsage(output);
      if (usage.input_tokens > 0 || usage.output_tokens > 0) {
        this.registry.updateTaskTokens(taskId, usage.input_tokens, usage.output_tokens);
      }

      // Store session ID for potential resume
      if (usage.session_id) {
        this.registry.setTaskSessionId(taskId, usage.session_id);
      }

      // Check for HTTP errors in structured stream-json output
      const httpError = parseHttpError(output);
      if (httpError) {
        this.emitHttpError(stackId, httpError);
        errorEmitted = true;
      }
    } catch {
      // Best effort — container may be unreachable
    }

    // Also check stderr for error info (skip if already detected)
    if (!errorEmitted) {
      try {
        const stderrResult = await this.runtime.exec(containerId, [
          'cat', '/tmp/claude-task.stderr',
        ]);
        const httpError = parseHttpError(stderrResult.stdout);
        if (httpError) {
          this.emitHttpError(stackId, httpError);
        }
      } catch {
        // stderr file may not exist
      }
    }
  }

  /**
   * Emit the appropriate typed event for an HTTP error.
   */
  private emitHttpError(stackId: string, error: ParsedHttpError): void {
    switch (error.type) {
      case 'rate_limit':
        this.emit('task:rate_limited', {
          stackId,
          rateLimit: { reset_at: error.reset_at, reason: error.reason },
        });
        break;
      case 'auth_required':
        this.emit('task:auth_required', { stackId, error });
        break;
      case 'server_error':
      case 'overloaded':
        this.emit('task:server_error', { stackId, error });
        break;
    }
    this.onStatusChange?.();
  }

  /**
   * Read loop iteration counts from files written by task-runner.sh.
   */
  private async readTaskIterations(
    taskId: number,
    containerId: string
  ): Promise<void> {
    let reviewIterations = 0;
    let verifyRetries = 0;

    try {
      const result = await this.runtime.exec(containerId, [
        'cat', '/tmp/claude-task.review-iterations',
      ]);
      const parsed = parseInt(result.stdout.trim(), 10);
      if (!isNaN(parsed)) reviewIterations = parsed;
    } catch {
      // File may not exist (single-pass task)
    }

    try {
      const result = await this.runtime.exec(containerId, [
        'cat', '/tmp/claude-task.verify-retries',
      ]);
      const parsed = parseInt(result.stdout.trim(), 10);
      if (!isNaN(parsed)) verifyRetries = parsed;
    } catch {
      // File may not exist (single-pass task)
    }

    if (reviewIterations > 0 || verifyRetries > 0) {
      this.registry.setTaskIterations(taskId, reviewIterations, verifyRetries);
    }
  }

  /**
   * Schedule the next poll with adaptive timing.
   * Uses exponential backoff on consecutive failures.
   */
  private schedulePoll(stackId: string, containerId: string, delayMs: number): void {
    const timeout = setTimeout(async () => {
      await this.checkTaskStatus(stackId, containerId);
    }, delayMs);
    this.watchers.set(stackId, timeout);
  }

  private async checkTaskStatus(
    stackId: string,
    containerId: string
  ): Promise<void> {
    const task = this.registry.getRunningTask(stackId);
    if (!task) {
      this.unwatch(stackId);
      return;
    }

    try {
      const result = await this.runtime.exec(containerId, [
        'cat',
        '/tmp/claude-task.status',
      ]);
      const status = result.stdout.trim();

      if (status === 'running') {
        this.seenRunning.set(stackId, true);
        this.errorCounts.set(stackId, 0);
        // Healthy — poll at normal interval
        this.schedulePoll(stackId, containerId, this.pollInterval);
        return;
      }

      if (status === 'completed' || status === 'failed') {
        // Ignore stale completion from a prior task — we must see "running"
        // at least once before treating completion as valid.
        // Safety net: if we never see "running" (e.g. task runner crashed),
        // accept the status after MAX_STALE_POLLS to avoid polling forever.
        if (!this.seenRunning.get(stackId)) {
          const staleCount = (this.stalePollCounts.get(stackId) ?? 0) + 1;
          this.stalePollCounts.set(stackId, staleCount);
          if (staleCount < MAX_STALE_POLLS) {
            this.schedulePoll(stackId, containerId, this.pollInterval);
            return;
          }
        }
        let exitCode: number;
        try {
          const exitResult = await this.runtime.exec(containerId, [
            'cat',
            '/tmp/claude-task.exit',
          ]);
          exitCode = parseInt(exitResult.stdout.trim(), 10);
          if (isNaN(exitCode)) exitCode = status === 'completed' ? 0 : 1;
        } catch {
          exitCode = status === 'completed' ? 0 : 1;
        }

        this.completeTaskAndNotify(task, stackId, status, exitCode, containerId);
        return;
      }

      // Successful poll — reset error counter, normal interval
      this.errorCounts.set(stackId, 0);
      this.schedulePoll(stackId, containerId, this.pollInterval);
    } catch {
      // Exec failed — container might not be ready, or Docker daemon is down.
      // Apply exponential backoff instead of hammering the API.
      const count = (this.errorCounts.get(stackId) ?? 0) + 1;
      this.errorCounts.set(stackId, count);

      if (count >= MAX_CONSECUTIVE_ERRORS) {
        this.completeTaskAndNotify(
          task,
          stackId,
          'failed',
          1
        );
        return;
      }

      // Exponential backoff: 500ms, 1s, 2s, 4s, ... up to 30s
      const backoffDelay = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, count - 1),
        BACKOFF_MAX_MS
      );
      this.schedulePoll(stackId, containerId, backoffDelay);
    }
  }

  async streamOutput(
    stackId: string,
    containerId: string,
    callback: (data: string) => void
  ): Promise<void> {
    // Abort any existing stream for this stack
    const existing = this.activeOutputStreams.get(stackId);
    if (existing) {
      existing.abort();
    }

    const controller = new AbortController();
    this.activeOutputStreams.set(stackId, controller);

    try {
      for await (const chunk of this.runtime.logs(containerId, {
        follow: true,
        tail: 100,
      })) {
        if (controller.signal.aborted) break;
        callback(chunk);
        this.emit('task:output', {
          stackId,
          taskId: 0,
          data: chunk,
        });
      }
    } catch {
      // Stream ended or aborted
    } finally {
      this.activeOutputStreams.delete(stackId);
    }
  }
}
