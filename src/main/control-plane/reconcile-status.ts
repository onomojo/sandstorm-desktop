import fs from 'fs';
import path from 'path';
import { Stack, StackStatus, Task, HistoryStatus, Registry } from './registry';
import { Container, ContainerRuntime } from '../runtime/types';
import { sanitizeComposeName } from './stack-manager';
import { TaskWatcher } from './task-watcher';

export type AgentFileStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_human'
  | 'verify_blocked_environmental';

export interface AgentStateResult {
  status: AgentFileStatus;
  exitCode: number;
  stopReason?: string;
  envReason?: string;
}

export interface TaskReconcileUpdate {
  taskId: number;
  outcome: 'complete' | 'needs_human' | 'verify_blocked_environmental';
  exitCode: number;
  reason?: string;
}

export type ReconcileAction =
  | { kind: 'none' }
  | { kind: 'update'; newStatus: StackStatus; taskUpdate?: TaskReconcileUpdate }
  | { kind: 'orphan'; finalStatus: HistoryStatus }
  | { kind: 'reattach'; containerId: string };

const HALTED_STATUSES = new Set<StackStatus>(['session_paused', 'rate_limited']);

/**
 * Pure decision function: given a stack's current state and its container/agent state,
 * returns the reconciliation action to take.
 *
 * Designed for unit testing — takes data, returns action, no side effects.
 */
export function reconcileStack(
  stack: Stack,
  claudeContainer: Container | null,
  agentState: AgentStateResult | null,
  runningTask: Task | undefined,
): ReconcileAction {
  const halted = HALTED_STATUSES.has(stack.status);

  // Container is gone entirely → orphan
  if (!claudeContainer) {
    const finalStatus: HistoryStatus =
      stack.status === 'completed' || stack.status === 'pushed' || stack.status === 'pr_created'
        ? 'completed'
        : 'failed';
    return { kind: 'orphan', finalStatus };
  }

  // Container exists but not running (exited/paused/dead/restarting)
  if (claudeContainer.status !== 'running') {
    if (halted) {
      // Halted stacks (session_paused/rate_limited) with non-running container → orphan
      return { kind: 'orphan', finalStatus: 'failed' };
    }
    // Primary set: infer from running task
    if (runningTask) {
      return {
        kind: 'update',
        newStatus: 'failed',
        taskUpdate: { taskId: runningTask.id, outcome: 'complete', exitCode: 1 },
      };
    }
    return { kind: 'none' };
  }

  // Container is running

  // Halted stacks with running container → leave untouched
  if (halted) {
    return { kind: 'none' };
  }

  // Agent state unreadable (exec failed or status file missing/invalid)
  if (!agentState) {
    if (runningTask) {
      // Can't read agent files but task is running — leave unchanged, log warning upstream
      return { kind: 'none' };
    }
    // No running task, container is running — normalize to idle
    if (stack.status !== 'idle') {
      return { kind: 'update', newStatus: 'idle' };
    }
    return { kind: 'none' };
  }

  // Agent is still running → reattach watcher
  if (agentState.status === 'running') {
    if (runningTask) {
      return { kind: 'reattach', containerId: claudeContainer.id };
    }
    return { kind: 'none' };
  }

  // Agent has terminal status — map to registry updates
  if (agentState.status === 'needs_human') {
    const taskUpdate = runningTask
      ? {
          taskId: runningTask.id,
          outcome: 'needs_human' as const,
          exitCode: 1,
          reason: agentState.stopReason,
        }
      : undefined;
    return { kind: 'update', newStatus: 'needs_human', taskUpdate };
  }

  if (agentState.status === 'verify_blocked_environmental') {
    const taskUpdate = runningTask
      ? {
          taskId: runningTask.id,
          outcome: 'verify_blocked_environmental' as const,
          exitCode: 1,
          reason: agentState.envReason,
        }
      : undefined;
    return { kind: 'update', newStatus: 'verify_blocked_environmental', taskUpdate };
  }

  // completed or failed
  const exitCode = agentState.exitCode;
  const newStatus: StackStatus = exitCode === 0 ? 'completed' : 'failed';
  const taskUpdate = runningTask
    ? { taskId: runningTask.id, outcome: 'complete' as const, exitCode }
    : undefined;
  return { kind: 'update', newStatus, taskUpdate };
}

