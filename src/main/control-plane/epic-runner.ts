import path from 'path';
import { isEpic, parseEpicBody, type EdgeEntry, type RunPlan } from './epic-plan';
import type {
  EpicRunState,
  EpicStatus,
  EpicTask,
  EpicTaskOrigin,
  EpicTaskRole,
  ProjectTicketConfig,
  Stack,
  StackStatus,
} from './registry';
import type { CreateStackOpts, DispatchTaskResult } from './stack-manager';
import { sanitizeComposeName } from './stack-manager';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface SubtaskStatus {
  ticketId: string;
  done: boolean;
  inFlight: boolean;
  queued: boolean;
  isBarrier: boolean;
}

export interface EpicStatusSnapshot {
  epicId: string;
  status: EpicStatus;
  subtasks: SubtaskStatus[];
}

export type StartEpicResult =
  | { already: true }
  | { runnable: false; reasons: string[] }
  | { ok: true; snapshot: EpicStatusSnapshot };

// ---------------------------------------------------------------------------
// Dependency injection seam (enables unit testing without vi.mock)
// ---------------------------------------------------------------------------

export interface EpicRunnerDeps {
  listStacks: () => Stack[];
  getEpicTasks: (epicId: string) => EpicTask[];
  upsertEpicRunState: (epicId: string, projectDir: string, status: EpicStatus) => void;
  upsertEpicTask: (
    epicId: string,
    ticketId: string,
    opts: { role: EpicTaskRole; origin: EpicTaskOrigin; critId?: string },
  ) => void;
  setEpicTaskDone: (epicId: string, ticketId: string) => void;
  getEpicRunState: (epicId: string) => EpicRunState | null;
  getDarkFactoryEnabled: (projectDir: string) => boolean;
  getEpicMaxParallelStacks: (projectDir: string) => number;
  getProjectTicketConfig: (projectDir: string) => ProjectTicketConfig | null;
  createStack: (opts: CreateStackOpts) => Stack;
  dispatchTask: (stackId: string, prompt: string) => Promise<DispatchTaskResult>;
  fetchTicketWithConfig: (
    ticketId: string,
    config: ProjectTicketConfig,
    cwd: string,
  ) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// DAG helpers (pure functions, no side effects — easy to unit-test)
// ---------------------------------------------------------------------------

/** Returns subtask IDs in topological order (Kahn's algorithm). */
export function topologicalSort(subtaskIds: string[], edges: EdgeEntry[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const id of subtaskIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  for (const { from, to } of edges) {
    adj.get(from)?.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  const queue = subtaskIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const result: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }
  return result;
}

/**
 * Returns the set of subtask IDs that are DAG articulation points.
 * Uses iterative DFS to avoid stack overflow on deep graphs.
 */
export function computeArticulationPoints(subtaskIds: string[], edges: EdgeEntry[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const id of subtaskIds) adj.set(id, []);
  for (const { from, to } of edges) {
    adj.get(from)?.push(to);
    adj.get(to)?.push(from);
  }

  const visited = new Set<string>();
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const ap = new Set<string>();
  let timer = 0;

  // Iterative DFS with explicit stack carrying (node, neighborIndex) state
  for (const start of subtaskIds) {
    if (visited.has(start)) continue;

    parent.set(start, null);
    const stack: Array<{ u: string; ni: number; childCount: number }> = [
      { u: start, ni: 0, childCount: 0 },
    ];
    disc.set(start, timer);
    low.set(start, timer);
    visited.add(start);
    timer++;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const { u } = frame;
      const neighbors = adj.get(u) ?? [];

      if (frame.ni < neighbors.length) {
        const v = neighbors[frame.ni];
        frame.ni++;

        if (!visited.has(v)) {
          frame.childCount++;
          parent.set(v, u);
          disc.set(v, timer);
          low.set(v, timer);
          visited.add(v);
          timer++;
          stack.push({ u: v, ni: 0, childCount: 0 });
        } else if (v !== parent.get(u)) {
          low.set(u, Math.min(low.get(u)!, disc.get(v)!));
        }
      } else {
        stack.pop();
        if (stack.length > 0) {
          const parentFrame = stack[stack.length - 1];
          const p = parentFrame.u;
          low.set(p, Math.min(low.get(p)!, low.get(u)!));

          const isRoot = parent.get(p) === null;
          if (isRoot && parentFrame.childCount > 1) ap.add(p);
          if (!isRoot && (low.get(u) ?? 0) >= (disc.get(p) ?? 0)) ap.add(p);
        }
      }
    }
  }

  return ap;
}

/** Returns subtask IDs whose predecessors are all done (and the task itself is not done). */
export function computeRunnableSet(
  subtaskIds: string[],
  edges: EdgeEntry[],
  doneSet: Set<string>,
): string[] {
  const predecessors = new Map<string, Set<string>>();
  for (const id of subtaskIds) predecessors.set(id, new Set());
  for (const { from, to } of edges) predecessors.get(to)?.add(from);

  return subtaskIds.filter((id) => {
    if (doneSet.has(id)) return false;
    const preds = predecessors.get(id) ?? new Set<string>();
    return [...preds].every((p) => doneSet.has(p));
  });
}

// ---------------------------------------------------------------------------
// Terminal / non-terminal classification
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<StackStatus>(['completed', 'failed', 'stopped']);

function isTerminal(status: StackStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isActiveForEpic(stack: Stack, epicSubtaskIds: Set<string>): boolean {
  return !!stack.ticket && epicSubtaskIds.has(stack.ticket) && !isTerminal(stack.status);
}

// ---------------------------------------------------------------------------
// Stack name generator
// ---------------------------------------------------------------------------

function epicStackName(epicId: string, ticketId: string): string {
  const ts = Date.now();
  const safe = (s: string) => sanitizeComposeName(s).slice(0, 20);
  return `${safe(epicId)}-${safe(ticketId)}-${ts}`;
}

// ---------------------------------------------------------------------------
// No-op hook (v1)
// ---------------------------------------------------------------------------

export async function onBarrierReached(_epicId: string, _barrierTicketId: string): Promise<void> {
  // v1: intentional no-op; future versions may notify the renderer or pause the run
}

// ---------------------------------------------------------------------------
// EpicRunner class
// ---------------------------------------------------------------------------

export class EpicRunner {
  private activeEpics = new Map<string, { projectDir: string }>();
  private onStatusUpdate?: (epicId: string, snapshot: EpicStatusSnapshot) => void;

  constructor(private deps: EpicRunnerDeps) {}

  setOnStatusUpdate(cb: (epicId: string, snapshot: EpicStatusSnapshot) => void): void {
    this.onStatusUpdate = cb;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start (or resume) an epic.  Returns `{ already: true }` if the runner
   * already has the epic in-flight.  Returns `{ runnable: false }` if the
   * RunPlan says the epic is not ready to run.
   */
  async startEpic(epicId: string, projectDir: string): Promise<StartEpicResult> {
    if (this.activeEpics.has(epicId) || this.deps.getEpicRunState(epicId)?.status === 'running') {
      return { already: true };
    }

    // Fetch and parse the epic ticket
    const config = this.deps.getProjectTicketConfig(projectDir);
    if (!config) {
      return { runnable: false, reasons: ['No ticket provider configured for this project'] };
    }

    const body = await this.deps.fetchTicketWithConfig(epicId, config, projectDir);
    if (!body) {
      return { runnable: false, reasons: [`Could not fetch epic ticket ${epicId}`] };
    }

    const labelsMatch = body.match(/^Labels:\s*(.+)/m);
    const labels = labelsMatch ? labelsMatch[1].split(',').map((s) => s.trim()) : [];
    if (!isEpic(labels)) {
      return { runnable: false, reasons: ['Not an epic ticket'] };
    }

    const plan = parseEpicBody(epicId, body);
    if (!plan.runnable) {
      return { runnable: false, reasons: plan.notRunnableReasons };
    }

    // Register epic as active (in-flight guard)
    this.activeEpics.set(epicId, { projectDir });
    this.deps.upsertEpicRunState(epicId, projectDir, 'running');

    // Seed subtasks into registry
    for (const subtask of plan.subtasks) {
      this.deps.upsertEpicTask(epicId, subtask.ticketId, { role: 'build', origin: 'planned' });
    }

    // Cold-start seeding: mark already-CLOSED subtasks as done
    await this.seedClosedTickets(epicId, projectDir, plan, config);

    // Dispatch first batch
    const snapshot = await this.advanceEpic(epicId, projectDir, plan);
    return { ok: true, snapshot };
  }

  /**
   * Parse-only dry run — no state writes.  Used by `epic:getRunPlan` IPC.
   */
  async getRunPlan(epicId: string, projectDir: string): Promise<RunPlan | null> {
    const config = this.deps.getProjectTicketConfig(projectDir);
    if (!config) return null;

    const body = await this.deps.fetchTicketWithConfig(epicId, config, projectDir);
    if (!body) return null;

    return parseEpicBody(epicId, body);
  }

  /**
   * Called whenever any stack changes status.  Advances all active epics.
   */
  async onAnyStackUpdated(): Promise<void> {
    await Promise.allSettled(
      [...this.activeEpics.entries()].map(([epicId, { projectDir }]) =>
        this.advanceEpicFromRegistry(epicId, projectDir),
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async seedClosedTickets(
    epicId: string,
    projectDir: string,
    plan: RunPlan,
    config: ProjectTicketConfig,
  ): Promise<void> {
    const existing = new Set(
      this.deps.getEpicTasks(epicId).filter((t) => t.done === 1).map((t) => t.ticket_id),
    );

    await Promise.allSettled(
      plan.subtasks.map(async (subtask) => {
        if (existing.has(subtask.ticketId)) return; // already done — skip re-fetch
        try {
          const ticketBody = await this.deps.fetchTicketWithConfig(
            subtask.ticketId,
            config,
            projectDir,
          );
          if (ticketBody && isClosed(ticketBody)) {
            this.deps.setEpicTaskDone(epicId, subtask.ticketId);
          }
        } catch (err) {
          console.warn(`[EpicRunner] cold-start fetch failed for ${subtask.ticketId}:`, err);
        }
      }),
    );
  }

  /**
   * Re-fetches the RunPlan from the registry then advances.
   * Used by `onAnyStackUpdated` where we don't have the plan cached.
   */
  private async advanceEpicFromRegistry(epicId: string, projectDir: string): Promise<void> {
    const config = this.deps.getProjectTicketConfig(projectDir);
    if (!config) return;

    const body = await this.deps.fetchTicketWithConfig(epicId, config, projectDir);
    if (!body) return;

    const plan = parseEpicBody(epicId, body);
    if (!plan.runnable) return;
    await this.advanceEpic(epicId, projectDir, plan);
  }

  /**
   * Core dispatch loop.  Computes the runnable set, checks barriers, and
   * dispatches up to the concurrency cap.  Returns the current snapshot.
   */
  private async advanceEpic(
    epicId: string,
    projectDir: string,
    plan: RunPlan,
  ): Promise<EpicStatusSnapshot> {
    const subtaskIds = plan.subtasks.map((s) => s.ticketId);
    const spineId = plan.subtasks.find((s) => s.spine)?.ticketId ?? null;
    const subtaskIdSet = new Set(subtaskIds);
    const config = this.deps.getProjectTicketConfig(projectDir);

    // ---- Current state from registry ----
    const tasks = this.deps.getEpicTasks(epicId);
    const doneSet = new Set(tasks.filter((t) => t.done === 1).map((t) => t.ticket_id));

    // ---- One-way latch: warn when a done ticket's body shows OPEN ----
    // Covers tickets whose predecessors are all satisfied but are held done by the latch.
    if (config && doneSet.size > 0) {
      const predecessors = new Map<string, Set<string>>();
      for (const id of subtaskIds) predecessors.set(id, new Set());
      for (const { from, to } of plan.edges) predecessors.get(to)?.add(from);

      const latchCandidates = subtaskIds.filter((id) => {
        if (!doneSet.has(id)) return false;
        const preds = predecessors.get(id) ?? new Set<string>();
        return [...preds].every((p) => doneSet.has(p));
      });

      await Promise.allSettled(
        latchCandidates.map(async (id) => {
          try {
            const ticketBody = await this.deps.fetchTicketWithConfig(id, config, projectDir);
            if (ticketBody && !isClosed(ticketBody)) {
              console.warn(
                `[EpicRunner] Ticket ${id} is done (one-way latch) but ticket body is OPEN — skipping re-dispatch`,
              );
            }
          } catch (_) {
            console.warn(`[EpicRunner] latch-check fetch failed for ${id}:`, _);
          }
        }),
      );
    }

    // ---- Check if terminal stacks indicate newly-closed tickets ----
    // Only when dark factory is enabled — otherwise leave PR for user to merge manually
    if (config && this.deps.getDarkFactoryEnabled(projectDir)) {
      const allStacks = this.deps.listStacks();
      await this.markNewlyClosedTasks(epicId, projectDir, config, subtaskIds, doneSet, allStacks);
    }

    // ---- Runnable set and barrier detection ----
    const runnable = computeRunnableSet(subtaskIds, plan.edges, doneSet);
    const articulationPoints = computeArticulationPoints(subtaskIds, plan.edges);

    // ---- In-flight stacks for this epic ----
    const allStacks = this.deps.listStacks();
    const inFlightTickets = new Set(
      allStacks
        .filter((s) => isActiveForEpic(s, subtaskIdSet))
        .map((s) => s.ticket as string),
    );
    const inFlightCount = inFlightTickets.size;

    // ---- Concurrency cap ----
    const rawCap = this.deps.getEpicMaxParallelStacks(projectDir);
    const cap = Math.max(1, rawCap);
    const slotsAvailable = cap - inFlightCount;

    // ---- Filter dispatchable tasks ----
    // Tasks that are runnable, not adopted (no live stack), not done
    const dispatchable = runnable.filter((id) => !inFlightTickets.has(id) && !doneSet.has(id));

    // Sort: spine first, then stable
    dispatchable.sort((a, b) => {
      if (a === spineId) return -1;
      if (b === spineId) return 1;
      return subtaskIds.indexOf(a) - subtaskIds.indexOf(b);
    });

    // ---- Barrier drain check ----
    if (dispatchable.length > 0 && articulationPoints.has(dispatchable[0])) {
      if (inFlightCount > 0) {
        // Barrier requires drain — skip dispatch, wait for in-flight to settle
        const snapshot = this.buildSnapshot(
          epicId,
          subtaskIds,
          doneSet,
          inFlightTickets,
          new Set(dispatchable),
          articulationPoints,
        );
        this.onStatusUpdate?.(epicId, snapshot);
        return snapshot;
      }
      // All drained — call hook then fall through to dispatch
      await onBarrierReached(epicId, dispatchable[0]);
    }

    // ---- Dispatch up to cap ----
    if (slotsAvailable > 0 && config) {
      const toDispatch = dispatchable.slice(0, slotsAvailable);
      await Promise.allSettled(
        toDispatch.map((ticketId) => this.dispatchSubtask(epicId, ticketId, projectDir, config)),
      );
      // Refresh in-flight after dispatch
      const freshStacks = this.deps.listStacks();
      for (const s of freshStacks) {
        if (s.ticket && subtaskIdSet.has(s.ticket) && !isTerminal(s.status)) {
          inFlightTickets.add(s.ticket);
        }
      }
    }

    // ---- Check for epic completion ----
    const freshTasks = this.deps.getEpicTasks(epicId);
    const freshDone = new Set(freshTasks.filter((t) => t.done === 1).map((t) => t.ticket_id));
    const allDone = subtaskIds.every((id) => freshDone.has(id));
    const epicStatus: EpicStatus = allDone ? 'completed' : 'running';

    if (allDone) {
      this.deps.upsertEpicRunState(epicId, projectDir, 'completed');
      this.activeEpics.delete(epicId);
    }

    const freshInFlight = new Set(
      this.deps
        .listStacks()
        .filter((s) => isActiveForEpic(s, subtaskIdSet))
        .map((s) => s.ticket as string),
    );
    const snapshot = this.buildSnapshot(
      epicId,
      subtaskIds,
      freshDone,
      freshInFlight,
      new Set(computeRunnableSet(subtaskIds, plan.edges, freshDone).filter(
        (id) => !freshInFlight.has(id) && !freshDone.has(id),
      )),
      articulationPoints,
      epicStatus,
    );

    this.onStatusUpdate?.(epicId, snapshot);
    return snapshot;
  }

  /**
   * For subtasks that have terminal stacks but aren't done yet,
   * re-fetch the ticket to detect external closure.
   */
  private async markNewlyClosedTasks(
    epicId: string,
    projectDir: string,
    config: ProjectTicketConfig,
    subtaskIds: string[],
    doneSet: Set<string>,
    allStacks: Stack[],
  ): Promise<void> {
    const candidates = subtaskIds.filter((id) => {
      if (doneSet.has(id)) return false;
      return allStacks.some((s) => s.ticket === id && isTerminal(s.status));
    });

    await Promise.allSettled(
      candidates.map(async (ticketId) => {
        try {
          const body = await this.deps.fetchTicketWithConfig(ticketId, config, projectDir);
          if (body && isClosed(body)) {
            this.deps.setEpicTaskDone(epicId, ticketId);
            doneSet.add(ticketId);
          }
        } catch (err) {
          console.warn(`[EpicRunner] re-fetch failed for ${ticketId}:`, err);
        }
      }),
    );
  }

  private async dispatchSubtask(
    epicId: string,
    ticketId: string,
    projectDir: string,
    config: ProjectTicketConfig,
  ): Promise<void> {
    try {
      const ticketBody = await this.deps.fetchTicketWithConfig(ticketId, config, projectDir);

      // Double-check: ticket was closed externally before we could dispatch
      if (ticketBody && isClosed(ticketBody)) {
        this.deps.setEpicTaskDone(epicId, ticketId);
        return;
      }

      const stackId = epicStackName(epicId, ticketId);
      const prompt = ticketBody ?? ticketId;

      this.deps.createStack({
        name: stackId,
        projectDir,
        ticket: ticketId,
        runtime: 'docker',
        task: prompt,
        gateApproved: true,
      });

      await this.deps.dispatchTask(stackId, prompt);
    } catch (err) {
      console.error(`[EpicRunner] dispatch failed for ${ticketId}:`, err);
    }
  }

  private buildSnapshot(
    epicId: string,
    subtaskIds: string[],
    doneSet: Set<string>,
    inFlightTickets: Set<string>,
    queuedTickets: Set<string>,
    articulationPoints: Set<string>,
    epicStatus: EpicStatus = 'running',
  ): EpicStatusSnapshot {
    return {
      epicId,
      status: epicStatus,
      subtasks: subtaskIds.map((ticketId) => ({
        ticketId,
        done: doneSet.has(ticketId),
        inFlight: inFlightTickets.has(ticketId),
        queued: queuedTickets.has(ticketId),
        isBarrier: articulationPoints.has(ticketId),
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (wired in ipc.ts)
// ---------------------------------------------------------------------------

let _singleton: EpicRunner | null = null;

export function getEpicRunner(): EpicRunner {
  if (!_singleton) throw new Error('EpicRunner not initialized — call initEpicRunner first');
  return _singleton;
}

export function initEpicRunner(deps: EpicRunnerDeps): EpicRunner {
  _singleton = new EpicRunner(deps);
  return _singleton;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function isClosed(ticketBody: string): boolean {
  return ticketBody.includes('State: CLOSED');
}

export { type RunPlan };
