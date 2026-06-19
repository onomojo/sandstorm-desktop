/**
 * Control-plane tool handlers. Historically these were registered as MCP
 * tools so the outer Claude could invoke them as model-facing tools; as
 * of the Ticket D migration the orchestrator reaches them exclusively
 * through script-backed skills that hit the in-process HTTP bridge. The
 * handler dispatch (`handleToolCall`) is unchanged — only the MCP
 * advertisement layer went away.
 */

import { stackManager, agentBackend, registry } from '../index';
import { fetchTicketWithConfig, updateTicketWithConfig } from '../control-plane/ticket-config';
import type { ProjectTicketConfig } from '../control-plane/registry';
import { getDefaultSpecQualityGate } from '../spec-quality-gate';
import { resolveTicketReferences, renderResolvedReferences } from '../control-plane/ticket-references';
import {
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
} from '../scheduler';
import { syncAllProjectsCrontab } from '../scheduler/scheduler-manager';
import type {
  CreateScheduleInput,
  UpdateSchedulePatch,
} from '../scheduler/schedule-service';
import { validateProjectDir } from '../validation';
import type { EphemeralStreamEvent, EphemeralSessionHandle } from '../agent/types';

export { validateProjectDir };

const SCHEDULED_REFINE_TIMEOUT_MS = 1_800_000;

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case 'create_stack': {
      const dirError = validateProjectDir(input.projectDir);
      if (dirError) return dirError;
      return stackManager.createStack({
        name: input.name as string,
        projectDir: input.projectDir as string,
        ticket: input.ticket as string | undefined,
        branch: input.branch as string | undefined,
        description: input.description as string | undefined,
        runtime: (input.runtime as 'docker' | 'podman') ?? 'docker',
        task: input.task as string | undefined,
        model: input.model as string | undefined,
        gateApproved: input.gateApproved as boolean | undefined,
        forceBypass: input.forceBypass as boolean | undefined,
      });
    }

    case 'list_stacks':
      return stackManager.listStacksWithServices();

    case 'dispatch_task':
      return stackManager.dispatchTask(
        input.stackId as string,
        input.prompt as string,
        input.model as string | undefined,
        {
          gateApproved: input.gateApproved as boolean | undefined,
          forceBypass: input.forceBypass as boolean | undefined,
        }
      );

    case 'get_diff':
      return stackManager.getDiff(input.stackId as string);

    case 'push_stack':
      await stackManager.push(
        input.stackId as string,
        input.message as string | undefined
      );
      return { success: true };

    case 'get_task_status':
      return stackManager.getTaskStatus(input.stackId as string);

    case 'get_task_output':
      return stackManager.getTaskOutput(
        input.stackId as string,
        (input.lines as number | undefined) ?? 50
      );

    case 'teardown_stack':
      await stackManager.teardownStack(input.stackId as string);
      return { success: true };

    case 'get_logs':
      return stackManager.getLogs(
        input.stackId as string,
        input.service as string | undefined
      );

    case 'set_pr':
      stackManager.setPullRequest(
        input.stackId as string,
        input.prUrl as string,
        input.prNumber as number
      );
      return { success: true };

    case 'spec_check': {
      const dirError = validateProjectDir(input.projectDir);
      if (dirError) return dirError;
      return handleSpecCheck(
        input.ticketId as string,
        input.projectDir as string
      );
    }

    case 'spec_refine': {
      const dirError = validateProjectDir(input.projectDir);
      if (dirError) return dirError;
      return handleSpecRefine(
        input.ticketId as string,
        input.projectDir as string,
        input.userAnswers as string | undefined
      );
    }

    case 'schedule_create': {
      const dirError = validateProjectDir(input.projectDir);
      if (dirError) return dirError;
      const schedule = createSchedule({
        projectDir: input.projectDir as string,
        label: input.label as string | undefined,
        cronExpression: input.cronExpression as string,
        action: input.action as CreateScheduleInput['action'],
        enabled: input.enabled as boolean | undefined,
      });
      try {
        await syncAllProjectsCrontab(registry);
      } catch (err) {
        console.warn('[scheduler] Crontab sync failed (non-fatal):', err);
      }
      return { id: schedule.id };
    }

    case 'schedule_list': {
      const dirError = validateProjectDir(input.projectDir);
      if (dirError) return dirError;
      return { schedules: listSchedules(input.projectDir as string) };
    }

    case 'schedule_update': {
      const dirError = validateProjectDir(input.projectDir);
      if (dirError) return dirError;
      const schedule = updateSchedule(
        input.projectDir as string,
        input.id as string,
        input.patch as UpdateSchedulePatch
      );
      try {
        await syncAllProjectsCrontab(registry);
      } catch (err) {
        console.warn('[scheduler] Crontab sync failed (non-fatal):', err);
      }
      return { schedule };
    }

    case 'schedule_delete': {
      const dirError = validateProjectDir(input.projectDir);
      if (dirError) return dirError;
      deleteSchedule(input.projectDir as string, input.id as string);
      try {
        await syncAllProjectsCrontab(registry);
      } catch (err) {
        console.warn('[scheduler] Crontab sync failed (non-fatal):', err);
      }
      return { ok: true };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Resolved inputs shared by spec_check and spec_refine. */
interface SpecContext {
  ticketBody: string;
  gate: string;
}

/**
 * Short-window cache for ticket bodies. The spec gate fetches the same
 * (projectDir, ticketId) repeatedly within a single refine flow — initial
 * check, after-answers pass, manual re-runs. Caching for 30s avoids the
 * provider round-trip without holding stale data. #370.
 */
const TICKET_BODY_TTL_MS = 30_000;
const ticketBodyCache = new Map<string, { body: string; fetchedAt: number }>();

export function _clearTicketBodyCacheForTests(): void {
  ticketBodyCache.clear();
}

async function getTicketBodyCached(
  ticketId: string,
  config: ProjectTicketConfig,
  projectDir: string,
): Promise<string | null> {
  const key = `${projectDir}|${ticketId}`;
  const hit = ticketBodyCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TICKET_BODY_TTL_MS) {
    return hit.body;
  }
  const body = await fetchTicketWithConfig(ticketId, config, projectDir);
  if (body) ticketBodyCache.set(key, { body, fetchedAt: Date.now() });
  return body;
}