/**
 * Read inner-agent state files from a running container.
 * Returns null if the status file is missing, unreadable, or contains an unknown value.
 * Never throws — all errors are caught and treated as "unreadable".
 */
export async function readAgentState(
  runtime: ContainerRuntime,
  containerId: string,
): Promise<AgentStateResult | null> {
  let rawStatus: string;
  try {
    const result = await runtime.exec(containerId, ['cat', '/tmp/claude-task.status']);
    rawStatus = result.stdout.trim();
  } catch {
    return null;
  }

  const validStatuses: AgentFileStatus[] = [
    'running', 'completed', 'failed', 'needs_human', 'verify_blocked_environmental',
  ];
  if (!validStatuses.includes(rawStatus as AgentFileStatus)) {
    return null;
  }

  const status = rawStatus as AgentFileStatus;

  if (status === 'needs_human') {
    let stopReason = 'Agent signaled STOP_AND_ASK — needs human intervention';
    try {
      const r = await runtime.exec(containerId, ['cat', '/tmp/claude-stop-reason.txt']);
      if (r.stdout.trim()) stopReason = r.stdout.trim();
    } catch { /* best effort */ }
    return { status, exitCode: 1, stopReason };
  }

  if (status === 'verify_blocked_environmental') {
    let envReason = 'Verify failed repeatedly — likely an environmental issue';
    try {
      const r = await runtime.exec(containerId, ['cat', '/tmp/claude-verify-environmental.txt']);
      if (r.stdout.trim()) envReason = `Verify blocked (environmental): ${r.stdout.trim()}`;
    } catch { /* best effort */ }
    return { status, exitCode: 1, envReason };
  }

  let exitCode = status === 'completed' ? 0 : 1;
  if (status === 'completed' || status === 'failed') {
    try {
      const r = await runtime.exec(containerId, ['cat', '/tmp/claude-task.exit']);
      const parsed = parseInt(r.stdout.trim(), 10);
      if (!isNaN(parsed)) exitCode = parsed;
    } catch { /* best effort */ }
  }

  return { status, exitCode };
}

function applyReconcileAction(
  action: ReconcileAction,
  stack: Stack,
  registry: Registry,
  taskWatcher: TaskWatcher,
): void {
  switch (action.kind) {
    case 'none':
      break;

    case 'update': {
      if (action.taskUpdate) {
        const { taskId, outcome, exitCode, reason } = action.taskUpdate;
        if (outcome === 'needs_human') {
          registry.completeTaskNeedsHuman(taskId, reason ?? 'Agent needs human intervention');
          // completeTaskNeedsHuman already sets stack status to 'needs_human'
        } else if (outcome === 'verify_blocked_environmental') {
          registry.completeTaskVerifyBlockedEnvironmental(taskId, reason ?? 'Verify blocked by environmental issue');
          // completeTaskVerifyBlockedEnvironmental already sets stack status to 'verify_blocked_environmental'
        } else {
          registry.completeTask(taskId, exitCode);
          // completeTask already sets stack status to 'completed'/'failed'
        }
      } else {
        // No task to update — directly update the stack status
        registry.updateStackStatus(stack.id, action.newStatus);
      }
      break;
    }

    case 'orphan': {
      registry.archiveStack(stack.id, action.finalStatus);
      registry.deleteStack(stack.id);
      break;
    }

    case 'reattach': {
      // Ensure stack status reflects that a task is actively running
      if (stack.status !== 'running') {
        registry.updateStackStatus(stack.id, 'running');
      }
      taskWatcher.watch(stack.id, action.containerId);
      break;
    }
  }
}

/**
 * Startup gate: checks Docker availability, then runs reconciliation.
 * Extracted for testability — pass callbacks instead of Electron's webContents.send.
 *
 * `hasReconcilableStacks` (optional) gates the `docker:startup-unavailable`
 * event so the modal isn't shown when there are no stacks to reconcile —
 * a fresh install with no projects has nothing for the modal to warn about.
 * Defaults to true so existing callers/tests keep their prior behavior.
 */
