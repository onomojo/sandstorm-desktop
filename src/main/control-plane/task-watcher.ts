import { EventEmitter } from 'events';
import { Registry, Task } from './registry';
import { ContainerRuntime } from '../runtime/types';
import { parseTokenUsage, parsePhaseTokenTotals, parsePhaseTokenSteps } from './token-parser';

export interface WorkflowProgressData {
  stackId: string;
  currentPhase: 'execution' | 'review' | 'verify' | 'idle';
  outerIteration: number;
  innerIteration: number;
  phases: Array<{ phase: string; status: 'pending' | 'running' | 'passed' | 'failed' }>;
  steps: Array<{ phase: string; iteration: number; input_tokens: number; output_tokens: number; live: boolean }>;
  taskPrompt: string | null;
  startedAt: string | null;
  model: string | null;
}

export interface TaskEvents {
  'task:started': { stackId: string; task: Task };
  'task:completed': { stackId: string; task: Task };
  'task:failed': { stackId: string; task: Task };
  'task:output': { stackId: string; taskId: number; data: string };
  'task:workflow-progress': WorkflowProgressData;
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
  /** Tracks the last time we polled tokens for each stack (to throttle reads) */
  private lastTokenPoll = new Map<string, number>();
  /** How often to poll tokens while a task is running (ms) */
  private tokenPollInterval: number;

  /** Track active output streams for cleanup */
  private activeOutputStreams = new Map<string, AbortController>();
  /** Track container IDs for each watched stack (for on-demand progress queries) */
  private containerIds = new Map<string, string>();

  constructor(
    private registry: Registry,
    private dockerRuntime: ContainerRuntime,
    private podmanRuntime: ContainerRuntime,
    options?: { pollInterval?: number; tokenPollInterval?: number }
  ) {
    super();
    this.pollInterval = options?.pollInterval ?? 2000;
    this.tokenPollInterval = options?.tokenPollInterval ?? 5_000;
  }

