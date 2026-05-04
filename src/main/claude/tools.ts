/**
 * Control-plane tool handlers. Historically these were registered as MCP
 * tools so the outer Claude could invoke them as model-facing tools; as
 * of the Ticket D migration the orchestrator reaches them exclusively
 * through script-backed skills that hit the in-process HTTP bridge. The
 * handler dispatch (`handleToolCall`) is unchanged — only the MCP
 * advertisement layer went away.
 */

import path from 'path';
import { stackManager, agentBackend, registry } from '../index';
import { fetchTicketContext, getScriptStatus } from '../control-plane/ticket-fetcher';
import { getSpecQualityGate } from '../spec-quality-gate';
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
import { updateTicketBody } from '../control-plane/ticket-updater';

export { validateProjectDir };



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

/** Shared pre-checks before calling the LLM. Returns an error result or the resolved context. */
async function resolveSpecContext(
  ticketId: string,
  projectDir: string,
  toolName: string,
): Promise<{ ok: false; result: Record<string, unknown> } | { ok: true; ctx: SpecContext }> {
  const scriptPath = path.join(projectDir, '.sandstorm', 'scripts', 'fetch-ticket.sh');
  console.log(`[sandstorm] ${toolName}: projectDir="${projectDir}", scriptPath="${scriptPath}"`);

  const scriptStatus = getScriptStatus(projectDir);
  if (scriptStatus === 'missing') {
    return {
      ok: false,
      result: {
        passed: false,
        reason:
          `fetch-ticket.sh not found at ${scriptPath}. ` +
          "Run 'sandstorm init' to auto-generate it for your ticket system (Jira or GitHub Issues), " +
          "or create it manually: the script receives a ticket ID as $1 and must output the ticket body to stdout.",
      },
    };
  }
  if (scriptStatus === 'not_executable') {
    return {
      ok: false,
      result: {
        passed: false,
        reason: `fetch-ticket.sh exists but is not executable. Fix with: chmod +x ${scriptPath}`,
      },
    };
  }

  const ticketBody = await fetchTicketContext(ticketId, projectDir);
  if (!ticketBody) {
    return {
      ok: false,
      result: {
        passed: false,
        reason: `fetch-ticket.sh ran but returned no output for ticket "${ticketId}". Check the script's implementation and that the ticket ID is correct.`,
      },
    };
  }

  const gatePath = path.join(projectDir, '.sandstorm', 'spec-quality-gate.md');
  const gate = getSpecQualityGate(projectDir);
  if (!gate) {
    return {
      ok: false,
      result: { error: `No quality gate configured at ${gatePath}. Run sandstorm init or create .sandstorm/spec-quality-gate.md.` },
    };
  }

  return { ok: true, ctx: { ticketBody, gate } };
}

function buildSpecCheckPrompt(gate: string, ticketBody: string): string {
  return `You are a spec quality gate evaluator. Evaluate the ticket below against every criterion in the quality gate. Be strict — if you'd have to guess, it's a FAIL.

## Quality Gate Criteria

${gate}

## Ticket

${ticketBody}

## Instructions

### Phase 1: Assumption Resolution
Before evaluating pass/fail, identify every assumption in the ticket (explicit "Assumes..." statements AND implicit assumptions you would make if starting this task).

For each assumption, classify it:
- **Self-resolvable**: Can be validated by reading code, checking APIs, schemas, or running commands. For these, state what you would check and whether the assumption appears correct or incorrect based on the information available.
- **Requires human input**: Business logic context, domain knowledge, behavioral expectations, product direction, edge case decisions — things the codebase can't answer. For these, formulate a specific question that must be answered before the spec is complete.

### Phase 2: Enhanced Evaluation
For each criterion, determine PASS or FAIL. Apply these additional checks:

**Assumptions — Zero Unresolved**: FAIL if any assumptions remain unresolved (neither verified as fact nor answered by user). Listing assumptions is NOT sufficient — they must be resolved.

**End-to-End Data Flow Verification**: If the feature spans multiple system boundaries, FAIL if testability consists entirely of mocked/unit tests with no end-to-end verification item. Identify every integration boundary the data crosses.

**Dependency Contracts**: If the ticket references other tickets, modules, or external systems, FAIL if the data contract is not explicit (format, interface, timing). FAIL if read/write timing is incompatible (e.g., source writes at end-of-process but consumer reads mid-process).

**Automated Visual Verification**: If the ticket describes UI/visual changes, FAIL if there is no automated visual verification step against the real running application. Mocked component renders don't count.

**All Verification Automatable**: FAIL if ANY verification item requires manual human intervention ("manually verify", "visually confirm", "deploy and check") or includes optional checkboxes that can be skipped.

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

### Gaps (if any)
- [ ] Specific gap 1 — what needs to be clarified and how to fix it
...

### Questions Requiring User Answers (if any)
1. <specific question from unresolvable assumptions or ambiguities>
...`;
}