/** Shared pre-checks before calling the LLM. Returns an error result or the resolved context. */
async function resolveSpecContext(
  ticketId: string,
  projectDir: string,
  toolName: string,
): Promise<{ ok: false; result: Record<string, unknown> } | { ok: true; ctx: SpecContext }> {
  console.log(`[sandstorm] ${toolName}: projectDir="${projectDir}", ticketId="${ticketId}"`);

  const config = registry.getProjectTicketConfig(projectDir);
  if (!config) {
    return {
      ok: false,
      result: {
        passed: false,
        reason:
          'No ticket provider configured for this project. ' +
          'Configure GitHub or Jira in Project Settings.',
      },
    };
  }

  const ticketBody = await getTicketBodyCached(ticketId, config, projectDir);
  if (!ticketBody) {
    return {
      ok: false,
      result: {
        passed: false,
        reason: `Ticket provider returned no output for ticket "${ticketId}". Check that the ticket ID is correct and credentials are valid.`,
      },
    };
  }

  return { ok: true, ctx: { ticketBody, gate: getDefaultSpecQualityGate() } };
}

export function buildSpecCheckPrompt(gate: string, ticketBody: string, referencesSection?: string): string {
  const refBlock = referencesSection ? `\n${referencesSection}\n` : '';
  return `You are a spec quality gate evaluator. Evaluate the ticket below against every criterion in the quality gate. Be strict — if you'd have to guess, it's a FAIL.

## Quality Gate Criteria

${gate}

## Ticket

${ticketBody}
${refBlock}

## Instructions

### Phase 1: Assumption Resolution
Before evaluating pass/fail, identify every assumption in the ticket (explicit "Assumes..." statements AND implicit assumptions you would make if starting this task).

For each assumption, classify it:
- **Self-resolvable**: Can be validated by reading code, checking APIs, schemas, or running commands. For these, Use Read/Grep/Glob now and report what you found with file:line citations. State the verified fact or confirm the assumption is incorrect with evidence. Describing what you would check without checking is not sufficient.
- **Requires human input**: Business logic context, domain knowledge, behavioral expectations, product direction, edge case decisions — things the codebase can't answer. For these, formulate a specific question that must be answered before the spec is complete.

### Phase 2: Evaluation
For each criterion, determine PASS or FAIL.

**Assumptions — Zero Unresolved**: FAIL if any assumptions remain unresolved (neither verified as fact nor answered by user). Listing assumptions is NOT sufficient — they must be resolved.

**Dependency Contracts**: If the ticket references other tickets, modules, or external systems, FAIL if the data contract is not explicit (format, interface, timing). FAIL if read/write timing is incompatible (e.g., source writes at end-of-process but consumer reads mid-process).

### Phase 3: Report

Respond in EXACTLY this format (no other text before or after):

## Spec Quality Gate: [PASS or FAIL]

### Assumption Resolution
| # | Assumption | Type | Resolution |
|---|-----------|------|------------|
| 1 | <assumption text> | Self-resolvable / Requires human input | <verified fact OR specific question> |
...

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| <criterion name> | PASS/FAIL | <notes> |
...

### Questions Requiring User Answers (if any)

Every question MUST be phrased as an actionable multiple-choice question — never a statement. Provide 2 or more options when reasonable choices exist.

\`\`\`json
[
  {
    "id": "q1",
    "question": "<specific actionable question>",
    "options": [
      { "id": "a", "label": "<option A>", "recommended": true },
      { "id": "b", "label": "<option B>" }
    ]
  }
]
\`\`\`

Mark at most one option per question with \`"recommended": true\` when you have a clear recommendation. Omit the field (or omit all recommendations) when there is no obvious best choice.
`;
}

