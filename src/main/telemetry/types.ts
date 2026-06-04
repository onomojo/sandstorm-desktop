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
 */
export interface TelemetrySummary {
  monthCost: number;              // current calendar month, estimated USD
  prevMonthCost: number;          // previous calendar month, estimated USD
  tokens: TokenCounts;            // over the requested range
  cacheHitPct: number;            // cache_read / (input + cache_read) × 100, over range
  sessions: number;               // distinct session IDs over range
  ticketsShipped: number | null;  // tickets in 'merged' column or pr_created/pushed; null when not yet computed
  costPerTicket: number | null;   // total ticket cost ÷ ticketsShipped; null when no tickets shipped
  unpricedModels: string[];       // models with no bundled price (cost returned as 0)
  skippedLines: number;           // malformed JSONL lines skipped across all files
}

/** Per-ticket cost and token attribution derived from tasks/stacks token columns. */
export interface ByTicketEntry {
  ticketId: string;       // ticket ID, or '__orchestrator__' for tasks with no ticket
  title: string;          // ticket title from ticket_board, or ticketId as fallback
  column: string | null;  // current kanban column; null for orchestrator bucket
  model: string | null;   // primary model (highest output tokens across all tasks)
  cost: number;           // estimated USD cost across all tasks for this ticket
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  cacheHit: number;       // cache_read / (input + cache_read) × 100; 0 when all-zero
  lifecycle: null;        // pending sub-issue 4
  unpriced: boolean;      // true when any task used a model with no known price
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