async function handleSpecCheck(
  ticketId: string,
  projectDir: string
): Promise<unknown> {
  const res = await resolveSpecContext(ticketId, projectDir, 'spec_check');
  if (!res.ok) return res.result;
  const { ctx } = res;

  const prompt = buildSpecCheckPrompt(ctx.gate, ctx.ticketBody);
  const result = await agentBackend.runEphemeralAgent(prompt, projectDir);
  const passed = /## Spec Quality Gate:\s*PASS/i.test(result);

  return {
    passed,
    report: result,
  };
}

function buildSpecRefineInitialPrompt(gate: string, ticketBody: string): string {
  return `You are a spec quality gate evaluator. Evaluate the ticket below against every criterion in the quality gate. Be strict.

## Quality Gate Criteria

${gate}

## Ticket

${ticketBody}

## Instructions

### Phase 1: Assumption Resolution
Identify every assumption (explicit and implicit). For each:
- **Self-resolvable** (can check code/APIs/schemas): State what you'd verify and whether it appears correct or incorrect.
- **Requires human input** (business logic, domain knowledge, product direction): Formulate a specific blocking question.

### Phase 2: Enhanced Evaluation
Apply ALL criteria from the quality gate, including:
- **Zero Unresolved Assumptions**: FAIL if any assumptions remain unverified/unanswered.
- **End-to-End Data Flow**: FAIL if multi-boundary features have only mocked tests.
- **Dependency Contracts**: FAIL if cross-ticket/module dependencies lack explicit contracts (format, timing, verification).
- **Automated Visual Verification**: FAIL if UI tickets lack automated visual verification against the real app.
- **All Verification Automatable**: FAIL if any verification requires manual human steps.

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
1. <specific question>
2. <specific question>
...`;
}

function buildSpecRefineAnswerPrompt(gate: string, ticketBody: string, userAnswers: string): string {
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
   - **End-to-End Data Flow**: Multi-boundary features need e2e verification, not just mocked tests.
   - **Dependency Contracts**: Cross-ticket/module references need explicit contracts (format, timing, verification).
   - **Automated Visual Verification**: UI tickets need automated visual checks against the real app.
   - **All Verification Automatable**: No manual steps allowed.
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
1. <specific question>
...`;
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

  // Commit the refined body back to GitHub (#318).
  if (updatedBody) {
    try {
      await updateTicketBody(ticketId, projectDir, updatedBody);
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
    const result = await agentBackend.runEphemeralAgent(prompt, projectDir);
    const passed = /## Spec Quality Gate:\s*PASS/i.test(result);
    return { passed, report: result };
  }

  const prompt = buildSpecRefineAnswerPrompt(ctx.gate, ctx.ticketBody, userAnswers);
  const result = await agentBackend.runEphemeralAgent(prompt, projectDir);
  return applySpecRefineResult(ticketId, projectDir, result, true);
}

/**
 * Cancellable version of spec_check for the async refinement path.
 * Returns a promise and a cancel function that sends SIGTERM to the Claude process.
 */
export function spawnSpecCheck(
  ticketId: string,
  projectDir: string,
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

    const prompt = buildSpecCheckPrompt(res.ctx.gate, res.ctx.ticketBody);
    const { promise: ep, cancel: epCancel } = agentBackend.spawnEphemeralAgent(prompt, projectDir);
    innerCancel = epCancel;
    if (cancelled) { epCancel(); throw new Error('Cancelled'); }

    const result = await ep;
    const passed = /## Spec Quality Gate:\s*PASS/i.test(result);
    return { passed, report: result };
  })();

  return { promise, cancel };
}

/**
 * Cancellable version of spec_refine for the async refinement path.
 */
export function spawnSpecRefine(
  ticketId: string,
  projectDir: string,
  userAnswers?: string,
): { promise: Promise<Record<string, unknown>>; cancel: () => void } {
  let innerCancel: (() => void) | null = null;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    innerCancel?.();
  };

  const promise: Promise<Record<string, unknown>> = (async (): Promise<Record<string, unknown>> => {
    const res = await resolveSpecContext(ticketId, projectDir, 'spec_refine');
    if (!res.ok) return res.result;
    if (cancelled) throw new Error('Cancelled');

    const prompt = userAnswers
      ? buildSpecRefineAnswerPrompt(res.ctx.gate, res.ctx.ticketBody, userAnswers)
      : buildSpecRefineInitialPrompt(res.ctx.gate, res.ctx.ticketBody);

    const { promise: ep, cancel: epCancel } = agentBackend.spawnEphemeralAgent(prompt, projectDir);
    innerCancel = epCancel;
    if (cancelled) { epCancel(); throw new Error('Cancelled'); }

    const result = await ep;
    if (userAnswers) {
      return applySpecRefineResult(ticketId, projectDir, result, true);
    }
    const passed = /## Spec Quality Gate:\s*PASS/i.test(result);
    return { passed, report: result };
  })();

  return { promise, cancel };
}
