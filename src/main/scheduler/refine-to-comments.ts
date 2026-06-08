/**
 * refine-to-comments — scheduled action that closes the loop on rough tickets.
 *
 * Per-fire flow (comment-driven model — maintainer answer 2026-05-27 round 2):
 *
 * For each open ticket labelled `ticketLabel` and authored by the current user:
 *
 *   First pass (no prior bot comment):
 *     1. Run spec check.
 *     2. If passes → add `spec-ready`, remove `ticketLabel`.
 *     3. If fails → post a question comment with the gate's questions.
 *
 *   Subsequent fires (bot comment already posted):
 *     1. Fetch comments. Filter to user comments newer than the last bot comment.
 *     2. If no new user comments → no-op (unanswered; avoid comment spam).
 *     3. If user comments exist → run spec refine with those answers as userAnswers.
 *        The refiner writes the refined description back to the ticket itself.
 *     4. If gate passes → add `spec-ready`, remove `ticketLabel`.
 *     5. If gate fails → post a new question comment with remaining questions.
 *
 * Never touches the outer-Claude chat session. The spec check/refine calls are
 * bounded ephemeral LLM subprocesses via agentBackend.runEphemeralAgent.
 *
 * Label swap order (Gap B): add `spec-ready` first, then remove `ticketLabel`.
 * If the remove fails, the ticket retains both labels and stays in the candidate
 * set on the next fire — the add is idempotent so it just succeeds again.
 */

import {
  listTickets as realListTickets,
  listTicketComments as realListComments,
  postComment as realPostComment,
  type TicketComment,
  type TicketEntry,
} from '../control-plane/ticket-comments';
import {
  addLabel as realAddLabel,
  removeLabel as realRemoveLabel,
} from '../control-plane/ticket-labels';
import type { SpecGateResult, RefineQuestion } from '../control-plane/ticket-spec';
import { listTicketsWithConfig } from '../control-plane/ticket-config';
import type { ProjectTicketConfig } from '../control-plane/registry';

/** Marker that identifies comments posted by this bot. */
export const BOT_COMMENT_MARKER = '<!-- sandstorm:bot-question -->';

/** Marker that identifies answer comments posted by the interactive dialog. */
export const ANSWER_COMMENT_MARKER = '<!-- sandstorm:user-answers -->';

/** Marker that identifies FAIL gate-report comments posted by the interactive dialog. */
export const GATE_FAIL_REPORT_MARKER = '<!-- sandstorm:gate-fail-report -->';

/**
 * Returns the body text of the most-recent GATE_FAIL_REPORT_MARKER comment,
 * or null if none exists. Mirrors the append-plus-read-latest pattern used by
 * getLatestUserAnswers for ANSWER_COMMENT_MARKER.
 */
export function getLatestGateFailReport(comments: TicketComment[]): string | null {
  const candidates = comments.filter((c) => c.body.includes(GATE_FAIL_REPORT_MARKER));
  if (candidates.length === 0) return null;
  const latest = candidates[candidates.length - 1];
  return latest.body.replace(GATE_FAIL_REPORT_MARKER, '').trim();
}

export interface RefineToCommentsDeps {
  listTickets: (label: string, projectDir: string) => Promise<TicketEntry[]>;
  listComments: (ticketId: string, projectDir: string) => Promise<TicketComment[]>;
  postComment: (ticketId: string, projectDir: string, body: string) => Promise<void>;
  addLabel: (ticketId: string, projectDir: string, label: string) => Promise<void>;
  removeLabel: (ticketId: string, projectDir: string, label: string) => Promise<void>;
  specCheck: (ticketId: string, projectDir: string) => Promise<SpecGateResult>;
  specRefine: (ticketId: string, projectDir: string, userAnswers: string) => Promise<SpecGateResult>;
}

export interface RefineToCommentsResult {
  processed: number;
  passed: number;
  failed: number;
}

export function isBotComment(comment: TicketComment): boolean {
  return comment.body.includes(BOT_COMMENT_MARKER);
}

export function getLastBotComment(comments: TicketComment[]): TicketComment | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (isBotComment(comments[i])) return comments[i];
  }
  return null;
}

export function getUserAnswersAfterBot(
  comments: TicketComment[],
  ticketAuthor: string,
  lastBotComment: TicketComment | null,
): string {
  const afterTimestamp = lastBotComment?.createdAt ?? null;
  const answers = comments.filter(
    (c) =>
      c.author === ticketAuthor &&
      !isBotComment(c) &&
      (afterTimestamp === null || c.createdAt > afterTimestamp),
  );
  return answers.map((c) => c.body).join('\n\n');
}

/**
 * Returns the combined answer text from the most-recent ANSWER_COMMENT_MARKER comment,
 * optionally filtered to comments created at or after sinceTimestamp.
 */
export function getLatestUserAnswers(
  comments: TicketComment[],
  sinceTimestamp?: string,
): string {
  const candidates = comments.filter(
    (c) =>
      c.body.includes(ANSWER_COMMENT_MARKER) &&
      (sinceTimestamp === undefined || c.createdAt >= sinceTimestamp),
  );
  if (candidates.length === 0) return '';
  const latest = candidates[candidates.length - 1];
  return latest.body.replace(ANSWER_COMMENT_MARKER, '').trim();
}

