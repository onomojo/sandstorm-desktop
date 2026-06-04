import Database from 'better-sqlite3';
import { computeCost } from './pricing';
import type { ByTicketEntry } from './types';
import { ORCHESTRATOR_TICKET_ID } from './types';

export { ORCHESTRATOR_TICKET_ID };

interface TaskCostRow {
  ticket: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  resolved_model: string | null;
}

interface HistoryRow {
  ticket: string | null;
  task_history: string;
}

interface BoardRow {
  ticket_id: string;
  column: string;
  title: string;
}

interface TicketBucket {
  title: string;
  column: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  modelOutputs: Map<string, number>;
  cost: number;
  unpriced: boolean;
}

interface HistoricalTask {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  resolved_model?: string | null;
}

function accumulate(bucket: TicketBucket, task: HistoricalTask): void {
  const input = task.input_tokens ?? 0;
  const output = task.output_tokens ?? 0;
  const cacheRead = task.cache_read_tokens ?? 0;
  const cacheCreation = task.cache_creation_tokens ?? 0;
  const model = task.resolved_model ?? null;

  bucket.input += input;
  bucket.output += output;
  bucket.cacheRead += cacheRead;
  bucket.cacheCreation += cacheCreation;

  if (model) {
    const { cost, unpriced } = computeCost(model, {
      input,
      output,
      cacheCreate: cacheCreation,
      cacheRead,
    });
    bucket.cost += cost;
    if (unpriced) bucket.unpriced = true;
    bucket.modelOutputs.set(model, (bucket.modelOutputs.get(model) ?? 0) + output);
  }
}

/**
 * Computes per-ticket cost rollups from live tasks and archived stack history.
 * Tasks on stacks with no ticket roll up under ORCHESTRATOR_TICKET_ID.
 * Aggregates globally by ticketId (tickets are expected to be unique across projects).
 */
export function computeTicketRollups(db: Database.Database): ByTicketEntry[] {
  const buckets = new Map<string, TicketBucket>();

  function getOrCreate(ticketId: string): TicketBucket {
    let bucket = buckets.get(ticketId);
    if (!bucket) {
      bucket = {
        title: ticketId === ORCHESTRATOR_TICKET_ID ? 'Orchestrator / ad-hoc' : ticketId,
        column: null,
        input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
        modelOutputs: new Map(),
        cost: 0,
        unpriced: false,
      };
      buckets.set(ticketId, bucket);
    }
    return bucket;
  }

  // 1. Live tasks joined to stacks for ticket attribution
  const liveTasks = db.prepare(`
    SELECT s.ticket,
           t.input_tokens, t.output_tokens,
           t.cache_read_tokens, t.cache_creation_tokens,
           t.resolved_model
    FROM tasks t
    JOIN stacks s ON t.stack_id = s.id
  `).all() as TaskCostRow[];

  for (const row of liveTasks) {
    accumulate(getOrCreate(row.ticket ?? ORCHESTRATOR_TICKET_ID), row);
  }

  // 2. Historical tasks from stack_history.task_history JSON blob
  const historyRows = db.prepare(`
    SELECT ticket, task_history
    FROM stack_history
    WHERE task_history IS NOT NULL
  `).all() as HistoryRow[];

  for (const record of historyRows) {
    const ticketId = record.ticket ?? ORCHESTRATOR_TICKET_ID;
    let tasks: HistoricalTask[] = [];
    try {
      tasks = JSON.parse(record.task_history) as HistoricalTask[];
    } catch {
      continue;
    }
    for (const task of tasks) {
      accumulate(getOrCreate(ticketId), task);
    }
  }

  // 3. Enrich with ticket_board metadata (title, column)
  const boardRows = db.prepare(
    'SELECT ticket_id, column, title FROM ticket_board'
  ).all() as BoardRow[];

  for (const row of boardRows) {
    const bucket = buckets.get(row.ticket_id);
    if (bucket) {
      if (row.title) bucket.title = row.title;
      bucket.column = row.column;
    }
  }

  // 4. Build ByTicketEntry[] from accumulated buckets
  const result: ByTicketEntry[] = [];
  for (const [ticketId, bucket] of buckets) {
    const denom = bucket.input + bucket.cacheRead;
    const cacheHit = denom > 0 ? (bucket.cacheRead / denom) * 100 : 0;

    let primaryModel: string | null = null;
    let maxOutput = 0;
    for (const [model, outputTokens] of bucket.modelOutputs) {
      if (outputTokens > maxOutput) {
        maxOutput = outputTokens;
        primaryModel = model;
      }
    }

    result.push({
      ticketId,
      model: primaryModel,
      cost: bucket.cost,
      tokens: {
        input: bucket.input,
        output: bucket.output,
        cacheCreate: bucket.cacheCreation,
        cacheRead: bucket.cacheRead,
        total: bucket.input + bucket.output + bucket.cacheCreation + bucket.cacheRead,
      },
      cacheHit,
      lifecycle: null,
      unpriced: bucket.unpriced,
    });
  }

  // Sort: orchestrator last, others by cost descending
  result.sort((a, b) => {
    if (a.ticketId === ORCHESTRATOR_TICKET_ID) return 1;
    if (b.ticketId === ORCHESTRATOR_TICKET_ID) return -1;
    return b.cost - a.cost;
  });

  return result;
}

/**
 * Count of distinct tickets that have been shipped.
 * Shipped = ticket_board.column = 'merged' OR (no board row and stack/stack_history
 * reached status/final_status of pr_created/pushed). Survives teardown via stack_history.
 */
export function countTicketsShipped(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT ticket) AS n FROM (
      SELECT ticket_id AS ticket FROM ticket_board WHERE column = 'merged'
      UNION
      SELECT s.ticket FROM stacks s
      WHERE s.ticket IS NOT NULL
        AND s.status IN ('pr_created', 'pushed')
        AND s.ticket NOT IN (SELECT ticket_id FROM ticket_board)
      UNION
      SELECT sh.ticket FROM stack_history sh
      WHERE sh.ticket IS NOT NULL
        AND sh.final_status IN ('pr_created', 'pushed')
        AND sh.ticket NOT IN (SELECT ticket_id FROM ticket_board)
    )
  `).get() as { n: number };
  return row.n;
}
