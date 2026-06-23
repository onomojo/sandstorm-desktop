import { Registry, Task, StackStatus } from './registry';

/**
 * TaskLifecycleManager (TLM) — the single owner of all task/stack lifecycle
 * state writes. All transitions that mutate task status or stack status flow
 * through this class; no other module may call the raw registry write methods
 * directly (enforced by tests/unit/architecture-registry-boundary.test.ts).
 *
 * TLM owns the WRITE, not the emit. Callers retain their existing
 * notifyUpdate() calls verbatim — emission is not 1:1 with writes.
 */
export class TaskLifecycleManager {
  constructor(private registry: Registry) {}

  /** Create a new task for a stack; auto-transitions stack → 'running'. */
  createTask(stackId: string, prompt: string, model?: string): Task {
    return this.registry.createTask(stackId, prompt, model);
  }

  /** Set the stack status (for build/deploy and other stack-only transitions). */
  updateStackStatus(stackId: string, status: StackStatus, error?: string): void {
    this.registry.updateStackStatus(stackId, status, error);
  }

  /** Complete a task with an exit code; auto-transitions stack → 'completed'|'failed'. */
  markCompleted(taskId: number, exitCode: number): void {
    this.registry.completeTask(taskId, exitCode);
  }

  /** Transition task → 'needs_human'; auto-transitions stack → 'needs_human'. */
  markNeedsHuman(taskId: number, reason: string, questionsJson?: string | null): void {
    this.registry.completeTaskNeedsHuman(taskId, reason, questionsJson);
  }

  /** Transition task → 'needs_key'; auto-transitions stack → 'needs_key'. */
  markNeedsKey(taskId: number, reason: string): void {
    this.registry.completeTaskNeedsKey(taskId, reason);
  }

  /**
   * Transition task → 'needs_human' (environmental block);
   * auto-transitions stack → 'verify_blocked_environmental'.
   */
  markVerifyBlockedEnvironmental(taskId: number, reason: string): void {
    this.registry.completeTaskVerifyBlockedEnvironmental(taskId, reason);
  }

  /**
   * Record a created PR on the stack and advance the linked ticket to pr_open
   * if one exists. Auto-transitions stack → 'pr_created'.
   */
  markPrCreated(stackId: string, prUrl: string, prNumber: number): void {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);
    this.registry.setPullRequest(stackId, prUrl, prNumber);
    if (stack.ticket) {
      this.registry.advanceTicketToPrOpenIfInStack(stack.ticket, stack.project_dir);
    }
  }

  /** Transition a running task → 'interrupted'. No-op if task is not 'running'. */
  markInterrupted(taskId: number): void {
    this.registry.interruptTask(taskId);
  }

  /** Reopen a completed/interrupted task for resume (status → 'running'). */
  markReopened(taskId: number): void {
    this.registry.reopenTaskForResume(taskId);
  }

  /** Stamp the resumed_at timestamp on a task. */
  markResumedAt(taskId: number, ts: string): void {
    this.registry.setTaskResumedAt(taskId, ts);
  }
}