function resolveRefineModel(projectDir: string): string | undefined {
  const routing = registry.getEffectiveRoutingFor(projectDir, 'refine');
  if (routing.backend === 'opencode') {
    console.warn('[refine] backend=opencode unsupported for host path; falling back to legacy outer model');
    return registry.getLegacyEffectiveModels(projectDir).outer_model;
  }
  return routing.model;
}

async function handleSpecCheck(
  ticketId: string,
  projectDir: string
): Promise<unknown> {
  const res = await resolveSpecContext(ticketId, projectDir, 'spec_check');
  if (!res.ok) return res.result;
  const { ctx } = res;

  const references = await resolveTicketReferences(ctx.ticketBody);
  const referencesSection = renderResolvedReferences(references);
  const prompt = buildSpecCheckPrompt(ctx.gate, ctx.ticketBody, referencesSection || undefined);
  const result = await agentBackend.runEphemeralAgent(prompt, projectDir, SCHEDULED_REFINE_TIMEOUT_MS, { ticketId, stage: 'spec' }, resolveRefineModel(projectDir));
  const passed = /## Spec Quality Gate:\s*PASS/i.test(result);

  return {
    passed,
    report: result,
  };
}

export function buildSpecRefineInitialPrompt(gate: string, ticketBody: string): string {
  return `You are a spec quality gate evaluator. Evaluate the ticket below against every criterion in the quality gate. Be strict.

## Quality Gate Criteria

${gate}

## Ticket

${ticketBody}

## Instructions

### Phase 1: Assumption Resolution
Identify every assumption (explicit and implicit). For each:
- **Self-resolvable** (can check code/APIs/schemas): Use Read/Grep/Glob now and report what you found with file:line citations. Describing what you would verify without verifying is not sufficient.
- **Requires human input** (business logic, domain knowledge, product direction): Formulate a specific blocking question.

### Phase 2: Evaluation
Apply ALL criteria from the quality gate, including:
- **Zero Unresolved Assumptions**: FAIL if any assumptions remain unverified/unanswered.
- **Dependency Contracts**: FAIL if cross-ticket/module dependencies lack explicit contracts (format, timing, verification).

### Phase 3: Report
For each criterion that FAILS, ask a specific, answerable question that would resolve the gap. Don't ask vague questions — ask exactly what you need to know. Group related gaps into a single question when possible.

Respond in EXACTLY this format:

## Spec Quality Gate: [PASS or FAIL]

### Assumption Resolution
| # | Assumption | Type | Resolution |
|---|-----------|------|------------|
| 1 | <assumption text> | Self-resolvable / Requires human input | <verified fact OR specific question> |
...

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| <criterion name> | PASS/FAIL | <notes> |
...

### Questions to Resolve Gaps

Every question MUST be phrased as an actionable multiple-choice question — never a statement. Provide 2 or more options when reasonable choices exist.

\`\`\`json
[
  {
    "id": "q1",
    "question": "<specific actionable question>",
    "options": [
      { "id": "a", "label": "<option A>", "recommended": true },
      { "id": "b", "label": "<option B>" }
    ]
  }
]
\`\`\`

Mark at most one option per question with \`"recommended": true\` when you have a clear recommendation. Omit the field (or omit all recommendations) when there is no obvious best choice.
`;
}

