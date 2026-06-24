import { ipcMain } from 'electron';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';
import { createUsageEngine, clearUsageCache } from '../telemetry/usage-engine';
import type { DateRange, ByTicketEntry, ByEpicEntry } from '../telemetry/usage-engine';
import { readEphemeralTimingRecords } from '../agent/ephemeral-timing';
import { ORCHESTRATOR_TICKET_ID } from '../telemetry/types';
import { TicketRollupStore } from '../telemetry/rollup-store';
import { fetchAccountUsage } from '../control-plane/account-usage';

export function registerStatsHandlers(ctx: IpcContext): void {
  const rollupStore = new TicketRollupStore(ctx.registry.getDb());

  function buildTelemetryRoots(): string[] {
    const hostRoot = os.homedir() + '/.claude/projects';
    const stackRoots: string[] = [];
    for (const project of ctx.registry.listProjects()) {
      const usageDir = path.join(project.directory, '.sandstorm', 'usage');
      try {
        const entries = fs.readdirSync(usageDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            stackRoots.push(path.join(usageDir, entry.name));
          }
        }
      } catch {
        // usage dir doesn't exist yet — skip
      }
    }
    return [hostRoot, ...stackRoots];
  }

  ipcMain.handle(INVOKE_CHANNELS.STATS_STACK_MEMORY, async (_event, stackId: string) => {
    return ctx.stackManager.getStackMemoryUsage(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_STACK_DETAILED, async (_event, stackId: string) => {
    return ctx.stackManager.getStackDetailedStats(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TASK_METRICS, async (_event, stackId: string) => {
    return ctx.stackManager.getStackTaskMetrics(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TOKEN_USAGE, async (_event, stackId: string) => {
    return ctx.stackManager.getStackTokenUsage(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_GLOBAL_TOKEN_USAGE, async () => {
    return ctx.stackManager.getGlobalTokenUsage();
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_RATE_LIMIT, async () => {
    return ctx.stackManager.getRateLimitState();
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_ACCOUNT_USAGE, async () => {
    return fetchAccountUsage();
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_SUMMARY, async (_event, range: DateRange) => {
    const engine = createUsageEngine(buildTelemetryRoots());
    const summary = engine.getSummary(range);
    const shipped = rollupStore.ticketsShipped();
    const allByTicket = engine.getByTicket({ since: '2000-01-01', until: '2099-12-31' });
    const totalCost = allByTicket
      .filter((e) => e.ticketId !== ORCHESTRATOR_TICKET_ID)
      .reduce((sum, e) => sum + e.cost, 0);
    return {
      ...summary,
      ticketsShipped: shipped,
      costPerTicket: shipped > 0 ? totalCost / shipped : null,
    };
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_DAILY, async (_event, range: DateRange) => {
    return createUsageEngine(buildTelemetryRoots()).getDaily(range);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_BY_MODEL, async (_event, range: DateRange) => {
    return createUsageEngine(buildTelemetryRoots()).getByModel(range);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_SESSION, async (_event, range: DateRange) => {
    return createUsageEngine(buildTelemetryRoots()).getSessions(range);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.STATS_TELEMETRY_BY_TICKET,
    async (_event, range?: DateRange): Promise<ByTicketEntry[]> => {
      const stepWeights = ctx.registry.getStepWeightsByTicket();
      const taskPhaseWeights = ctx.registry.getTaskPhaseTokensByTicket();
      const allEphemeral = readEphemeralTimingRecords(ctx.agentBackend.getEphemeralTimingPath());
      const ephemeralRecords = allEphemeral
        .filter((r) => r.ticketId != null && r.stage != null)
        .map((r) => ({ ticketId: r.ticketId!, stage: r.stage!, tokens: r.tokens ?? 0 }));
      return createUsageEngine(
        buildTelemetryRoots(),
        stepWeights,
        ephemeralRecords,
        taskPhaseWeights,
      ).getByTicket(range);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.STATS_TELEMETRY_BY_EPIC,
    async (_event, range?: DateRange): Promise<ByEpicEntry[]> => {
      const stepWeights = ctx.registry.getStepWeightsByTicket();
      const taskPhaseWeights = ctx.registry.getTaskPhaseTokensByTicket();
      const allEphemeral = readEphemeralTimingRecords(ctx.agentBackend.getEphemeralTimingPath());
      const ephemeralRecords = allEphemeral
        .filter((r) => r.ticketId != null && r.stage != null)
        .map((r) => ({ ticketId: r.ticketId!, stage: r.stage!, tokens: r.tokens ?? 0 }));
      const epicTasks = ctx.registry.getAllEpicTasks();
      return createUsageEngine(
        buildTelemetryRoots(),
        stepWeights,
        ephemeralRecords,
        taskPhaseWeights,
      ).getByEpic(epicTasks, range);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_REFRESH, async () => {
    clearUsageCache();
    return { ok: true };
  });
}
