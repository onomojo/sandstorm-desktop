/**
 * Electron-free aggregation logic for telemetry data.
 * Accepts parsed RawUsageEntry arrays and produces the shapes consumed by IPC handlers.
 */

import fs from 'fs';
import path from 'path';
import { computeCost } from './pricing';
import type { RawUsageEntry } from './parser';
import type { DateRange, TokenCounts, TelemetrySummary, DailyEntry, ByModelEntry, SessionEntry, ByTicketEntry } from './types';
import { ORCHESTRATOR_TICKET_ID } from './types';
import { computeLifecycleSplit } from './lifecycle-split';
import type { LifecycleWeights } from './lifecycle-split';

/** Per-ticket step weights read from task_token_steps (injected, electron-free). */
export interface StepWeightRow {
  ticket: string;
  phase: string;  // 'execution' | 'review' are the only values written
  totalTokens: number;
}

/** Per-run ephemeral weight record (from ephemeral-timing store, injected). */
export interface EphemeralWeightRecord {
  ticketId: string;
  stage: string;  // 'refine' | 'spec' | 'pr'
  turnCount: number;
}

function dateOf(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10); // YYYY-MM-DD
}

function inRange(isoTimestamp: string, range: DateRange): boolean {
  const date = dateOf(isoTimestamp);
  return date >= range.since && date <= range.until;
}

function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 };
}

function addTokens(acc: TokenCounts, entry: RawUsageEntry): void {
  acc.input += entry.input;
  acc.output += entry.output;
  acc.cacheCreate += entry.cacheCreate;
  acc.cacheRead += entry.cacheRead;
  acc.total += entry.input + entry.output + entry.cacheCreate + entry.cacheRead;
}

