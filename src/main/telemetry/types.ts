/** All costs are estimated at list price (not actual billed amount). */

export interface DateRange {
  since: string; // YYYY-MM-DD, inclusive
  until: string; // YYYY-MM-DD, inclusive
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
}

/**
 * Summary of host orchestrator usage over a date range.
 * Costs are estimated at list price.
 * ticketsShipped and costPerTicket are null pending attribution (#466).
 */
export interface TelemetrySummary {
  monthCost: number;        // current calendar month, estimated USD
  prevMonthCost: number;    // previous calendar month, estimated USD
  tokens: TokenCounts;      // over the requested range
  cacheHitPct: number;      // cache_read / (input + cache_read) × 100, over range
  sessions: number;         // distinct session IDs over range
  ticketsShipped: null;     // pending attribution (#466)
  costPerTicket: null;      // pending attribution (#466)
  unpricedModels: string[]; // models with no bundled price (cost returned as 0)
  skippedLines: number;     // malformed JSONL lines skipped across all files
}

export interface DailyEntry {
  date: string; // YYYY-MM-DD
  cost: number;
  tokens: Omit<TokenCounts, 'total'>;
  byModel: Record<string, number>; // model -> estimated cost for that day
}

export interface ByModelEntry {
  model: string;
  cost: number;
  tokens: TokenCounts;
  sessions: number;
  unpriced: boolean; // true when no price is known for this model
}

export interface SessionEntry {
  sid: string;
  ticket: null;  // pending attribution (#466)
  stack: null;   // pending attribution (#466)
  model: string; // model with highest output token count in session
  start: string; // ISO timestamp of first usage entry
  durMin: number; // duration in minutes (last entry - first entry)
  tokens: TokenCounts;
  cost: number;
  turns: number; // number of assistant turns (usage entries)
}
