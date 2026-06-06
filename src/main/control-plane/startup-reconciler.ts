import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { Registry, Stack } from './registry';
import { TaskWatcher } from './task-watcher';
import { StackManager, sanitizeComposeName } from './stack-manager';
import { ContainerRuntime } from '../runtime/types';

const TERMINAL_FILE_STATUSES = new Set([
  'completed', 'failed', 'needs_human', 'verify_blocked_environmental',
]);

// Only reconcile stacks in 'running' — these are the ones where a TaskWatcher
// was polling and may have been abandoned when the app was closed.
const RECONCILE_STATUSES = new Set(['running']);

const INVESTIGATE_PROMPT =
  'You have been dispatched to investigate the true completion state of the previous task. ' +
  'Check the working tree (git status, git log), test results, and any error logs. ' +
  'Write EXACTLY ONE of these values to /tmp/claude-task.status: ' +
  '"completed" (task finished successfully and tests pass), ' +
  '"failed" (task was attempted but tests fail or an error occurred), or ' +
  '"needs_human" (you cannot determine the state). ' +
  'Also write the exit code to /tmp/claude-task.exit: "0" for completed, "1" for all others. ' +
  'Stop immediately after writing these files — do not perform any other work.';

/**
 * Recovery prompt for the live liveness check. Unlike INVESTIGATE_PROMPT (which
 * is used for fresh-dispatch investigation), this is delivered via --resume
 * <session_id> so the original session can inspect its own prior context.
 * The key difference: if work is incomplete, this prompt instructs the session
 * to finish the remaining work rather than just writing a terminal status.
 */
export const INVESTIGATE_AND_FINISH_PROMPT =
  'Your task\'s status was stuck at "running" — the process died before writing a terminal status. ' +
  'Inspect your prior work: run "git status", "git log --oneline -10", check test results, and review the tail of /tmp/claude-raw.log. ' +
  'If all intended work is complete and tests pass, write "completed" to /tmp/claude-task.status and "0" to /tmp/claude-task.exit, then stop. ' +
  'If work was attempted but tests fail or an error occurred, write "failed" to /tmp/claude-task.status and "1" to /tmp/claude-task.exit, then stop. ' +
  'If the task is genuinely incomplete, finish the remaining work — do NOT write to the status files yourself; ' +
  'let the normal task lifecycle write the terminal status when you are done.';

export interface ReconcilerDeps {
  fetchTicketStateFn?: (ticketId: string, cwd: string) => Promise<'OPEN' | 'CLOSED'>;
  workspaceExistsFn?: (stack: Stack) => boolean;
}