export function formatQuestionComment(questions: RefineQuestion[], gateSummary: string): string {
  const questionLines: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    questionLines.push(`${i + 1}. ${q.question}`);
    for (let j = 0; j < q.options.length; j++) {
      const letter = String.fromCharCode(65 + j); // A, B, C, ...
      questionLines.push(`   - ${letter}) ${q.options[j].label}`);
    }
  }
  const lines = [
    BOT_COMMENT_MARKER,
    '',
    '## Spec Review',
    '',
    "I've reviewed this ticket and have a few questions before it can move to `spec-ready`:",
    '',
    ...questionLines,
  ];
  if (gateSummary) {
    lines.push('', `_Sandstorm spec gate: ${gateSummary}_`);
  }
  return lines.join('\n');
}

async function processTicket(
  ticket: TicketEntry,
  projectDir: string,
  ticketLabel: string,
  deps: RefineToCommentsDeps,
): Promise<'passed' | 'failed' | 'skipped'> {
  const { id: ticketId, author: ticketAuthor } = ticket;

  const comments = await deps.listComments(ticketId, projectDir);
  const lastBotComment = getLastBotComment(comments);
  const userAnswers = getUserAnswersAfterBot(comments, ticketAuthor, lastBotComment);

  if (lastBotComment && !userAnswers) {
    // Bot already asked questions; user hasn't answered yet — no-op.
    return 'skipped';
  }

  let result: SpecGateResult;

  if (userAnswers) {
    // Fold-in: run refiner with the user's answers. The refiner writes the
    // updated description body back to the ticket itself.
    result = await deps.specRefine(ticketId, projectDir, userAnswers);
  } else {
    // First pass: no bot comment, no user answers — run the check.
    result = await deps.specCheck(ticketId, projectDir);
  }

  if (result.error) {
    throw new Error(result.error);
  }

  if (result.passed) {
    // add spec-ready first, then remove ticketLabel (Gap B swap order).
    await deps.addLabel(ticketId, projectDir, 'spec-ready');
    await deps.removeLabel(ticketId, projectDir, ticketLabel);
    return 'passed';
  }

  // Gate failed — post a question comment (or re-ask with updated questions).
  if (result.questions.length > 0) {
    const commentBody = formatQuestionComment(result.questions, result.gateSummary);
    await deps.postComment(ticketId, projectDir, commentBody);
  }
  return 'failed';
}

/**
 * Run the refine-to-comments action for all candidate tickets.
 * Per-ticket errors are caught and logged; the fire continues with the next candidate.
 */
export async function runRefineToComments(
  projectDir: string,
  ticketLabel: string,
  deps: RefineToCommentsDeps,
): Promise<RefineToCommentsResult> {
  const result: RefineToCommentsResult = { processed: 0, passed: 0, failed: 0 };

  let tickets: TicketEntry[];
  try {
    tickets = await deps.listTickets(ticketLabel, projectDir);
  } catch (err) {
    console.error('[refine-to-comments] Failed to list tickets:', err);
    return result;
  }

  for (const ticket of tickets) {
    result.processed++;
    try {
      const outcome = await processTicket(ticket, projectDir, ticketLabel, deps);
      if (outcome === 'passed') {
        result.passed++;
      } else if (outcome === 'failed') {
        result.failed++;
      }
      // 'skipped' counts as processed but neither passed nor failed
    } catch (err) {
      console.error(`[refine-to-comments] Error processing ticket ${ticket.id}:`, err);
      result.failed++;
    }
  }

  return result;
}

/**
 * Wire up the real deps for production use.
 * Accepts pre-wired specCheck/specRefine so the caller (index.ts) controls
 * how the ephemeral LLM is invoked (mirrors the ipc.ts specDeps pattern).
 * getConfig provides the ProjectTicketConfig for the project, used to route
 * listTickets through the in-app provider path (listTicketsWithConfig) instead
 * of the legacy list-tickets.sh script.
 */
export function buildRefineToCommentsDeps(
  specCheck: (ticketId: string, projectDir: string) => Promise<SpecGateResult>,
  specRefine: (ticketId: string, projectDir: string, userAnswers: string) => Promise<SpecGateResult>,
  getConfig: (projectDir: string) => ProjectTicketConfig | null,
): RefineToCommentsDeps {
  return {
    listTickets: async (label: string, projectDir: string): Promise<TicketEntry[]> => {
      const config = getConfig(projectDir);
      if (!config) {
        throw new Error(`No ticket config for project: ${projectDir}`);
      }
      const result = await listTicketsWithConfig(config, projectDir, label);
      if (!result.ok) {
        throw new Error(`listTickets failed: ${JSON.stringify(result.error)}`);
      }
      return result.tickets;
    },
    listComments: realListComments,
    postComment: realPostComment,
    addLabel: realAddLabel,
    removeLabel: realRemoveLabel,
    specCheck,
    specRefine,
  };
}
