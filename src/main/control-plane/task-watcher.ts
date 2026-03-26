import { EventEmitter } from 'events';
import { Registry, Task } from './registry';
import { ContainerRuntime } from '../runtime/types';

export interface TaskEvents {
  'task:started': { stackId: string; task: Task };
  'task:completed': { stackId: string; task: Task };
  'task:failed': { stackId: string; task: Task };
  'task:output': { stackId: string; taskId: number; data: string };
}

/** Max consecutive exec failures before marking a task as failed */
const MAX_CONSECUTIVE_ERRORS = 30;
/** Max consecutive polls that return a stale terminal status (completed/failed)
 *  before we accept it as valid even without seeing "running" first.
 *  Acts as a safety net if the task runner crashes before writing "running". */
const MAX_STALE_POLLS = 30;

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
    exitCode: number
  ): void {
    this.registry.completeTask(task.id, exitCode);

    const updatedTask = {
      ...task,
      status,
      exit_code: exitCode,
      finished_at: new Date().toISOString(),
    };

    const event = status === 'completed' ? 'task:completed' : 'task:failed';
    this.emit(event, { stackId, task: updatedTask });
    this.onStatusChange?.();
    this.unwatch(stackId);
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

        this.completeTaskAndNotify(task, stackId, status, exitCode);
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
