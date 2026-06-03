import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { Registry, Task } from './registry';
import { StackManager } from './stack-manager';
import { AgentBackend } from '../agent';
import { workspacePathFor } from './pr-creator';
import { showNotification } from '../tray';
import { fetchTicketWithConfig } from './ticket-config';

const execFileAsync = promisify(execFile);

/** Max conflict-resolution agent attempts before giving up and notifying the user. */
const MAX_CONFLICT_RESOLUTION_ATTEMPTS = 2;

/** Derive a stack name from a ticket ID (matches renderer suggestStackName). */
function makeStackName(ticketId: string): string {
  const id = ticketId.replace(/^#/, '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return id ? `ticket-${id}` : '';
}

/** Default per-stack readiness timeout (10 minutes). */
const STACK_READY_TIMEOUT_MS = 600_000;

/** Default poll interval when waiting for a stack to become ready. */
const STACK_READY_POLL_INTERVAL_MS = 1_000;

export class DarkFactoryOrchestrator {
  constructor(
    private readonly registry: Registry,
    private readonly stackManager: StackManager,
    private readonly agentBackend: AgentBackend,
    private readonly notifyUpdate: () => void,
    private readonly stackReadyTimeoutMs: number = STACK_READY_TIMEOUT_MS,
    private readonly pollIntervalMs: number = STACK_READY_POLL_INTERVAL_MS,
  ) {}

  // ---------------------------------------------------------------------------
  // Step 1: spec_ready → spin up stack
  // ---------------------------------------------------------------------------

  handleTicketColumnChanged(ticketId: string, projectDir: string, column: string): void {
    if (column !== 'spec_ready') return;
    if (!this.registry.getDarkFactoryEnabled(projectDir)) return;

    this.startStack(ticketId, projectDir).catch((err) => {
      console.warn(`[DarkFactory] startStack failed for ${ticketId}:`, err);
    });
  }

  /**
   * Invoked once when dark factory transitions from disabled → enabled.
   * Serially starts a stack for every ticket currently in spec_ready, in
   * board order (oldest created_at first). Waits for each stack to reach
   * 'up' or 'failed' before dispatching the next one. On failure or
   * timeout the failed ticket stays in in_stack and the batch continues.
   */
  async handleDarkFactoryEnabled(projectDir: string): Promise<void> {
    const tickets = this.registry.listBoardTickets(projectDir)
      .filter((t) => t.column === 'spec_ready');

    for (const ticket of tickets) {
      const stackName = makeStackName(ticket.ticket_id);
      if (!stackName) continue;

      try {
        await this.startStack(ticket.ticket_id, projectDir);
      } catch (err) {
        console.warn(`[DarkFactory] handleDarkFactoryEnabled: startStack failed for ${ticket.ticket_id}:`, err);
        continue;
      }

      await this.awaitStackReady(stackName, this.stackReadyTimeoutMs);
    }
  }

  /** Polls registry until the stack is 'up' or 'failed', or the timeout elapses. */
  private awaitStackReady(stackName: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    return new Promise<void>((resolve) => {
      const poll = () => {
        const status = this.registry.getStack(stackName)?.status;
        if (status === 'up' || status === 'failed') {
          resolve();
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          console.warn(`[DarkFactory] stack ${stackName} did not become ready within ${timeoutMs}ms, continuing`);
          resolve();
          return;
        }
        setTimeout(poll, this.pollIntervalMs);
      };
      poll();
    });
  }

  private async startStack(ticketId: string, projectDir: string): Promise<void> {
    const name = makeStackName(ticketId);
    if (!name) return;

    const ticketConfig = this.registry.getProjectTicketConfig(projectDir);
    let taskBody = '';
    if (ticketConfig) {
      try {
        taskBody = await fetchTicketWithConfig(ticketId, ticketConfig, projectDir) ?? '';
      } catch {
        // Non-fatal — dispatch with empty body
      }
    }

    const firstLine = taskBody.split('\n').find((l) => l.trim())?.replace(/^#\s*/, '').slice(0, 120) ?? undefined;

    // Move ticket to in_stack before the stack build starts
    this.registry.setBoardTicketColumn(ticketId, path.resolve(projectDir), 'in_stack');

    this.stackManager.createStack({
      name,
      projectDir,
      ticket: ticketId,
      branch: `feat/${ticketId}-${name}`,
      description: firstLine,
      runtime: 'docker',
      task: taskBody,
      gateApproved: true,
    });

    this.notifyUpdate();
  }

  // ---------------------------------------------------------------------------
  // Step 2: task:completed → create PR
  // ---------------------------------------------------------------------------

  handleTaskCompleted(stackId: string, _task: Task): void {
    const stack = this.registry.getStack(stackId);
    if (!stack?.ticket) return;
    if (!this.registry.getDarkFactoryEnabled(stack.project_dir)) return;

    this.createPR(stackId, stack.ticket, stack.project_dir).catch((err) => {
      console.warn(`[DarkFactory] createPR failed for stack ${stackId}:`, err);
    });
  }

  private async createPR(stackId: string, ticketId: string, projectDir: string): Promise<void> {
    const { draftPullRequest, createPullRequest } = await import('./pr-creator');

    const stack = this.registry.getStack(stackId);
    if (!stack) return;

    const workspace = workspacePathFor(projectDir, stackId);

    let draft: { title: string; body: string };
    try {
      draft = await draftPullRequest(
        { stackId, workspace, ticket: stack.ticket },
        {
          runEphemeral: (prompt, dir, timeoutMs) =>
            this.agentBackend.runEphemeralAgent(prompt, dir, timeoutMs),
          fetchTaskTail: (id) => this.stackManager.getTaskOutput(id, 50).catch(() => ''),
        },
      );
    } catch {
      showNotification('Dark factory: PR draft failed', `Ticket ${ticketId} needs manual PR creation`);
      return;
    }

    try {
      const result = await createPullRequest(
        { stackId, title: draft.title, body: draft.body },
        {
          workspace,
          runGitPush: async (commitMsg) => { await this.stackManager.push(stackId, commitMsg); },
          createPROnHost: async (prTitle, bodyFilePath, head, base) => {
            const { stdout } = await execFileAsync(
              'gh',
              ['pr', 'create', '--title', prTitle, '--body-file', bodyFilePath, '--base', base, '--head', head],
              { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024 },
            );
            return stdout;
          },
          checkoutBranch: (branch) => this.stackManager.execInContainer(stackId, ['git', 'checkout', '-b', branch]),
          setPullRequest: (url, num) => this.stackManager.setPullRequest(stackId, url, num),
        },
      );
      showNotification('Dark factory: PR created', result.url);
      // handlePrCreated will be called by the ipc.ts pr:createAuto success path, but since
      // we're calling createPullRequest directly here, trigger auto-merge manually.
      this.handlePrCreated(stackId, result.number);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showNotification('Dark factory: PR creation failed', `Ticket ${ticketId}: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: PR created → auto-merge (with conflict resolution)
  // ---------------------------------------------------------------------------

  handlePrCreated(stackId: string, prNumber: number): void {
    const stack = this.registry.getStack(stackId);
    if (!stack?.ticket) return;
    if (!this.registry.getDarkFactoryEnabled(stack.project_dir)) return;

    this.autoMerge(stackId, prNumber, stack.ticket, stack.project_dir).catch((err) => {
      console.warn(`[DarkFactory] autoMerge failed for stack ${stackId}:`, err);
    });
  }

  private async autoMerge(
    stackId: string,
    prNumber: number,
    ticketId: string,
    projectDir: string,
  ): Promise<void> {
    const workspace = workspacePathFor(projectDir, stackId);

    // Check for merge conflicts before attempting
    const conflicted = await this.isMergeConflicted(prNumber, workspace);

    if (conflicted) {
      const resolved = await this.resolveConflicts(stackId, prNumber, ticketId, projectDir, workspace);
      if (!resolved) {
        showNotification(
          'Dark factory: merge needs attention',
          `Ticket ${ticketId} PR #${prNumber} has unresolvable conflicts — manual merge required`,
        );
        return;
      }
    }

    // Attempt merge: --squash --auto, with fallback to immediate --squash
    const merged = await this.squashMerge(prNumber, workspace);
    if (!merged) {
      showNotification(
        'Dark factory: merge failed',
        `Ticket ${ticketId} PR #${prNumber} — manual merge required`,
      );
      return;
    }

    // Teardown + advance card to merged
    await this.completeMerge(stackId, ticketId, projectDir);
  }

  private async isMergeConflicted(prNumber: number, workspace: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'view', String(prNumber), '--json', 'mergeable,mergeStateStatus'],
        { cwd: workspace, timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      const data = JSON.parse(stdout) as { mergeable?: string; mergeStateStatus?: string };
      return data.mergeable !== 'MERGEABLE' || data.mergeStateStatus === 'DIRTY';
    } catch {
      return false;
    }
  }

  private async resolveConflicts(
    stackId: string,
    prNumber: number,
    ticketId: string,
    projectDir: string,
    workspace: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_CONFLICT_RESOLUTION_ATTEMPTS; attempt++) {
      try {
        const stack = this.registry.getStack(stackId);
        if (!stack) return false;

        const prompt =
          `You are in a git workspace at ${workspace}. ` +
          `PR #${prNumber} for ticket ${ticketId} has merge conflicts with the base branch. ` +
          `Merge the base branch (main) into the PR branch, resolve all conflicts, and push the result. ` +
          `Use git fetch origin, git merge origin/main, resolve conflicts, git add, git commit, then git push.`;

        await this.agentBackend.runEphemeralAgent(prompt, projectDir, 300_000);

        // Push the resolved state
        await this.stackManager.push(stackId, `fix: resolve merge conflicts for PR #${prNumber}`);

        // Re-check conflicts
        const stillConflicted = await this.isMergeConflicted(prNumber, workspace);
        if (!stillConflicted) return true;
      } catch (err) {
        console.warn(`[DarkFactory] Conflict resolution attempt ${attempt + 1} failed:`, err);
      }
    }
    return false;
  }

  /** Try `--squash --auto`, fall back to `--squash` if auto-merge is not enabled on the repo. */
  private async squashMerge(prNumber: number, workspace: string): Promise<boolean> {
    try {
      await execFileAsync(
        'gh',
        ['pr', 'merge', String(prNumber), '--squash', '--auto'],
        { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      return true;
    } catch (autoErr) {
      const autoMsg = `${String((autoErr as { stderr?: unknown })?.stderr ?? '')} ${String((autoErr as { message?: unknown })?.message ?? '')}`;
      if (/already merged/i.test(autoMsg)) return true;

      // auto-merge disabled on repo — fall back to immediate squash
      try {
        await execFileAsync(
          'gh',
          ['pr', 'merge', String(prNumber), '--squash'],
          { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024 },
        );
        return true;
      } catch (squashErr) {
        const squashMsg = `${String((squashErr as { stderr?: unknown })?.stderr ?? '')} ${String((squashErr as { message?: unknown })?.message ?? '')}`;
        if (/already merged/i.test(squashMsg)) return true;
        console.warn('[DarkFactory] squash merge failed:', squashErr);
        return false;
      }
    }
  }

  private async completeMerge(stackId: string, ticketId: string, projectDir: string): Promise<void> {
    const isStackNotFound = (err: unknown) =>
      /Stack ".+" not found/.test(err instanceof Error ? err.message : String(err));

    try {
      await this.stackManager.teardownStack(stackId);
    } catch (err) {
      if (!isStackNotFound(err)) {
        console.warn('[DarkFactory] teardown warning:', err);
      }
    }

    this.registry.setBoardTicketColumn(ticketId, path.resolve(projectDir), 'merged');
    this.notifyUpdate();
  }
}