export async function fetchTicketState(
  ticketId: string,
  cwd: string
): Promise<'OPEN' | 'CLOSED'> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['issue', 'view', ticketId, '--json', 'state'],
      { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) { reject(err); return; }
        try {
          const data = JSON.parse(stdout) as { state: string };
          const state = data.state.toUpperCase();
          if (state === 'OPEN' || state === 'CLOSED') {
            resolve(state);
          } else {
            reject(new Error(`Unexpected ticket state: ${state}`));
          }
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

export function defaultWorkspaceExists(stack: Stack): boolean {
  const workspacePath = path.join(stack.project_dir, '.sandstorm', 'workspaces', stack.id);
  try {
    return fs.statSync(workspacePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Startup reconciliation pass — runs as a fire-and-forget background task
 * after the main window is shown. For every stack persisted as 'running',
 * determines the true state and drives the stack to a terminal status or
 * re-attaches a watcher so it can self-terminate.
 *
 * Branches:
 *   1. Container present + status file is terminal → drive via completeTask*
 *   2. Container present + status 'running'        → re-attach TaskWatcher
 *   3. Container gone + workspace survives          → recreate-and-resume
 *   4. Container present + status unreadable        → investigate-and-correct
 *   5. Container gone + workspace gone              → ticket-state cleanup
 */
export async function runStartupReconciliation(
  registry: Registry,
  stackManager: StackManager,
  taskWatcher: TaskWatcher,
  dockerRuntime: ContainerRuntime,
  podmanRuntime: ContainerRuntime,
  notifyUpdate: () => void,
  deps: ReconcilerDeps = {}
): Promise<void> {
  const {
    fetchTicketStateFn = fetchTicketState,
    workspaceExistsFn = defaultWorkspaceExists,
  } = deps;

  // Repair cards stuck in pr_open after a failed PR creation (runs before stack reconciliation
  // so the board is consistent when the renderer loads).
  registry.reconcilePrOpenStuckTickets();
  notifyUpdate();

  // Reset selfheal_continue_used to 0 for every failed stack so previously-stuck
  // stacks are continuable and the guard is never permanently set.
  const failedStacks = registry.listStacks().filter((s) => s.status === 'failed');
  for (const stack of failedStacks) {
    registry.setSelfhealContinueUsed(stack.id, 0);
  }
  if (failedStacks.length > 0) notifyUpdate();

  const staleStacks = registry.listStacks().filter((s) => RECONCILE_STATUSES.has(s.status));

  for (const stack of staleStacks) {
    try {
      await reconcileStack(
        stack,
        registry,
        stackManager,
        taskWatcher,
        dockerRuntime,
        podmanRuntime,
        notifyUpdate,
        fetchTicketStateFn,
        workspaceExistsFn
      );
    } catch (err) {
      console.warn(`[StartupReconciler] Error reconciling stack ${stack.id}:`, err);
    }
    // Notify renderer after each stack so cards refresh live
    notifyUpdate();
  }

  // Ongoing safeguard: re-check completed stacks for missed token-limit signals.
  // recheckCompletedStack handles the container-absent case internally.
  const completedStacks = registry.listStacks().filter((s) => s.status === 'completed');
  for (const stack of completedStacks) {
    try {
      await stackManager.recheckCompletedStack(stack.id);
    } catch (err) {
      console.warn(`[StartupReconciler] Error rechecking completed stack ${stack.id}:`, err);
    }
    notifyUpdate();
  }
}

async function reconcileStack(
  stack: Stack,
  registry: Registry,
  stackManager: StackManager,
  taskWatcher: TaskWatcher,
  dockerRuntime: ContainerRuntime,
  podmanRuntime: ContainerRuntime,
  notifyUpdate: () => void,
  fetchTicketStateFn: (ticketId: string, cwd: string) => Promise<'OPEN' | 'CLOSED'>,
  workspaceExistsFn: (stack: Stack) => boolean
): Promise<void> {
  const runtime = stack.runtime === 'podman' ? podmanRuntime : dockerRuntime;
  const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;

  let containers;
  try {
    containers = await runtime.listContainers({ name: `${composeProjectName}-claude` });
  } catch (err) {
    console.warn(`[StartupReconciler] Failed to list containers for stack ${stack.id}:`, err);
    return;
  }

  const container = containers[0] ?? null;

  if (!container) {
    if (workspaceExistsFn(stack)) {
      await handleBranch3(stack, registry, stackManager, notifyUpdate);
    } else {
      await handleBranch5(stack, registry, fetchTicketStateFn, notifyUpdate);
    }
    return;
  }

  let statusContent: string | null = null;
  try {
    const result = await runtime.exec(container.id, ['cat', '/tmp/claude-task.status']);
    statusContent = result.stdout.trim();
  } catch {
    // exec failed — container present but unreadable
    statusContent = null;
  }

  if (statusContent !== null && TERMINAL_FILE_STATUSES.has(statusContent)) {
    await handleBranch1(stack, statusContent, container.id, runtime, registry, notifyUpdate);
  } else if (statusContent === 'running') {
    handleBranch2(stack.id, container.id, taskWatcher, notifyUpdate);
  } else {
    await handleBranch4(stack, registry, stackManager, notifyUpdate);
  }
}

async function handleBranch1(
  stack: Stack,
  statusContent: string,
  containerId: string,
  runtime: ContainerRuntime,
  registry: Registry,
  notifyUpdate: () => void
): Promise<void> {
  const task = registry.getRunningTask(stack.id);
  if (!task) return; // Already terminalized — idempotent

  if (statusContent === 'needs_human') {
    let stopReason = 'Agent signaled STOP_AND_ASK — needs human intervention';
    try {
      const r = await runtime.exec(containerId, ['cat', '/tmp/claude-stop-reason.txt']);
      if (r.stdout.trim()) stopReason = r.stdout.trim();
    } catch { /* best effort */ }
    registry.completeTaskNeedsHuman(task.id, stopReason);
  } else if (statusContent === 'verify_blocked_environmental') {
    let envReason = 'Verify failed repeatedly — likely an environmental issue';
    try {
      const r = await runtime.exec(containerId, ['cat', '/tmp/claude-verify-environmental.txt']);
      if (r.stdout.trim()) envReason = `Verify blocked (environmental): ${r.stdout.trim()}`;
    } catch { /* best effort */ }
    registry.completeTaskVerifyBlockedEnvironmental(task.id, envReason);
  } else {
    let exitCode: number;
    try {
      const r = await runtime.exec(containerId, ['cat', '/tmp/claude-task.exit']);
      exitCode = parseInt(r.stdout.trim(), 10);
      if (isNaN(exitCode)) exitCode = statusContent === 'completed' ? 0 : 1;
    } catch {
      exitCode = statusContent === 'completed' ? 0 : 1;
    }
    registry.completeTask(task.id, exitCode);
  }
  notifyUpdate();
}

function handleBranch2(
  stackId: string,
  containerId: string,
  taskWatcher: TaskWatcher,
  notifyUpdate: () => void
): void {
  taskWatcher.watch(stackId, containerId);
  notifyUpdate();
}

async function handleBranch3(
  stack: Stack,
  registry: Registry,
  stackManager: StackManager,
  notifyUpdate: () => void
): Promise<void> {
  // Temporarily mark as session_paused so resumeStackWithContinuation applies its
  // recreate-and-resume logic (Case A for session resume, Case B for fresh dispatch).
  registry.updateStackStatus(stack.id, 'session_paused');
  notifyUpdate();

  try {
    await stackManager.resumeStackWithContinuation(stack.id, () => false, true);
  } catch (err) {
    console.warn(`[StartupReconciler] Branch 3 resume failed for stack ${stack.id}:`, err);
    const task = registry.getRunningTask(stack.id);
    if (task) {
      registry.completeTaskNeedsHuman(
        task.id,
        `Startup recovery failed: ${err instanceof Error ? err.message : String(err)}`
      );
      notifyUpdate();
    }
  }
}

async function handleBranch4(
  stack: Stack,
  registry: Registry,
  stackManager: StackManager,
  notifyUpdate: () => void
): Promise<void> {
  // Interrupt the stale running task so dispatchTask creates a clean new one
  const task = registry.getRunningTask(stack.id);
  if (task) {
    registry.interruptTask(task.id);
  }

  try {
    await stackManager.dispatchTask(stack.id, INVESTIGATE_PROMPT, undefined, {
      skipTicketFetch: true,
    });
  } catch (err) {
    console.warn(`[StartupReconciler] Branch 4 dispatch failed for stack ${stack.id}:`, err);
    const newTask = registry.getRunningTask(stack.id);
    if (newTask) {
      registry.completeTaskNeedsHuman(
        newTask.id,
        `Investigation dispatch failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } else {
      registry.updateStackStatus(stack.id, 'needs_human');
    }
    notifyUpdate();
  }
}

async function handleBranch5(
  stack: Stack,
  registry: Registry,
  fetchTicketStateFn: (ticketId: string, cwd: string) => Promise<'OPEN' | 'CLOSED'>,
  notifyUpdate: () => void
): Promise<void> {
  if (!stack.ticket) {
    // No linked ticket — remove the dead orphan stack
    registry.archiveStack(stack.id, 'torn_down');
    registry.deleteStack(stack.id);
    notifyUpdate();
    return;
  }

  let ticketState: 'OPEN' | 'CLOSED';
  try {
    ticketState = await fetchTicketStateFn(stack.ticket, stack.project_dir);
  } catch (err) {
    // DR-E: gh lookup failure → leave as-is, warn, retry next startup
    console.warn(
      `[StartupReconciler] Branch 5: failed to look up ticket ${stack.ticket} ` +
      `for stack ${stack.id} — leaving stack as-is for retry on next startup:`,
      err
    );
    return;
  }

  registry.archiveStack(stack.id, 'torn_down');
  registry.deleteStack(stack.id);

  if (ticketState === 'OPEN') {
    registry.setBoardTicketColumn(stack.ticket, stack.project_dir, 'backlog');
  }

  notifyUpdate();
}