export function buildSpecRefineAnswerPrompt(gate: string, ticketBody: string, userAnswers: string): string {
  return `You are a spec quality gate evaluator performing a refinement step.

## Quality Gate Criteria

${gate}

## Current Ticket

${ticketBody}

## User's Answers to Gap Questions

${userAnswers}

## Instructions

1. Incorporate the user's answers into the ticket body. Preserve existing content — add clarifications inline or in new sections, don't delete anything. Replace resolved assumptions with verified facts (e.g., "Verified: function X returns Y (see src/path/file.ts:42)").
2. Re-evaluate the updated ticket against ALL quality gate criteria, including:
   - **Zero Unresolved Assumptions**: Any remaining assumptions must be resolved. Listing them is not enough.
   - **Dependency Contracts**: Cross-ticket/module references need explicit contracts (format, timing, verification).
3. If it still FAILs, ask new specific questions for the remaining gaps.

Respond in EXACTLY this format:

## Updated Ticket Body

<the full updated ticket body with answers incorporated>

## Spec Quality Gate: [PASS or FAIL]

### Assumption Resolution
| # | Assumption | Type | Resolution |
|---|-----------|------|------------|
| 1 | <assumption text> | Self-resolvable / Requires human input | <verified fact OR answered> |
...

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| <criterion name> | PASS/FAIL | <notes> |
...

### Questions to Resolve Remaining Gaps (if any)

Every question MUST be phrased as an actionable multiple-choice question — never a statement. Provide 2 or more options when reasonable choices exist.

\`\`\`json
[
  {
    "id": "q1",
    "question": "<specific actionable question>",
    "options": [
      { "id": "a", "label": "<option A>", "recommended": true },
      { "id": "b", "label": "<option B>" }
    ]
  }
]
\`\`\`

Mark at most one option per question with \`"recommended": true\` when you have a clear recommendation. Omit the field (or omit all recommendations) when there is no obvious best choice.
`;
}

