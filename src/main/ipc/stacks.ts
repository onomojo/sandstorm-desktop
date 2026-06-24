import { ipcMain } from 'electron';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';
import type { CreateStackOpts } from '../control-plane/stack-manager';

export function registerStackHandlers(ctx: IpcContext): void {
  ipcMain.handle(INVOKE_CHANNELS.STACKS_LIST, async () => {
    return ctx.stackManager.listStacksWithServices();
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_GET, async (_event, stackId: string) => {
    return ctx.stackManager.getStackWithServices(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_CREATE, (_event, opts: CreateStackOpts) => {
    return ctx.stackManager.createStack(opts);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_TEARDOWN, async (_event, stackId: string) => {
    await ctx.stackManager.teardownStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_STOP, (_event, stackId: string) => {
    ctx.stackManager.stopStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_START, (_event, stackId: string) => {
    ctx.stackManager.startStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_HISTORY, async () => {
    return ctx.stackManager.listStackHistory();
  });

  ipcMain.handle(
    INVOKE_CHANNELS.STACKS_SET_PR,
    (_event, stackId: string, prUrl: string, prNumber: number) => {
      ctx.stackManager.setPullRequest(stackId, prUrl, prNumber);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.STACKS_DETECT_STALE, async () => {
    return ctx.stackManager.detectStaleWorkspaces();
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_CLEANUP_STALE, async (_event, workspacePaths: string[]) => {
    return ctx.stackManager.cleanupStaleWorkspaces(workspacePaths);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_GET_NEEDS_HUMAN_QUESTIONS, (_event, stackId: string) => {
    return ctx.registry.getNeedsHumanQuestions(stackId);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.STACKS_RESUME_NEEDS_HUMAN,
    async (_event, stackId: string, answers: string) => {
      await ctx.stackManager.resumeNeedsHumanStack(stackId, answers);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.STACKS_ASK_CLARIFYING_QUESTIONS,
    async (_event, stackId: string) => {
      await ctx.stackManager.askClarifyingQuestions(stackId);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.STACKS_RECHECK_COMPLETED, async (_event, stackId: string) => {
    return ctx.stackManager.recheckCompletedStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_RECONCILE_STATUS, async (_event, stackId: string) => {
    return ctx.stackManager.reconcileStatus(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_SELF_HEAL_CONTINUE, async (_event, stackId: string) => {
    await ctx.stackManager.selfHealContinue(stackId);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.STACKS_RESTART_WITH_FINDINGS,
    async (_event, stackId: string, findings: string) => {
      return ctx.stackManager.restartWithFindings(stackId, findings);
    },
  );
}