/** Compute summary stats over the given range plus calendar-month costs. */
export function aggregateSummary(
  entries: RawUsageEntry[],
  range: DateRange,
  skippedLines: number
): TelemetrySummary {
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const prevMonthDate = new Date(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const prevMonth = `${prevMonthDate.getUTCFullYear()}-${String(prevMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;

  const rangeTokens = zeroTokens();
  let rangeSessions = new Set<string>();
  let monthCost = 0;
  let prevMonthCost = 0;
  const unpricedModels = new Set<string>();

  for (const entry of entries) {
    const { cost, unpriced } = computeCost(entry.model, {
      input: entry.input,
      output: entry.output,
      cacheCreate: entry.cacheCreate,
      cacheRead: entry.cacheRead,
    });

    if (unpriced) unpricedModels.add(entry.model);

    const entryMonth = dateOf(entry.timestamp).slice(0, 7); // YYYY-MM
    if (entryMonth === currentMonth) monthCost += cost;
    if (entryMonth === prevMonth) prevMonthCost += cost;

    if (inRange(entry.timestamp, range)) {
      addTokens(rangeTokens, entry);
      rangeSessions.add(entry.sessionId);
    }
  }

  const cacheHitPct =
    rangeTokens.input + rangeTokens.cacheRead > 0
      ? (rangeTokens.cacheRead / (rangeTokens.input + rangeTokens.cacheRead)) * 100
      : 0;

  return {
    monthCost,
    prevMonthCost,
    tokens: rangeTokens,
    cacheHitPct,
    sessions: rangeSessions.size,
    ticketsShipped: null,
    costPerTicket: null,
    unpricedModels: [...unpricedModels].sort(),
    skippedLines,
  };
}

/** Compute daily breakdown over the given range. */
export function aggregateDaily(entries: RawUsageEntry[], range: DateRange): DailyEntry[] {
  const byDate = new Map<string, { cost: number; tokens: Omit<TokenCounts, 'total'>; byModel: Map<string, number> }>();

  for (const entry of entries) {
    if (!inRange(entry.timestamp, range)) continue;

    const date = dateOf(entry.timestamp);
    if (!byDate.has(date)) {
      byDate.set(date, { cost: 0, tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, byModel: new Map() });
    }
    const day = byDate.get(date)!;
    const { cost } = computeCost(entry.model, {
      input: entry.input,
      output: entry.output,
      cacheCreate: entry.cacheCreate,
      cacheRead: entry.cacheRead,
    });
    day.cost += cost;
    day.tokens.input += entry.input;
    day.tokens.output += entry.output;
    day.tokens.cacheCreate += entry.cacheCreate;
    day.tokens.cacheRead += entry.cacheRead;
    day.byModel.set(entry.model, (day.byModel.get(entry.model) ?? 0) + cost);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({
      date,
      cost: data.cost,
      tokens: data.tokens,
      byModel: Object.fromEntries(data.byModel),
    }));
}

/** Compute per-model breakdown over the given range. */
export function aggregateByModel(entries: RawUsageEntry[], range: DateRange): ByModelEntry[] {
  const byModel = new Map<string, { tokens: TokenCounts; sessions: Set<string>; unpriced: boolean }>();

  for (const entry of entries) {
    if (!inRange(entry.timestamp, range)) continue;

    if (!byModel.has(entry.model)) {
      byModel.set(entry.model, { tokens: zeroTokens(), sessions: new Set(), unpriced: false });
    }
    const m = byModel.get(entry.model)!;
    addTokens(m.tokens, entry);
    m.sessions.add(entry.sessionId);
    const { unpriced } = computeCost(entry.model, {
      input: entry.input,
      output: entry.output,
      cacheCreate: entry.cacheCreate,
      cacheRead: entry.cacheRead,
    });
    if (unpriced) m.unpriced = true;
  }

  return [...byModel.entries()]
    .map(([model, data]) => {
      const { cost } = computeCost(model, {
        input: data.tokens.input,
        output: data.tokens.output,
        cacheCreate: data.tokens.cacheCreate,
        cacheRead: data.tokens.cacheRead,
      });
      return {
        model,
        cost,
        tokens: data.tokens,
        sessions: data.sessions.size,
        unpriced: data.unpriced,
      };
    })
    .sort((a, b) => b.cost - a.cost);
}

/** Compute per-session breakdown over the given range. */
export function aggregateSessions(entries: RawUsageEntry[], range: DateRange): SessionEntry[] {
  const bySid = new Map<string, {
    tokens: TokenCounts;
    modelTokens: Map<string, number>;
    timestamps: string[];
    turns: number;
    cost: number;
  }>();

  for (const entry of entries) {
    if (!inRange(entry.timestamp, range)) continue;

    if (!bySid.has(entry.sessionId)) {
      bySid.set(entry.sessionId, { tokens: zeroTokens(), modelTokens: new Map(), timestamps: [], turns: 0, cost: 0 });
    }
    const s = bySid.get(entry.sessionId)!;
    addTokens(s.tokens, entry);
    s.modelTokens.set(entry.model, (s.modelTokens.get(entry.model) ?? 0) + entry.output);
    s.timestamps.push(entry.timestamp);
    s.turns++;
    const { cost } = computeCost(entry.model, {
      input: entry.input,
      output: entry.output,
      cacheCreate: entry.cacheCreate,
      cacheRead: entry.cacheRead,
    });
    s.cost += cost;
  }

  return [...bySid.entries()]
    .map(([sid, data]) => {
      // Primary model = the one with the most output tokens in this session
      let primaryModel = '';
      let maxOutput = -1;
      for (const [model, output] of data.modelTokens) {
        if (output > maxOutput) { maxOutput = output; primaryModel = model; }
      }

      data.timestamps.sort();
      const start = data.timestamps[0] ?? '';
      const end = data.timestamps[data.timestamps.length - 1] ?? start;
      const durMs = start && end ? new Date(end).getTime() - new Date(start).getTime() : 0;

      return {
        sid,
        ticket: null,
        stack: null,
        model: primaryModel,
        start,
        durMin: durMs / 60_000,
        tokens: data.tokens,
        cost: data.cost,
        turns: data.turns,
      } satisfies SessionEntry;
    })
    .sort((a, b) => b.start.localeCompare(a.start));
}

interface StackManifest {
  stackId: string;
  ticket: string | null;
  project: string;
  createdAt: string;
}

function readManifest(manifestPath: string): StackManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.stackId !== 'string') return null;
    return parsed as StackManifest;
  } catch {
    return null;
  }
}

/**
 * Aggregate entries by ticket, reading stack manifests to resolve stackId → ticket.
 * stackRoots are the stack-specific dirs (e.g. <project>/.sandstorm/usage/<stackId>).
 * The paired manifest is at stackRoot + '.manifest.json'.
 * Entries with no mapped ticket (host-root entries or missing manifest) roll up under
 * ORCHESTRATOR_TICKET_ID. A ticket worked across multiple stacks produces one row.
 *
 * stepWeights and ephemeralRecords are injected (read on the Electron side) so this
 * function stays electron-free and unit-testable with plain arrays.
 */
export function aggregateByTicket(
  entries: RawUsageEntry[],
  stackRoots: string[],
  stepWeights: StepWeightRow[] = [],
  ephemeralRecords: EphemeralWeightRecord[] = [],
): ByTicketEntry[] {
  // Build stackId → ticket map from manifests
  const stackToTicket = new Map<string, string | null>();
  for (const root of stackRoots) {
    const manifest = readManifest(root + '.manifest.json');
    if (manifest) {
      stackToTicket.set(manifest.stackId, manifest.ticket ?? null);
    }
  }

  // Group entries by ticket alone (multi-stack tickets aggregate into one row)
  const byTicket = new Map<string, {
    tokens: TokenCounts;
    modelOutputs: Map<string, number>;
    cost: number;
    unpriced: boolean;
  }>();

  for (const entry of entries) {
    const rawTicket = entry.stackId != null ? (stackToTicket.get(entry.stackId) ?? null) : null;
    const ticketId = rawTicket ?? ORCHESTRATOR_TICKET_ID;

    if (!byTicket.has(ticketId)) {
      byTicket.set(ticketId, { tokens: zeroTokens(), modelOutputs: new Map(), cost: 0, unpriced: false });
    }
    const bucket = byTicket.get(ticketId)!;
    addTokens(bucket.tokens, entry);
    bucket.modelOutputs.set(entry.model, (bucket.modelOutputs.get(entry.model) ?? 0) + entry.output);
    const { cost, unpriced } = computeCost(entry.model, {
      input: entry.input,
      output: entry.output,
      cacheCreate: entry.cacheCreate,
      cacheRead: entry.cacheRead,
    });
    bucket.cost += cost;
    if (unpriced) bucket.unpriced = true;
  }

  // Build per-ticket lifecycle weights from injected step + ephemeral data
  const ticketWeights = new Map<string, LifecycleWeights>();

  const getWeights = (ticketId: string): LifecycleWeights => {
    let w = ticketWeights.get(ticketId);
    if (!w) { w = {}; ticketWeights.set(ticketId, w); }
    return w;
  };

  for (const row of stepWeights) {
    if (row.phase !== 'execution' && row.phase !== 'review') continue;
    const w = getWeights(row.ticket);
    const stage = row.phase as 'execution' | 'review';
    w[stage] = (w[stage] ?? 0) + row.totalTokens;
  }

  for (const rec of ephemeralRecords) {
    if (!rec.ticketId || !rec.stage) continue;
    if (rec.stage !== 'refine' && rec.stage !== 'spec' && rec.stage !== 'pr') continue;
    const w = getWeights(rec.ticketId);
    const stage = rec.stage as 'refine' | 'spec' | 'pr';
    w[stage] = (w[stage] ?? 0) + rec.turnCount;
  }

  return [...byTicket.entries()].map(([ticketId, data]) => {
    const { input, cacheRead } = data.tokens;
    const denom = input + cacheRead;
    const cacheHit = denom > 0 ? (cacheRead / denom) * 100 : 0;

    // Primary model = highest summed output tokens (first encountered on ties)
    let primaryModel: string | null = null;
    let maxOutput = -1;
    for (const [model, output] of data.modelOutputs) {
      if (output > maxOutput) { maxOutput = output; primaryModel = model; }
    }

    const lifecycle = computeLifecycleSplit(data.cost, ticketWeights.get(ticketId) ?? {});

    return {
      ticketId,
      model: primaryModel,
      cost: data.cost,
      tokens: data.tokens,
      cacheHit,
      lifecycle,
      unpriced: data.unpriced,
    } satisfies ByTicketEntry;
  });
}

