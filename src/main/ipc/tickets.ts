import { ipcMain } from 'electron';
import path from 'path';
import { randomUUID } from 'crypto';
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';
import {
  defaultSpecGateDeps,
  fetchTicketForRenderer,
  runSpecCheck,
  runSpecRefine,
  finalizeSpecGatePass,
  extractQuestions,
  extractGateSummary,
  shortBodyHash,
  capReportText,
  type SpecGateReport,
  type SpecGateResult,
} from '../control-plane/ticket-spec';
import {
  loadRefinements,
  persistRefinement,
  deleteRefinement,
  filterSessionsByBoardState,
  type RefinementSession,
} from '../control-plane/refinement-store';
import { handleToolCall, spawnSpecCheck, spawnSpecRefine, makeContractGateDeps } from '../claude/tools';
import { listTicketsWithConfig } from '../control-plane/ticket-lister';
import { listTicketComments, postComment } from '../control-plane/ticket-comments';
import { getLatestUserAnswers, ANSWER_COMMENT_MARKER, GATE_FAIL_REPORT_MARKER } from '../scheduler/refine-to-comments';
import { KANBAN_COLUMNS } from '../../shared/kanban';
import { validateProjectDir } from '../validation';
import {
  createTicketWithConfig,
  updateTicketWithConfig,
  fetchRawBodyWithConfig,
  testJiraConnection,
  closeTicketWithConfig,
  markTicketDoneWithConfig,
} from '../control-plane/ticket-config';
import { withRetry } from '../control-plane/retry-with-backoff';
import type { TicketListError } from '../control-plane/ticket-config';
import type { EphemeralStreamEvent } from '../agent/types';