async function applySpecRefineResult(
  ticketId: string,
  projectDir: string,
  rawResult: string,
  hadUserAnswers: boolean,
): Promise<Record<string, unknown>> {
  const passed = /## Spec Quality Gate:\s*PASS/i.test(rawResult);
  const bodyMatch = rawResult.match(/## Updated Ticket Body\s*\n([\s\S]*?)(?=\n## Spec Quality Gate)/);
  const updatedBody = bodyMatch ? bodyMatch[1].trim() : null;

  // Commit the refined body back to the ticket system.
  if (updatedBody) {
    const config = registry.getProjectTicketConfig(projectDir);
    if (!config) {
      return {
        passed: false,
        report: rawResult,
        updatedBody,
        error:
          'Refinement evaluated successfully but no ticket provider is configured, so the updated body ' +
          'could not be written back. Configure GitHub or Jira in Project Settings.',
      };
    }
    try {
      await updateTicketWithConfig(ticketId, updatedBody, config, projectDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        report: rawResult,
        updatedBody,
        error:
          `Refinement evaluated successfully but writing the updated body back to your ticket system failed: ${msg} ` +
          `The refined body is in the report — copy it manually if needed.`,
      };
    }
  } else if (hadUserAnswers) {
    return {
      passed: false,
      report: rawResult,
      updatedBody: null,
      error:
        'Refinement did not produce an "## Updated Ticket Body" section, so nothing was written ' +
        'back to your ticket system. Re-run refinement; if it persists, the ephemeral agent may be ' +
        'drifting from the required output format.',
    };
  }

  return { passed, report: rawResult, updatedBody };
}

async function handleSpecRefine(
  ticketId: string,
  projectDir: string,
  userAnswers?: string
): Promise<unknown> {
  const res = await resolveSpecContext(ticketId, projectDir, 'spec_refine');
  if (!res.ok) return res.result;
  const { ctx } = res;

  if (!userAnswers) {
    const prompt = buildSpecRefineInitialPrompt(ctx.gate, ctx.ticketBody);
    const result = await agentBackend.runEphemeralAgent(prompt, projectDir, SCHEDULED_REFINE_TIMEOUT_MS, { ticketId, stage: 'refine' }, resolveRefineModel(projectDir));
    const passed = /## Spec Quality Gate:\s*PASS/i.test(result);
    return { passed, report: result };
  }

  const prompt = buildSpecRefineAnswerPrompt(ctx.gate, ctx.ticketBody, userAnswers);
  const result = await agentBackend.runEphemeralAgent(prompt, projectDir, SCHEDULED_REFINE_TIMEOUT_MS, { ticketId, stage: 'refine' }, resolveRefineModel(projectDir));
  return applySpecRefineResult(ticketId, projectDir, result, true);
}

/**
 * Cancellable version of spec_check for the async refinement path.
 * Returns a promise and a cancel function that sends SIGTERM to the Claude process.
 */
export function spawnSpecCheck(
  ticketId: string,
  projectDir: string,
  onChunk?: (event: EphemeralStreamEvent) => void,
): { promise: Promise<Record<string, unknown>>; cancel: () => void } {
  let innerCancel: (() => void) | null = null;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    innerCancel?.();
  };

  const promise: Promise<Record<string, unknown>> = (async (): Promise<Record<string, unknown>> => {
    const res = await resolveSpecContext(ticketId, projectDir, 'spec_check');
    if (!res.ok) return res.result;
    if (cancelled) throw new Error('Cancelled');

    const references = await resolveTicketReferences(res.ctx.ticketBody);
    const referencesSection = renderResolvedReferences(references);
    const prompt = buildSpecCheckPrompt(res.ctx.gate, res.ctx.ticketBody, referencesSection || undefined);
    const { promise: ep, cancel: epCancel } = agentBackend.spawnEphemeralAgent(prompt, projectDir, 0, onChunk, { ticketId, stage: 'spec' }, resolveRefineModel(projectDir));
    innerCancel = epCancel;
    if (cancelled) { epCancel(); throw new Error('Cancelled'); }

    const result = await ep;
    const passed = /## Spec Quality Gate:\s*PASS/i.test(result);
    return { passed, report: result };
  })();

  return { promise, cancel };
}

/**
 * Pool of held EphemeralSessionHandles for in-flight refine flows (#370 item 5).
 * Keyed by `<projectDir>|<ticketId>`. The initial-questions pass spawns one and
 * stashes it here; the after-answers pass picks it up so the second turn reuses
 * the model's exploration context from the first. Idle sessions are disposed
 * after 10 minutes to prevent leaked processes if the user walks away.
 */
const REFINE_SESSION_IDLE_TTL_MS = 600_000;
interface PooledRefineSession {
  handle: EphemeralSessionHandle;
  idleTimer: NodeJS.Timeout;
}
const refineSessionPool = new Map<string, PooledRefineSession>();

function refineSessionKey(projectDir: string, ticketId: string): string {
  return `${projectDir}|${ticketId}`;
}

function disposeRefineSession(key: string): void {
  const pooled = refineSessionPool.get(key);
  if (!pooled) return;
  clearTimeout(pooled.idleTimer);
  try { pooled.handle.dispose(); } catch { /* noop */ }
  refineSessionPool.delete(key);
}

