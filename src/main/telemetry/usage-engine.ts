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

import { parseTranscriptRoots } from './parser';
import { aggregateSummary, aggregateDaily, aggregateByModel, aggregateSessions, aggregateByTicket } from './aggregator';
import type { DateRange, TelemetrySummary, DailyEntry, ByModelEntry, SessionEntry, TranscriptByTicketEntry } from './types';

export type { DateRange, TelemetrySummary, DailyEntry, ByModelEntry, SessionEntry, TranscriptByTicketEntry };

export interface UsageEngine {
  getSummary(range: DateRange): TelemetrySummary;
  getDaily(range: DateRange): DailyEntry[];
  getByModel(range: DateRange): ByModelEntry[];
  getSessions(range: DateRange): SessionEntry[];
  getByTicket(): TranscriptByTicketEntry[];
}

/**
 * Create a usage engine that reads transcripts from the given root directories.
 * Pass `[os.homedir() + '/.claude/projects', ...stackRoots]` for host + stack telemetry.
 * Roots ending with `/.claude/projects` are the host root (stackId=null).
 * All other roots are stack roots (stackId=basename of root dir).
 *
 * Returns zeroed shapes when no transcripts exist — never throws.
 */
export function createUsageEngine(roots: string[]): UsageEngine {
  const stackRoots = roots.filter((r) => !r.endsWith('/.claude/projects'));

  function load() {
    return parseTranscriptRoots(roots);
  }

  return {
    getSummary(range: DateRange): TelemetrySummary {
      const { entries, skippedLines } = load();
      return aggregateSummary(entries, range, skippedLines);
    },

    getDaily(range: DateRange): DailyEntry[] {
      const { entries } = load();
      return aggregateDaily(entries, range);
    },

    getByModel(range: DateRange): ByModelEntry[] {
      const { entries } = load();
      return aggregateByModel(entries, range);
    },

    getSessions(range: DateRange): SessionEntry[] {
      const { entries } = load();
      return aggregateSessions(entries, range);
    },

    getByTicket(): TranscriptByTicketEntry[] {
      const { entries } = load();
      return aggregateByTicket(entries, stackRoots);
    },
  };
}

