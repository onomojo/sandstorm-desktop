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

export class TaskWatcher extends EventEmitter {
  private watchers = new Map<string, NodeJS.Timeout>();
  private errorCounts = new Map<string, number>();
  private pollInterval: number;
  private onStatusChange?: () => void;

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

    const interval = setInterval(async () => {
      await this.checkTaskStatus(stackId, containerId);
    }, this.pollInterval);

    this.watchers.set(stackId, interval);
  }

  unwatch(stackId: string): void {
    const interval = this.watchers.get(stackId);
    if (interval) {
      clearInterval(interval);
      this.watchers.delete(stackId);
    }
    this.errorCounts.delete(stackId);
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

      if (status === 'completed' || status === 'failed') {
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

      // Successful poll — reset error counter
      this.errorCounts.set(stackId, 0);
    } catch {
      // Exec failed — container might not be ready, or ID became stale.
      // Track consecutive failures so we don't poll forever.
      const count = (this.errorCounts.get(stackId) ?? 0) + 1;
      this.errorCounts.set(stackId, count);

      if (count >= MAX_CONSECUTIVE_ERRORS) {
        this.completeTaskAndNotify(
          task,
          stackId,
          'failed',
          1
        );
      }
    }
  }

  async streamOutput(
    stackId: string,
    containerId: string,
    callback: (data: string) => void
  ): Promise<void> {
    try {
      for await (const chunk of this.runtime.logs(containerId, {
        follow: true,
        tail: 100,
      })) {
        callback(chunk);
        this.emit('task:output', {
          stackId,
          taskId: 0,
          data: chunk,
        });
      }
    } catch {
      // Stream ended
    }
  }
}