  /**
   * Resolve the correct container runtime for a stack based on its stored
   * runtime preference in the registry.
   */
  private getRuntimeForStack(stackId: string): ContainerRuntime {
    const stack = this.registry.getStack(stackId);
    if (stack?.runtime === 'podman') return this.podmanRuntime;
    return this.dockerRuntime;
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
    this.containerIds.set(stackId, containerId);

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
    this.lastTokenPoll.delete(stackId);
    this.containerIds.delete(stackId);

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

    // Read token usage, session ID, loop iterations, and execution metadata (async, best-effort)
    if (containerId) {
      this.readTaskTokens(task.id, stackId, containerId).catch(() => {});
      this.readTaskIterations(task.id, stackId, containerId).catch(() => {});
      this.readTaskMetadata(task.id, stackId, containerId).catch(() => {});
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
   * Read token usage from phase totals files and raw log inside the container.
   * Phase totals files are written by token-counter.sh in the run_claude pipeline.
   * The raw log is still read for session_id and resolved_model extraction.
   */
  private async readTaskTokens(
    taskId: number,
    stackId: string,
    containerId: string
  ): Promise<void> {
    const runtime = this.getRuntimeForStack(stackId);
    try {
      // Read phase totals files and raw log in parallel
      const [execResult, reviewResult, rawResult] = await Promise.all([
        runtime.exec(containerId, ['cat', '/tmp/claude-tokens-execution']).catch(() => ({ stdout: '' })),
        runtime.exec(containerId, ['cat', '/tmp/claude-tokens-review']).catch(() => ({ stdout: '' })),
        runtime.exec(containerId, ['cat', '/tmp/claude-raw.log']).catch(() => ({ stdout: '' })),
      ]);

      // Parse phase token totals
      const execTokens = parsePhaseTokenTotals(execResult.stdout);
      const reviewTokens = parsePhaseTokenTotals(reviewResult.stdout);

      const totalInput = execTokens.input_tokens + reviewTokens.input_tokens;
      const totalOutput = execTokens.output_tokens + reviewTokens.output_tokens;

      if (totalInput > 0 || totalOutput > 0) {
        this.registry.updateTaskTokens(taskId, totalInput, totalOutput, {
          executionInput: execTokens.input_tokens,
          executionOutput: execTokens.output_tokens,
          reviewInput: reviewTokens.input_tokens,
          reviewOutput: reviewTokens.output_tokens,
        });
      }

      // Parse and persist per-step token data
      const steps = parsePhaseTokenSteps(execResult.stdout, reviewResult.stdout);
      if (steps.length > 0) {
        this.registry.setTaskTokenSteps(taskId, steps);
      }

      // Parse raw log for metadata (session ID, resolved model)
      const rawOutput = rawResult.stdout;
      if (rawOutput) {
        const usage = parseTokenUsage(rawOutput);

        // Store session ID for potential resume
        if (usage.session_id) {
          this.registry.setTaskSessionId(taskId, usage.session_id);
        }

        // Store the actual model used (important when "auto" was selected)
        if (usage.resolved_model) {
          this.registry.updateTaskResolvedModel(taskId, usage.resolved_model);
        }
      }
    } catch {
      // Best effort — container may be unreachable
    }
  }

  /**
   * Read loop iteration counts from files written by task-runner.sh.
   */
  private async readTaskIterations(
    taskId: number,
    stackId: string,
    containerId: string
  ): Promise<void> {
    const runtime = this.getRuntimeForStack(stackId);
    let reviewIterations = 0;
    let verifyRetries = 0;

    try {
      const result = await runtime.exec(containerId, [
        'cat', '/tmp/claude-task.review-iterations',
      ]);
      const parsed = parseInt(result.stdout.trim(), 10);
      if (!isNaN(parsed)) reviewIterations = parsed;
    } catch {
      // File may not exist (single-pass task)
    }

    try {
      const result = await runtime.exec(containerId, [
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
   * Read task execution metadata files (review verdicts, verify outputs,
   * execution summary, phase timing) from the container.
   */
  private async readTaskMetadata(
    taskId: number,
    stackId: string,
    containerId: string
  ): Promise<void> {
    const runtime = this.getRuntimeForStack(stackId);
    const metadata: Record<string, string> = {};

    // Read numbered review verdict files
    try {
      const lsResult = await runtime.exec(containerId, [
        'sh', '-c', 'ls /tmp/claude-review-verdict-*.txt 2>/dev/null || true',
      ]);
      const files = lsResult.stdout.trim().split('\n').filter(Boolean);
      if (files.length > 0) {
        const verdicts: string[] = [];
        for (const file of files.sort()) {
          try {
            const result = await runtime.exec(containerId, ['cat', file]);
            verdicts.push(result.stdout);
          } catch { /* skip unreadable files */ }
        }
        if (verdicts.length > 0) {
          metadata.review_verdicts = JSON.stringify(verdicts);
        }
      }
    } catch { /* best effort */ }

    // Read numbered verify output files
    try {
      const lsResult = await runtime.exec(containerId, [
        'sh', '-c', 'ls /tmp/claude-verify-output-*.txt 2>/dev/null || true',
      ]);
      const files = lsResult.stdout.trim().split('\n').filter(Boolean);
      if (files.length > 0) {
        const outputs: string[] = [];
        for (const file of files.sort()) {
          try {
            const result = await runtime.exec(containerId, ['cat', file]);
            outputs.push(result.stdout);
          } catch { /* skip unreadable files */ }
        }
        if (outputs.length > 0) {
          metadata.verify_outputs = JSON.stringify(outputs);
        }
      }
    } catch { /* best effort */ }

    // Read execution summary
    try {
      const result = await runtime.exec(containerId, [
        'cat', '/tmp/claude-execution-summary.txt',
      ]);
      if (result.stdout.trim()) {
        metadata.execution_summary = result.stdout;
      }
    } catch { /* best effort */ }

    // Read phase timing
    try {
      const result = await runtime.exec(containerId, [
        'cat', '/tmp/claude-phase-timing.txt',
      ]);
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      const timing: Record<string, string> = {};
      for (const line of lines) {
        const [key, value] = line.split('=', 2);
        if (key && value) {
          // Use last occurrence of each key (multiple iterations overwrite)
          timing[key] = value;
        }
      }
      if (timing.execution_started_at) metadata.execution_started_at = timing.execution_started_at;
      if (timing.execution_finished_at) metadata.execution_finished_at = timing.execution_finished_at;
      if (timing.review_started_at) metadata.review_started_at = timing.review_started_at;
      if (timing.review_finished_at) metadata.review_finished_at = timing.review_finished_at;
      if (timing.verify_started_at) metadata.verify_started_at = timing.verify_started_at;
      if (timing.verify_finished_at) metadata.verify_finished_at = timing.verify_finished_at;
    } catch { /* best effort */ }

    if (Object.keys(metadata).length > 0) {
      this.registry.updateTaskMetadata(taskId, metadata);
    }
  }

  /**
   * Read current workflow progress from the container (phase, iterations, live tokens).
   * Called during the token poll interval while a task is running.
   */
  private async readWorkflowProgress(
    stackId: string,
    containerId: string,
    task: Task
  ): Promise<WorkflowProgressData> {
    const runtime = this.getRuntimeForStack(stackId);

    // Read phase timing, iteration counts, and token files in parallel
    const [timingResult, reviewIterResult, verifyRetryResult, execTokenResult, reviewTokenResult] = await Promise.all([
      runtime.exec(containerId, ['cat', '/tmp/claude-phase-timing.txt']).catch(() => ({ stdout: '' })),
      runtime.exec(containerId, ['cat', '/tmp/claude-task.review-iterations']).catch(() => ({ stdout: '' })),
      runtime.exec(containerId, ['cat', '/tmp/claude-task.verify-retries']).catch(() => ({ stdout: '' })),
      runtime.exec(containerId, ['cat', '/tmp/claude-tokens-execution']).catch(() => ({ stdout: '' })),
      runtime.exec(containerId, ['cat', '/tmp/claude-tokens-review']).catch(() => ({ stdout: '' })),
    ]);

    // Parse iteration counts
    const reviewIterations = parseInt(reviewIterResult.stdout.trim(), 10) || 0;
    const verifyRetries = parseInt(verifyRetryResult.stdout.trim(), 10) || 0;

    // Derive current phase from timing file
    const timing: Record<string, string> = {};
    for (const line of timingResult.stdout.trim().split('\n').filter(Boolean)) {
      const [key, value] = line.split('=', 2);
      if (key && value) timing[key] = value;
    }

    let currentPhase: WorkflowProgressData['currentPhase'] = 'execution';
    const phases: WorkflowProgressData['phases'] = [];

    if (timing.verify_started_at && !timing.verify_finished_at) {
      currentPhase = 'verify';
      phases.push({ phase: 'execution', status: 'passed' });
      phases.push({ phase: 'review', status: 'passed' });
      phases.push({ phase: 'verify', status: 'running' });
    } else if (timing.review_started_at && !timing.review_finished_at) {
      currentPhase = 'review';
      phases.push({ phase: 'execution', status: 'passed' });
      phases.push({ phase: 'review', status: 'running' });
      phases.push({ phase: 'verify', status: 'pending' });
    } else if (timing.review_finished_at && timing.verify_finished_at) {
      // Both finished — verify failed, back to execution (outer loop retry)
      currentPhase = 'execution';
      phases.push({ phase: 'execution', status: 'running' });
      phases.push({ phase: 'review', status: 'pending' });
      phases.push({ phase: 'verify', status: 'failed' });
    } else if (timing.review_finished_at && !timing.verify_started_at) {
      // Review finished, verify not started — review failed, back to execution
      currentPhase = 'execution';
      phases.push({ phase: 'execution', status: 'running' });
      phases.push({ phase: 'review', status: 'failed' });
      phases.push({ phase: 'verify', status: 'pending' });
    } else {
      // Default: execution phase
      phases.push({ phase: 'execution', status: 'running' });
      phases.push({ phase: 'review', status: 'pending' });
      phases.push({ phase: 'verify', status: 'pending' });
    }

    // Parse per-step token data
    const tokenSteps = parsePhaseTokenSteps(execTokenResult.stdout, reviewTokenResult.stdout);
    const steps: WorkflowProgressData['steps'] = tokenSteps.map((s) => ({
      phase: s.phase,
      iteration: s.iteration,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      live: false,
    }));

    // Mark the last step matching the current phase as live
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].phase === currentPhase) {
        steps[i].live = true;
        break;
      }
    }

    // If no step exists for the current phase yet, add a live placeholder
    if (!steps.some((s) => s.phase === currentPhase)) {
      const iteration = currentPhase === 'verify'
        ? verifyRetries + 1
        : reviewIterations + 1;
      steps.push({
        phase: currentPhase,
        iteration,
        input_tokens: 0,
        output_tokens: 0,
        live: true,
      });
    }

    // Outer iteration = verify retries + 1, inner = review iterations within current outer
    const outerIteration = verifyRetries + 1;
    const innerIteration = reviewIterations + 1;

    return {
      stackId,
      currentPhase,
      outerIteration,
      innerIteration,
      phases,
      steps,
      taskPrompt: task.prompt,
      startedAt: task.started_at,
      model: task.resolved_model || task.model,
    };
  }

  /**
   * Get the current workflow progress for a stack (on-demand, for IPC handlers).
   */
  async getWorkflowProgress(stackId: string): Promise<WorkflowProgressData | null> {
    const task = this.registry.getRunningTask(stackId);
    if (!task) return null;

    const containerId = this.containerIds.get(stackId);
    if (!containerId) return null;

    try {
      return await this.readWorkflowProgress(stackId, containerId, task);
    } catch (err) {
      console.warn(`[TaskWatcher] getWorkflowProgress failed for ${stackId}:`, (err as Error)?.message ?? err);
      return null;
    }
  }

  /**
   * Read whatever metadata files exist for a task (used during teardown
   * to capture partial data before the container is removed).
   */
  async capturePartialMetadata(
    taskId: number,
    stackId: string,
    containerId: string
  ): Promise<void> {
    await Promise.all([
      this.readTaskTokens(taskId, stackId, containerId).catch(() => {}),
      this.readTaskIterations(taskId, stackId, containerId).catch(() => {}),
      this.readTaskMetadata(taskId, stackId, containerId).catch(() => {}),
    ]);
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

    const runtime = this.getRuntimeForStack(stackId);

    try {
      const result = await runtime.exec(containerId, [
        'cat',
        '/tmp/claude-task.status',
      ]);
      const status = result.stdout.trim();

      if (status === 'running') {
        const wasFirstRunning = !this.seenRunning.get(stackId);
        this.seenRunning.set(stackId, true);
        this.errorCounts.set(stackId, 0);

        // Poll tokens and workflow progress periodically while running (throttled)
        // On the first "running" poll, fetch immediately to avoid startup delay
        const now = Date.now();
        const lastPoll = this.lastTokenPoll.get(stackId) ?? 0;
        if (wasFirstRunning || now - lastPoll >= this.tokenPollInterval) {
          this.lastTokenPoll.set(stackId, now);
          const runningTask = this.registry.getRunningTask(stackId);
          if (runningTask) {
            this.readTaskTokens(runningTask.id, stackId, containerId).catch((err) => {
              console.warn(`[TaskWatcher] Failed to read tokens for ${stackId}:`, err?.message ?? err);
            });
            this.readWorkflowProgress(stackId, containerId, runningTask)
              .then((progress) => {
                this.emit('task:workflow-progress', progress);
              })
              .catch((err) => {
                console.warn(`[TaskWatcher] Failed to read workflow progress for ${stackId}:`, err?.message ?? err);
              });
          }
        }

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
          const exitResult = await runtime.exec(containerId, [
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
      const runtime = this.getRuntimeForStack(stackId);
      for await (const chunk of runtime.logs(containerId, {
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