export function registerTicketHandlers(ctx: IpcContext): void {
  const specDeps = defaultSpecGateDeps(
    (ticketId, projectDir) =>
      handleToolCall('spec_check', { ticketId, projectDir }) as Promise<SpecGateReport>,
    (ticketId, projectDir, userAnswers) =>
      handleToolCall('spec_refine', { ticketId, projectDir, userAnswers }) as Promise<SpecGateReport>,
    (projectDir) => ctx.registry.getProjectTicketConfig(projectDir),
    makeContractGateDeps(),
  );

  const activeRefinements = new Map<
    string,
    { session: RefinementSession; cancel: (() => void) | null }
  >();

  function emitRefinementUpdate(session: RefinementSession): void {
    ctx.mainWindow?.webContents.send(EVENT_CHANNELS.REFINEMENT_UPDATE, session);
  }

  function cancelRefinementSession(id: string, broadcast = true): void {
    const entry = activeRefinements.get(id);
    if (entry) {
      entry.cancel?.();
      activeRefinements.delete(id);
      deleteRefinement(id);
      if (broadcast) {
        ctx.mainWindow?.webContents.send(EVENT_CHANNELS.REFINEMENT_UPDATE, {
          id,
          status: 'cancelled',
        });
      }
    }
  }

  // Load persisted sessions on startup and prune stale ones
  const persistedSessions = loadRefinements();
  const startupColumnCache = new Map<string, Map<string, string>>();
  const { keep: sessionsToKeep, prune: sessionsToPrune } = filterSessionsByBoardState(
    persistedSessions,
    (ticketId, projectDir) => {
      if (!startupColumnCache.has(projectDir)) {
        const rows = ctx.registry.listBoardTickets(projectDir);
        startupColumnCache.set(
          projectDir,
          new Map(rows.map((r) => [r.ticket_id, r.column])),
        );
      }
      return startupColumnCache.get(projectDir)!.get(ticketId) ?? null;
    },
  );

  for (const s of sessionsToPrune) {
    deleteRefinement(s.id);
  }

  for (const s of sessionsToKeep) {
    activeRefinements.set(s.id, { session: s, cancel: null });
    persistRefinement(s);
  }

  // Cancel refinement sessions when a ticket leaves the refinement lifecycle
  const REFINEMENT_CLEANUP_COLUMNS = new Set(['backlog', 'in_stack', 'merged']);
  ctx.registry.onBoardTicketMoved((ticketId, projectDir, column) => {
    if (!REFINEMENT_CLEANUP_COLUMNS.has(column)) return;
    for (const [id, entry] of activeRefinements) {
      if (
        entry.session.ticketId === ticketId &&
        entry.session.projectDir === projectDir
      ) {
        cancelRefinementSession(id);
        break;
      }
    }
  });

  // Broadcast persisted sessions after renderer mounts
  setTimeout(() => {
    for (const { session } of activeRefinements.values()) {
      emitRefinementUpdate(session);
    }
  }, 500);

  function startRefinementAsync(
    ticketId: string,
    projectDir: string,
    existingSessionId: string | null,
    phase: 'check' | 'refine',
    userAnswers?: string,
  ): string {
    const id = existingSessionId ?? randomUUID();
    const session: RefinementSession = {
      id,
      ticketId,
      projectDir,
      status: 'running',
      phase,
      startedAt: Date.now(),
    };
    persistRefinement(session);
    emitRefinementUpdate(session);

    const onChunk = (event: EphemeralStreamEvent): void => {
      const delta =
        event.kind === 'tool_use' ? `→ ${event.summary}\n` : event.delta;
      ctx.mainWindow?.webContents.send(EVENT_CHANNELS.REFINEMENT_PROGRESS, {
        sessionId: id,
        delta,
      });
    };

    const { promise, cancel } =
      phase === 'check'
        ? spawnSpecCheck(ticketId, projectDir, onChunk)
        : spawnSpecRefine(ticketId, projectDir, userAnswers, onChunk);

    activeRefinements.set(id, { session, cancel });

    promise
      .then(async (rawReport) => {
        const entry = activeRefinements.get(id);
        if (!entry) return;

        const url = await specDeps.readTicketUrl(ticketId);
        let passed = !!rawReport.passed;
        const reportText = (rawReport as unknown as SpecGateReport).report || '';
        const rawError = (rawReport as unknown as SpecGateReport & { error?: string }).error;

        let contractError: string | undefined;
        if (passed && phase === 'check') {
          const body = await specDeps.fetchTicket(ticketId, projectDir);
          if (body) {
            const fin = await finalizeSpecGatePass(
              ticketId,
              projectDir,
              body,
              shortBodyHash(body),
              specDeps,
            );
            if (!fin.ok) {
              passed = false;
              contractError = fin.error;
            }
          } else {
            passed = false;
            contractError = 'Could not fetch ticket body for contract generation';
          }
        }

        const cappedReport = capReportText(reportText);

        const result: SpecGateResult = rawError
          ? {
              passed: false,
              questions: [],
              gateSummary: '',
              ticketUrl: url || null,
              cached: false,
              error: rawError,
            }
          : contractError
            ? {
                passed: false,
                questions: [],
                gateSummary: 'Spec passed; contract generation failed',
                ticketUrl: url || null,
                cached: false,
                contractError,
              }
            : {
                passed,
                questions: passed ? [] : extractQuestions(reportText),
                gateSummary: extractGateSummary(reportText),
                ticketUrl: url || null,
                cached: false,
                reportText: passed ? null : cappedReport || null,
              };

        const done: RefinementSession = { ...session, status: 'ready', result };
        activeRefinements.set(id, { session: done, cancel: null });
        persistRefinement(done);
        emitRefinementUpdate(done);

        if (!passed && !rawError && !contractError && cappedReport) {
          postComment(
            ticketId,
            projectDir,
            `${GATE_FAIL_REPORT_MARKER}\n\n${cappedReport}`,
          ).catch(() => {});
        }
      })
      .catch((err: unknown) => {
        const entry = activeRefinements.get(id);
        if (!entry) return;
        const msg = err instanceof Error ? err.message : String(err);
        const failed: RefinementSession = { ...session, status: 'errored', error: msg };
        activeRefinements.set(id, { session: failed, cancel: null });
        persistRefinement(failed);
        emitRefinementUpdate(failed);
      });

    return id;
  }

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_FETCH,
    async (_event, ticketId: string, projectDir: string) => {
      const config = ctx.registry.getProjectTicketConfig(projectDir);
      return fetchTicketForRenderer(ticketId, config, projectDir);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_SPEC_CHECK,
    async (_event, ticketId: string, projectDir: string) => {
      return runSpecCheck(ticketId, projectDir, specDeps);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_SPEC_REFINE,
    async (_event, ticketId: string, projectDir: string, userAnswers: string) => {
      return runSpecRefine(ticketId, projectDir, userAnswers, specDeps);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_SPEC_CHECK_ASYNC,
    (_event, ticketId: string, projectDir: string) => {
      const sessionId = startRefinementAsync(ticketId, projectDir, null, 'check');
      return { sessionId };
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_SPEC_REFINE_ASYNC,
    (_event, sessionId: string, ticketId: string, projectDir: string, userAnswers: string) => {
      startRefinementAsync(ticketId, projectDir, sessionId, 'refine', userAnswers);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.TICKETS_CANCEL_REFINEMENT, (_event, id: string) => {
    cancelRefinementSession(id);
  });

  ipcMain.handle(INVOKE_CHANNELS.TICKETS_LIST_REFINEMENTS, () => {
    return Array.from(activeRefinements.values()).map((e) => e.session);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_RETRY_REFINEMENT_ASYNC,
    async (_event, sessionId: string, ticketId: string, projectDir: string) => {
      const existingEntry = sessionId ? activeRefinements.get(sessionId) : undefined;
      const existingSession = existingEntry?.session;

      if (existingEntry) {
        cancelRefinementSession(sessionId, false);
      }

      let phase: 'check' | 'refine' = 'check';
      let userAnswers: string | undefined;

      if (existingSession?.phase === 'refine') {
        try {
          const comments = await listTicketComments(ticketId, projectDir);
          const answers = getLatestUserAnswers(comments);
          if (answers) {
            phase = 'refine';
            userAnswers = answers;
          }
        } catch {
          // fall through to check
        }
      }

      const newSessionId = startRefinementAsync(ticketId, projectDir, null, phase, userAnswers);
      return { sessionId: newSessionId };
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_POST_ANSWERS,
    async (_event, ticketId: string, projectDir: string, answersBody: string) => {
      if (!answersBody.trim()) return;
      const body = `${ANSWER_COMMENT_MARKER}\n\n${answersBody}`;
      await postComment(ticketId, projectDir, body);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_CREATE,
    async (_event, projectDir: string, title: string, body: string) => {
      const config = ctx.registry.getProjectTicketConfig(projectDir);
      if (!config) {
        throw new Error(
          'No ticket provider configured for this project. Configure GitHub or Jira in Project Settings.',
        );
      }
      const result = await createTicketWithConfig({ title, body, config, cwd: projectDir });
      ctx.registry.seedBoardTicket(result.ticketId, path.resolve(projectDir), title);
      return result;
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_FETCH_RAW,
    async (_event, ticketId: string, projectDir: string) => {
      const config = ctx.registry.getProjectTicketConfig(projectDir);
      if (!config) {
        throw new Error(
          'No ticket provider configured for this project. Configure GitHub or Jira in Project Settings.',
        );
      }
      return fetchRawBodyWithConfig(ticketId, config, projectDir);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_UPDATE,
    async (_event, projectDir: string, ticketId: string, body: string) => {
      const config = ctx.registry.getProjectTicketConfig(projectDir);
      if (!config) {
        throw new Error(
          'No ticket provider configured for this project. Configure GitHub or Jira in Project Settings.',
        );
      }
      await updateTicketWithConfig(ticketId, body, config, projectDir);
    },
  );

  const VALID_KANBAN_COLUMNS: readonly string[] = KANBAN_COLUMNS;

  ipcMain.handle(INVOKE_CHANNELS.TICKETS_LIST, async (_event, projectDir: string) => {
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    const normalizedDir = path.resolve(projectDir);

    let listError: TicketListError | null = null;
    let fetchedIds: string[] | null = null;
    const config = ctx.registry.getProjectTicketConfig(normalizedDir);
    if (config) {
      try {
        const result = await listTicketsWithConfig(config, normalizedDir);
        if (result.ok) {
          for (const ticket of result.tickets) {
            ctx.registry.seedBoardTicket(ticket.id, normalizedDir, ticket.title);
          }
          fetchedIds = result.tickets.map((t) => t.id);
          const deletedCount = ctx.registry.deleteClosedEarlyColumnTickets(
            normalizedDir,
            fetchedIds,
          );
          if (deletedCount > 0) {
            console.log(
              `[tickets:list] Removed ${deletedCount} closed early-column ticket(s) from board for project: ${normalizedDir}`,
            );
          }
        } else {
          listError = result.error;
          console.error('[tickets:list] Failed to fetch tickets from provider:', result.error);
        }
      } catch (err) {
        console.error('[tickets:list] Failed to fetch tickets from provider:', err);
      }
    }

    const tickets =
      fetchedIds !== null
        ? ctx.registry.listBoardTicketsInOrder(normalizedDir, fetchedIds)
        : ctx.registry.listBoardTickets(normalizedDir);
    return { tickets, error: listError };
  });

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_TEST_JIRA_CONNECTION,
    async (
      _event,
      params: {
        jiraUrl: string;
        jiraUsername: string;
        jiraApiToken: string;
        jiraProjectKey?: string | null;
        filterMode?: 'assisted' | 'advanced' | null;
        filterOwnership?: 'created' | 'assigned' | null;
        filterOpenOnly?: boolean | null;
        filterQuery?: string | null;
        label?: string;
      },
    ) => {
      return testJiraConnection(params);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKET_BOARD_SET_COLUMN,
    async (_event, ticketId: string, projectDir: string, column: string) => {
      if (!ticketId?.trim()) throw new Error('ticketId is required');
      const dirError = validateProjectDir(projectDir);
      if (dirError) throw new Error(dirError.error);
      if (!VALID_KANBAN_COLUMNS.includes(column))
        throw new Error(`Invalid kanban column: "${column}"`);
      ctx.registry.setBoardTicketColumn(ticketId, path.resolve(projectDir), column);
      ctx.darkFactoryOrchestrator?.handleTicketColumnChanged(
        ticketId,
        path.resolve(projectDir),
        column,
      );
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKET_CLOSE,
    async (
      _event,
      { ticketId, projectDir }: { ticketId: string; projectDir: string },
    ) => {
      if (!ticketId?.trim()) throw new Error('ticketId is required');
      const dirError = validateProjectDir(projectDir);
      if (dirError) throw new Error(dirError.error);
      const config = ctx.registry.getProjectTicketConfig(projectDir);
      if (!config)
        throw new Error(`No ticket provider configured for project: ${projectDir}`);
      await closeTicketWithConfig(ticketId, config, path.resolve(projectDir));
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKET_MARK_DONE,
    async (
      _event,
      { ticketId, projectDir }: { ticketId: string; projectDir: string },
    ) => {
      const resolvedDir = path.resolve(projectDir);
      const config = ctx.registry.getProjectTicketConfig(resolvedDir);
      if (!config) return { ok: true };
      try {
        await withRetry(
          () => markTicketDoneWithConfig(ticketId, config, resolvedDir),
          { maxAttempts: 3, baseDelayMs: 1000 },
        );
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKET_BOARD_DELETE,
    async (
      _event,
      { ticketId, projectDir }: { ticketId: string; projectDir: string },
    ) => {
      if (!ticketId?.trim()) throw new Error('ticketId is required');
      const dirError = validateProjectDir(projectDir);
      if (dirError) throw new Error(dirError.error);
      ctx.registry.deleteBoardTicket(ticketId, path.resolve(projectDir));
    },
  );
}