function storeRefineSession(key: string, handle: EphemeralSessionHandle): void {
  // Replace any pre-existing session for the same key.
  disposeRefineSession(key);
  const idleTimer = setTimeout(() => disposeRefineSession(key), REFINE_SESSION_IDLE_TTL_MS);
  refineSessionPool.set(key, { handle, idleTimer });
}

export function _disposeAllRefineSessionsForTests(): void {
  for (const key of [...refineSessionPool.keys()]) disposeRefineSession(key);
}

/**
 * Cancellable version of spec_refine for the async refinement path. Reuses
 * one Claude subprocess across the initial-questions and after-answers
 * passes when both happen within the same refine flow (#370 item 5).
 */
export function spawnSpecRefine(
  ticketId: string,
  projectDir: string,
  userAnswers?: string,
  onChunk?: (event: EphemeralStreamEvent) => void,
): { promise: Promise<Record<string, unknown>>; cancel: () => void } {
  let cancelled = false;
  let activeDispose: (() => void) | null = null;
  const cancel = (): void => {
    cancelled = true;
    activeDispose?.();
  };

  const promise: Promise<Record<string, unknown>> = (async (): Promise<Record<string, unknown>> => {
    const res = await resolveSpecContext(ticketId, projectDir, 'spec_refine');
    if (!res.ok) return res.result;
    if (cancelled) throw new Error('Cancelled');

    const key = refineSessionKey(projectDir, ticketId);

    if (userAnswers) {
      // After-answers pass. Reuse the held session if we have one; otherwise
      // cold-start with the full answer prompt.
      const pooled = refineSessionPool.get(key);
      const answerPrompt = buildSpecRefineAnswerPrompt(res.ctx.gate, res.ctx.ticketBody, userAnswers);

      if (pooled) {
        clearTimeout(pooled.idleTimer);
        activeDispose = () => disposeRefineSession(key);
        if (cancelled) { disposeRefineSession(key); throw new Error('Cancelled'); }
        try {
          const result = await pooled.handle.sendFollowUp(answerPrompt);
          return applySpecRefineResult(ticketId, projectDir, result, true);
        } finally {
          disposeRefineSession(key);
        }
      }

      // No pooled session (timed out, app restarted, etc.) — fall back to a
      // cold ephemeral so the user's answers still produce a result.
      const { promise: ep, cancel: epCancel } = agentBackend.spawnEphemeralAgent(
        answerPrompt, projectDir, 0, onChunk, { ticketId, stage: 'refine' }, resolveRefineModel(projectDir),
      );
      activeDispose = epCancel;
      if (cancelled) { epCancel(); throw new Error('Cancelled'); }
      const result = await ep;
      return applySpecRefineResult(ticketId, projectDir, result, true);
    }

    // Initial-questions pass. Spawn a long-lived session so the after-answers
    // pass can reuse it.
    const initialPrompt = buildSpecRefineInitialPrompt(res.ctx.gate, res.ctx.ticketBody);
    const handle = agentBackend.spawnEphemeralSession(initialPrompt, projectDir, 0, onChunk);
    // Cancel during the initial pass must dispose the live handle even though
    // it isn't pooled yet — otherwise SIGTERM never reaches the held subprocess.
    activeDispose = (): void => {
      try { handle.dispose(); } catch { /* noop */ }
      disposeRefineSession(key);
    };
    if (cancelled) { handle.dispose(); throw new Error('Cancelled'); }

    let result: string;
    try {
      result = await handle.initialResult;
    } catch (err) {
      // Initial pass failed — make sure nothing is held.
      try { handle.dispose(); } catch { /* noop */ }
      throw err;
    }

    if (cancelled) { handle.dispose(); throw new Error('Cancelled'); }

    // Pool the session so the after-answers pass can reuse it. If the gate
    // already passed without questions, dispose immediately — no follow-up.
    const passed = /## Spec Quality Gate:\s*PASS/i.test(result);
    if (passed) {
      try { handle.dispose(); } catch { /* noop */ }
    } else {
      storeRefineSession(key, handle);
    }
    return { passed, report: result };
  })();

  return { promise, cancel };
}
