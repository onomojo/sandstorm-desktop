/**
 * Usage engine for host orchestrator telemetry.
 *
 * Reads Claude Code transcript files from a set of root directories and
 * aggregates usage into summary / daily / byModel / session shapes.
 *
 * ccusage (v20.0.6) is kept as a pinned dependency for its native binary,
 * but its programmatic API is not available (it ships only a CLI binary).
 * Ingestion and aggregation are therefore implemented directly here, with
 * all ccusage-specific concerns isolated to this module and its siblings.
 *
 * Cost figures are "estimated (list price)" — not actual billed amounts.
 */

import fs from 'fs';
import { parseTranscriptRoots, findJSONLFiles, type ParseResult } from './parser';
import { aggregateSummary, aggregateDaily, aggregateByModel, aggregateSessions, aggregateByTicket, aggregateByEpic } from './aggregator';
import type { StepWeightRow, EphemeralWeightRecord, TaskPhaseWeightRow } from './aggregator';
import type { DateRange, TelemetrySummary, DailyEntry, ByModelEntry, SessionEntry, ByTicketEntry, ByEpicEntry } from './types';
import type { EpicTask } from '../control-plane/registry';

export type { StepWeightRow, EphemeralWeightRecord, TaskPhaseWeightRow };

export type { DateRange, TelemetrySummary, DailyEntry, ByModelEntry, SessionEntry, ByTicketEntry, ByEpicEntry };

export interface UsageEngine {
  getSummary(range: DateRange): TelemetrySummary;
  getDaily(range: DateRange): DailyEntry[];
  getByModel(range: DateRange): ByModelEntry[];
  getSessions(range: DateRange): SessionEntry[];
  getByTicket(range?: DateRange): ByTicketEntry[];
  getByEpic(epicTasks: EpicTask[], range?: DateRange): ByEpicEntry[];
}

// ---------------------------------------------------------------------------
// Module-scoped parse cache
//
// Shared across all engine instances so multiple IPC calls in the same page
// load hit the cache rather than re-parsing all JSONL files.
// Cache key = sorted root list + per-file (mtime, size) for each .jsonl file.
// A file addition, removal, or modification triggers a miss and full re-parse.
// ---------------------------------------------------------------------------

interface ParseCache {
  key: string;
  result: ParseResult;
}

let _parseCache: ParseCache | null = null;

export function clearUsageCache(): void {
  _parseCache = null;
}

function buildCacheKey(roots: string[]): string {
  const sortedRoots = [...roots].sort();
  const parts: string[] = [...sortedRoots];
  for (const root of sortedRoots) {
    const files = findJSONLFiles(root).sort();
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        parts.push(`${file}:missing`);
      }
    }
  }
  return parts.join('\0');
}

function loadCached(roots: string[]): ParseResult {
  const key = buildCacheKey(roots);
  if (_parseCache !== null && _parseCache.key === key) {
    return _parseCache.result;
  }
  const result = parseTranscriptRoots(roots);
  _parseCache = { key, result };
  return result;
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

/**
 * Create a usage engine that reads transcripts from the given root directories.
 * Pass `[os.homedir() + '/.claude/projects', ...stackRoots]` for host + stack telemetry.
 * Roots ending with `/.claude/projects` are the host root (stackId=null).
 * All other roots are stack roots (stackId=basename of root dir).
 *
 * stepWeights and ephemeralRecords are injected from the Electron side (SQLite + file-store)
 * so the pure aggregation logic stays electron-free. Pass undefined to omit lifecycle data.
 *
 * Returns zeroed shapes when no transcripts exist — never throws.
 */
export function createUsageEngine(
  roots: string[],
  stepWeights?: StepWeightRow[],
  ephemeralRecords?: EphemeralWeightRecord[],
  taskPhaseWeights?: TaskPhaseWeightRow[],
): UsageEngine {
  const stackRoots = roots.filter((r) => !r.endsWith('/.claude/projects'));

  return {
    getSummary(range: DateRange): TelemetrySummary {
      const { entries, skippedLines } = loadCached(roots);
      return aggregateSummary(entries, range, skippedLines);
    },

    getDaily(range: DateRange): DailyEntry[] {
      const { entries } = loadCached(roots);
      return aggregateDaily(entries, range);
    },

    getByModel(range: DateRange): ByModelEntry[] {
      const { entries } = loadCached(roots);
      return aggregateByModel(entries, range);
    },

    getSessions(range: DateRange): SessionEntry[] {
      const { entries } = loadCached(roots);
      return aggregateSessions(entries, range, stackRoots);
    },

    getByTicket(range?: DateRange): ByTicketEntry[] {
      const { entries } = loadCached(roots);
      const filtered = range
        ? entries.filter((e) => {
            const date = e.timestamp.slice(0, 10);
            return date >= range.since && date <= range.until;
          })
        : entries;
      return aggregateByTicket(filtered, stackRoots, stepWeights, ephemeralRecords, taskPhaseWeights);
    },

    getByEpic(epicTasks: EpicTask[], range?: DateRange): ByEpicEntry[] {
      const { entries } = loadCached(roots);
      const filtered = range
        ? entries.filter((e) => {
            const date = e.timestamp.slice(0, 10);
            return date >= range.since && date <= range.until;
          })
        : entries;
      const byTicket = aggregateByTicket(filtered, stackRoots, stepWeights, ephemeralRecords, taskPhaseWeights);
      return aggregateByEpic(byTicket, epicTasks);
    },
  };
}