export async function runStartupReconciliation(
  dockerRuntime: ContainerRuntime,
  runReconciliation: () => Promise<void>,
  emitEvent: (event: string) => void,
  hasReconcilableStacks?: () => boolean,
): Promise<void> {
  const dockerAvailable = await dockerRuntime.isAvailable().catch(() => false);
  if (!dockerAvailable) {
    if (hasReconcilableStacks?.() ?? true) {
      emitEvent('docker:startup-unavailable');
    }
    return;
  }
  await runReconciliation();
  emitEvent('stacks:updated');
}

/**
 * One-shot reconciliation pass run on app startup.
 * Corrects any status drift in non-terminal stacks that occurred while the app was closed.
 * Must be called after Docker has been verified available.
 */
export async function performReconciliation(
  registry: Registry,
  dockerRuntime: ContainerRuntime,
  podmanRuntime: ContainerRuntime,
  taskWatcher: TaskWatcher,
): Promise<void> {
  const nonTerminalStacks = registry.listNonTerminalStacks();
  const haltedStacks = registry.listHaltedStacks();
  const allStacks = [...nonTerminalStacks, ...haltedStacks];

  for (const stack of allStacks) {
    try {
      await reconcileOneStack(stack, registry, dockerRuntime, podmanRuntime, taskWatcher);
    } catch (err) {
      console.error(`[reconcile] Error reconciling stack ${stack.id}:`, (err as Error)?.message ?? err);
    }
  }
}

async function reconcileOneStack(
  stack: Stack,
  registry: Registry,
  dockerRuntime: ContainerRuntime,
  podmanRuntime: ContainerRuntime,
  taskWatcher: TaskWatcher,
): Promise<void> {
  const runtime = stack.runtime === 'podman' ? podmanRuntime : dockerRuntime;

  // Check workspace directory exists — missing workspace is treated the same as missing container
  const workspacePath = path.join(stack.project_dir, '.sandstorm', 'workspaces', stack.id);
  if (!fs.existsSync(workspacePath)) {
    console.log(`[reconcile] Stack ${stack.id}: workspace directory missing — treating as orphaned`);
    const finalStatus: HistoryStatus =
      stack.status === 'completed' || stack.status === 'pushed' || stack.status === 'pr_created'
        ? 'completed'
        : 'failed';
    registry.archiveStack(stack.id, finalStatus);
    registry.deleteStack(stack.id);
    return;
  }

  const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;

  // Look up the Claude container
  let claudeContainer: Container | null = null;
  try {
    const containers = await runtime.listContainers({ name: `${composeProjectName}-claude` });
    claudeContainer = containers[0] ?? null;
  } catch (err) {
    console.warn(`[reconcile] Failed to list containers for stack ${stack.id}:`, (err as Error)?.message ?? err);
    return; // Skip on runtime error — don't modify status
  }

  // Read agent state only if container is running (exec into non-running containers fails)
  let agentState: AgentStateResult | null = null;
  if (claudeContainer?.status === 'running') {
    agentState = await readAgentState(runtime, claudeContainer.id);
    if (agentState === null) {
      console.warn(`[reconcile] Stack ${stack.id}: could not read agent state from container ${claudeContainer.id} — leaving status unchanged`);
    }
  }

  const runningTask = registry.getRunningTask(stack.id);
  const action = reconcileStack(stack, claudeContainer, agentState, runningTask);

  if (action.kind !== 'none') {
    const detail = action.kind === 'update'
      ? ` → ${action.newStatus}`
      : action.kind === 'reattach'
        ? ` (containerId=${action.containerId})`
        : ` (finalStatus=${action.kind === 'orphan' ? action.finalStatus : ''})`;
    console.log(`[reconcile] Stack ${stack.id} (${stack.status}): ${action.kind}${detail}`);
  }

  applyReconcileAction(action, stack, registry, taskWatcher);
}
