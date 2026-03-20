import { EventEmitter } from 'events';
import { Registry, Task } from './registry';
import { ContainerRuntime } from '../runtime/types';

export interface TaskEvents {
  'task:started': { stackId: string; task: Task };
  'task:completed': { stackId: string; task: Task };
  'task:failed': { stackId: string; task: Task };
  'task:output': { stackId: string; taskId: number; data: string };
}

export class TaskWatcher extends EventEmitter {
  private watchers = new Map<string, NodeJS.Timeout>();
  private pollInterval: number;

  constructor(
    private registry: Registry,
    private runtime: ContainerRuntime,
    options?: { pollInterval?: number }
  ) {
    super();
    this.pollInterval = options?.pollInterval ?? 2000;
  }

  watch(stackId: string, containerId: string): void {
    if (this.watchers.has(stackId)) return;

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
  }

  unwatchAll(): void {
    for (const [id] of this.watchers) {
      this.unwatch(id);
    }
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
        const exitResult = await this.runtime.exec(containerId, [
          'cat',
          '/tmp/claude-task.exit',
        ]);
        const exitCode = parseInt(exitResult.stdout.trim(), 10) || (status === 'completed' ? 0 : 1);

        this.registry.completeTask(task.id, exitCode);
        const updatedTask = {
          ...task,
          status: status as 'completed' | 'failed',
          exit_code: exitCode,
          finished_at: new Date().toISOString(),
        };

        const event = status === 'completed' ? 'task:completed' : 'task:failed';
        this.emit(event, { stackId, task: updatedTask });
        this.unwatch(stackId);
      }
    } catch {
      // Container might not be ready yet or file doesn't exist — keep polling
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
