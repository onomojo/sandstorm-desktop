import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';
import {
  draftPullRequest,
  workspacePathFor,
  createPullRequest,
} from '../control-plane/pr-creator';
import { showNotification } from '../tray';

const execFileAsync = promisify(execFile);

export function registerPrHandlers(ctx: IpcContext): void {
  ipcMain.handle(INVOKE_CHANNELS.PR_DRAFT_BODY, async (_event, stackId: string) => {
    const stack = await ctx.stackManager.getStackWithServices(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);
    const prDescriptor = ctx.registry.getEffectiveTouchpointDescriptor(
      stack.project_dir,
      'pr_description',
    );
    if (prDescriptor.backend === 'opencode' && prDescriptor.credentials === null) {
      return {
        status: 'needs_key' as const,
        backend: prDescriptor.backend,
        provider: prDescriptor.provider,
      };
    }
    return draftPullRequest(
      {
        stackId,
        workspace: workspacePathFor(stack.project_dir, stackId),
        ticket: stack.ticket,
      },
      {
        runEphemeral: (prompt, projectDir, timeoutMs) =>
          ctx.agentBackend.runEphemeralAgent(
            prompt,
            projectDir,
            timeoutMs,
            { ticketId: stack.ticket ?? undefined, stage: 'pr' },
            undefined,
            'pr_description',
          ),
        fetchTaskTail: (id) => ctx.stackManager.getTaskOutput(id, 50).catch(() => ''),
      },
    );
  });

  ipcMain.handle(
    INVOKE_CHANNELS.PR_CREATE,
    async (_event, stackId: string, title: string, body: string) => {
      const stack = await ctx.stackManager.getStackWithServices(stackId);
      if (!stack) throw new Error(`Stack "${stackId}" not found`);

      const workspace = workspacePathFor(stack.project_dir, stackId);
      if (!fs.existsSync(workspace)) {
        throw new Error(`Stack workspace not found at ${workspace}`);
      }

      return createPullRequest(
        { stackId, title, body },
        {
          workspace,
          runGitPush: async (commitMsg) => {
            await ctx.stackManager.push(stackId, commitMsg);
          },
          createPROnHost: async (prTitle, bodyFilePath, head, base) => {
            const { stdout } = await execFileAsync(
              'gh',
              ['pr', 'create', '--title', prTitle, '--body-file', bodyFilePath, '--base', base, '--head', head],
              { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024 },
            );
            return stdout;
          },
          checkoutBranch: (branch) =>
            ctx.stackManager.execInContainer(stackId, ['git', 'checkout', '-b', branch]),
          setPullRequest: (url, num) => ctx.stackManager.setPullRequest(stackId, url, num),
        },
      );
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.PR_MERGE,
    async (_event, stackId: string, prNumber: number) => {
      const stack = await ctx.stackManager.getStackWithServices(stackId);
      if (!stack) throw new Error(`Stack "${stackId}" not found`);
      const workspace = workspacePathFor(stack.project_dir, stackId);
      try {
        await execFileAsync(
          'gh',
          ['pr', 'merge', String(prNumber), '--squash'],
          { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024 },
        );
        return { status: 'merged' } as const;
      } catch (err) {
        const detail = err as { stderr?: unknown; message?: unknown };
        const text = `${String(detail?.stderr ?? '')} ${String(detail?.message ?? '')}`;
        if (/already merged/i.test(text)) return { status: 'merged' } as const;
        const originalError = err instanceof Error ? err.message : String(err);
        try {
          const { stdout } = await execFileAsync(
            'gh',
            ['pr', 'view', String(prNumber), '--json', 'mergeable'],
            { cwd: workspace, timeout: 30000, maxBuffer: 1024 * 1024 },
          );
          const pr = JSON.parse(stdout.trim()) as { mergeable?: string };
          if ((pr.mergeable ?? 'UNKNOWN') === 'CONFLICTING') {
            return { status: 'conflict' } as const;
          }
        } catch {
          // Re-query failed; fall through to return failed with the original error.
        }
        return { status: 'failed', error: originalError } as const;
      }
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.PR_CREATE_AUTO, async (_event, stackId: string) => {
    const stack = await ctx.stackManager.getStackWithServices(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    const workspace = workspacePathFor(stack.project_dir, stackId);
    const prDescriptor = ctx.registry.getEffectiveTouchpointDescriptor(
      stack.project_dir,
      'pr_description',
    );
    if (prDescriptor.backend === 'opencode' && prDescriptor.credentials === null) {
      return {
        status: 'needs_key' as const,
        backend: prDescriptor.backend,
        provider: prDescriptor.provider,
      };
    }

    let draft: { title: string; body: string };
    try {
      draft = await draftPullRequest(
        { stackId, workspace, ticket: stack.ticket },
        {
          runEphemeral: (prompt, projectDir, timeoutMs) =>
            ctx.agentBackend.runEphemeralAgent(
              prompt,
              projectDir,
              timeoutMs,
              { ticketId: stack.ticket ?? undefined, stage: 'pr' },
              undefined,
              'pr_description',
            ),
          fetchTaskTail: (id) => ctx.stackManager.getTaskOutput(id, 50).catch(() => ''),
        },
      );
    } catch {
      return { status: 'draft_failed' as const };
    }

    if (!fs.existsSync(workspace)) {
      return {
        status: 'create_failed' as const,
        draft,
        error: 'Workspace directory not found',
      };
    }

    try {
      const result = await createPullRequest(
        { stackId, title: draft.title, body: draft.body },
        {
          workspace,
          runGitPush: async (commitMsg) => {
            await ctx.stackManager.push(stackId, commitMsg);
          },
          createPROnHost: async (prTitle, bodyFilePath, head, base) => {
            const { stdout } = await execFileAsync(
              'gh',
              ['pr', 'create', '--title', prTitle, '--body-file', bodyFilePath, '--base', base, '--head', head],
              { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024 },
            );
            return stdout;
          },
          checkoutBranch: (branch) =>
            ctx.stackManager.execInContainer(stackId, ['git', 'checkout', '-b', branch]),
          setPullRequest: (url, num) => ctx.stackManager.setPullRequest(stackId, url, num),
        },
      );
      showNotification('PR created', result.url);
      ctx.darkFactoryOrchestrator?.handlePrCreated(stackId, result.number);
      return { status: 'created' as const, url: result.url, number: result.number };
    } catch (err) {
      return {
        status: 'create_failed' as const,
        draft,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(
    INVOKE_CHANNELS.PR_AUTO_RESOLVE,
    async (_event, ticketId: string, projectDir: string) => {
      return ctx.stackManager.autoResolveConflicts(ticketId, projectDir);
    },
  );
}
