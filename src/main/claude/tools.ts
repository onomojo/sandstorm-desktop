/**
 * MCP tool definitions that Claude can use to interact with the control plane.
 * These are exposed to the Claude chat window so the AI can create stacks,
 * dispatch tasks, and manage the lifecycle programmatically.
 */

import { stackManager, agentBackend } from '../index';
import { fetchTicketContext, getScriptStatus } from '../control-plane/ticket-fetcher';
import { getSpecQualityGate } from '../spec-quality-gate';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const tools: ToolDefinition[] = [
  {
    name: 'create_stack',
    description:
      'Create a new Sandstorm stack with a name, project directory, and optional task. When a ticket is specified or the task references a GitHub issue, gateApproved must be true (run /spec-check first) or forceBypass must be true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stack name (e.g., "auth-refactor")' },
        projectDir: { type: 'string', description: 'Absolute path to the project directory' },
        ticket: { type: 'string', description: 'Ticket ID (e.g., "EXP-342")' },
        branch: { type: 'string', description: 'Git branch name' },
        description: { type: 'string', description: 'Short description of the work' },
        runtime: { type: 'string', enum: ['docker', 'podman'], description: 'Container runtime' },
        task: { type: 'string', description: 'Task to dispatch immediately after creation' },
        gateApproved: { type: 'boolean', description: 'Set to true after running /spec-check and getting user approval. Required when a ticket is specified or the task references a GitHub issue.' },
        forceBypass: { type: 'boolean', description: 'Set to true to bypass the spec quality gate. Only use when the user explicitly requests skipping the gate.' },
        model: {
          type: 'string',
          enum: ['auto', 'sonnet', 'opus'],
          description: 'Claude model for inner agent. If omitted, uses the project\'s configured default model (set in Model Settings). When explicitly set to "auto", YOU must analyze the task complexity and choose the best model via lightweight triage:\n\n**Choose "sonnet" (fast & efficient) when:**\n- Typo fixes, config changes, simple bug fixes\n- Well-defined tasks with clear scope (1-3 files)\n- Routine refactors following existing patterns\n- Straightforward feature additions with no design decisions\n\n**Choose "opus" (most capable) when:**\n- Architectural changes or multi-file features requiring design decisions\n- Tricky bugs that need deep reasoning or cross-cutting analysis\n- Security-sensitive or performance-critical work\n- Tasks involving new patterns not yet established in the codebase\n- Open-ended features where the approach is ambiguous\n\nWhen you choose a model via triage, communicate your reasoning briefly (e.g., "Using Sonnet — straightforward config change" or "Using Opus — multi-file architectural refactor").',
        },
      },
      required: ['name', 'projectDir'],
    },
  },
  {
    name: 'list_stacks',
    description: 'List all current stacks with their status and services',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'dispatch_task',
    description: 'Dispatch a task to an existing stack. When the stack has a ticket or the prompt references a GitHub issue, gateApproved must be true (run /spec-check first) or forceBypass must be true.',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string', description: 'Stack ID to dispatch to' },
        prompt: { type: 'string', description: 'Task description for inner Claude' },
        gateApproved: { type: 'boolean', description: 'Set to true after running /spec-check and getting user approval. Required when a ticket is specified or the prompt references a GitHub issue.' },
        forceBypass: { type: 'boolean', description: 'Set to true to bypass the spec quality gate. Only use when the user explicitly requests skipping the gate.' },
        model: {
          type: 'string',
          enum: ['auto', 'sonnet', 'opus'],
          description: 'Claude model for this task. If omitted, uses the project\'s configured default model (set in Model Settings). When explicitly set to "auto", YOU must analyze the task complexity and choose the best model via lightweight triage:\n\n**Choose "sonnet"** for: typo fixes, config changes, simple bugs, well-defined tasks (1-3 files), routine refactors, straightforward additions.\n**Choose "opus"** for: architectural changes, multi-file features with design decisions, tricky bugs, security/performance-critical work, new patterns, ambiguous scope.\n\nCommunicate your reasoning briefly when auto-selecting.',
        },
      },
      required: ['stackId', 'prompt'],
    },
  },
  {
    name: 'get_diff',
    description: 'Get the git diff from a stack',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string', description: 'Stack ID' },
      },
      required: ['stackId'],
    },
  },
  {
    name: 'push_stack',
    description: 'Commit and push changes from a stack',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string', description: 'Stack ID' },
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['stackId'],
    },
  },
  {
    name: 'get_task_status',
    description:
      'Get the current task status for a stack (running, completed, failed, idle)',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string', description: 'Stack ID' },
      },
      required: ['stackId'],
    },
  },
  {
    name: 'get_task_output',
    description:
      'Get the latest output from the running or most recent task in a stack',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string', description: 'Stack ID' },
        lines: {
          type: 'number',
          description: 'Number of lines to return (default: 50)',
        },
      },
      required: ['stackId'],
    },
  },
  {
    name: 'teardown_stack',
    description:
      'Tear down a stack — stops containers, removes workspace, archives to history',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string', description: 'Stack ID to tear down' },
      },
      required: ['stackId'],
    },
  },
  {
    name: 'get_logs',
    description:
      'Get container logs from a stack, optionally filtered to a specific service',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string', description: 'Stack ID' },
        service: {
          type: 'string',
          description:
            'Service name to get logs for (e.g., "claude", "app"). Omit for all services.',
        },
      },
      required: ['stackId'],
    },
  },
  {
    name: 'set_pr',
    description:
      'Record that a pull request was created for a stack. Updates the stack status to pr_created and stores the PR URL and number.',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string', description: 'Stack ID' },
        prUrl: { type: 'string', description: 'Full URL of the pull request' },
        prNumber: { type: 'number', description: 'Pull request number' },
      },
      required: ['stackId', 'prUrl', 'prNumber'],
    },
  },
  {
    name: 'spec_check',
    description:
      'Run the spec quality gate against a ticket. Spawns an ephemeral agent to evaluate the ticket against the project\'s quality gate criteria. Returns a structured pass/fail report with gaps and assumptions. Use this instead of running /spec-check in-session to avoid inflating the outer session with evaluation tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket ID (e.g., "178", "#178", "PROJ-123")' },
        projectDir: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['ticketId', 'projectDir'],
    },
  },
  {
    name: 'spec_refine',
    description:
      'Refine a ticket that failed the spec quality gate. Spawns an ephemeral agent to incorporate user answers into the ticket and re-evaluate. Call without userAnswers to get the initial gaps and questions. Call with userAnswers to update the ticket and re-check. The outer Claude shuttles questions/answers between the user and this tool — each call is a fresh ephemeral process.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket ID (e.g., "178", "#178")' },
        projectDir: { type: 'string', description: 'Absolute path to the project directory' },
        userAnswers: { type: 'string', description: 'User answers to the gap questions from the previous spec_check or spec_refine call. Omit on the first call to get the initial gaps.' },
      },
      required: ['ticketId', 'projectDir'],
    },
  },
];

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case 'create_stack':
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

    case 'spec_check':
      return handleSpecCheck(
        input.ticketId as string,
        input.projectDir as string
      );

    case 'spec_refine':
      return handleSpecRefine(
        input.ticketId as string,
        input.projectDir as string,
        input.userAnswers as string | undefined
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleSpecCheck(
  ticketId: string,
  projectDir: string
): Promise<unknown> {
  const scriptStatus = getScriptStatus(projectDir);
  if (scriptStatus === 'missing') {
    return {
      passed: false,
      reason:
        "fetch-ticket.sh not found at .sandstorm/scripts/fetch-ticket.sh. " +
        "Run 'sandstorm init' to auto-generate it for your ticket system (Jira or GitHub Issues), " +
        "or create it manually: the script receives a ticket ID as $1 and must output the ticket body to stdout.",
    };
  }
  if (scriptStatus === 'not_executable') {
    return {
      passed: false,
      reason:
        "fetch-ticket.sh exists but is not executable. " +
        "Fix with: chmod +x .sandstorm/scripts/fetch-ticket.sh",
    };
  }

  const ticketBody = await fetchTicketContext(ticketId, projectDir);
  if (!ticketBody) {
    return {
      passed: false,
      reason: `fetch-ticket.sh ran but returned no output for ticket "${ticketId}". Check the script's implementation and that the ticket ID is correct.`,
    };
  }

  const gate = getSpecQualityGate(projectDir);
  if (!gate) {
    return {
      error: 'No quality gate configured. Run sandstorm init or create .sandstorm/spec-quality-gate.md.',
    };
  }

  const prompt = `You are a spec quality gate evaluator. Evaluate the ticket below against every criterion in the quality gate. Be strict — if you'd have to guess, it's a FAIL.

## Quality Gate Criteria

${gate}

## Ticket

${ticketBody}

## Instructions

For each criterion, determine PASS or FAIL. If FAIL, explain specifically what's missing.

Then list every assumption you would make if you started this task right now.

Respond in EXACTLY this format (no other text before or after):

## Spec Quality Gate: [PASS or FAIL]

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| <criterion name> | PASS/FAIL | <notes> |
...

### Gaps (if any)
- [ ] Specific gap 1 — what needs to be clarified
...

### Assumptions
- Assumption 1
...`;

  const result = await agentBackend.runEphemeralAgent(prompt, projectDir);
  const passed = /## Spec Quality Gate:\s*PASS/i.test(result);

  return {
    passed,
    report: result,
  };
}

async function handleSpecRefine(
  ticketId: string,
  projectDir: string,
  userAnswers?: string
): Promise<unknown> {
  const scriptStatus = getScriptStatus(projectDir);
  if (scriptStatus === 'missing') {
    return {
      passed: false,
      reason:
        "fetch-ticket.sh not found at .sandstorm/scripts/fetch-ticket.sh. " +
        "Run 'sandstorm init' to auto-generate it for your ticket system (Jira or GitHub Issues), " +
        "or create it manually: the script receives a ticket ID as $1 and must output the ticket body to stdout.",
    };
  }
  if (scriptStatus === 'not_executable') {
    return {
      passed: false,
      reason:
        "fetch-ticket.sh exists but is not executable. " +
        "Fix with: chmod +x .sandstorm/scripts/fetch-ticket.sh",
    };
  }

  const ticketBody = await fetchTicketContext(ticketId, projectDir);
  if (!ticketBody) {
    return {
      passed: false,
      reason: `fetch-ticket.sh ran but returned no output for ticket "${ticketId}". Check the script's implementation and that the ticket ID is correct.`,
    };
  }

  const gate = getSpecQualityGate(projectDir);
  if (!gate) {
    return {
      error: 'No quality gate configured. Run sandstorm init or create .sandstorm/spec-quality-gate.md.',
    };
  }

  if (!userAnswers) {
    // First call — evaluate and return gaps/questions
    const prompt = `You are a spec quality gate evaluator. Evaluate the ticket below against every criterion in the quality gate. Be strict.

## Quality Gate Criteria

${gate}

## Ticket

${ticketBody}

## Instructions

For each criterion that FAILS, ask a specific, answerable question that would resolve the gap. Don't ask vague questions — ask exactly what you need to know. Group related gaps into a single question when possible.

Respond in EXACTLY this format:

## Spec Quality Gate: [PASS or FAIL]

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| <criterion name> | PASS/FAIL | <notes> |
...

### Questions to Resolve Gaps
1. <specific question>
2. <specific question>
...`;

    const result = await agentBackend.runEphemeralAgent(prompt, projectDir);
    const passed = /## Spec Quality Gate:\s*PASS/i.test(result);

    return {
      passed,
      report: result,
    };
  }

  // Subsequent call — incorporate answers and re-evaluate
  const prompt = `You are a spec quality gate evaluator performing a refinement step.

## Quality Gate Criteria

${gate}

## Current Ticket

${ticketBody}

## User's Answers to Gap Questions

${userAnswers}

## Instructions

1. Incorporate the user's answers into the ticket body. Preserve existing content — add clarifications inline or in new sections, don't delete anything.
2. Re-evaluate the updated ticket against the quality gate.
3. If it still FAILs, ask new specific questions for the remaining gaps.

Respond in EXACTLY this format:

## Updated Ticket Body

<the full updated ticket body with answers incorporated>

## Spec Quality Gate: [PASS or FAIL]

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| <criterion name> | PASS/FAIL | <notes> |
...

### Questions to Resolve Remaining Gaps (if any)
1. <specific question>
...`;

  const result = await agentBackend.runEphemeralAgent(prompt, projectDir);
  const passed = /## Spec Quality Gate:\s*PASS/i.test(result);

  // Extract updated ticket body if present
  const bodyMatch = result.match(/## Updated Ticket Body\s*\n([\s\S]*?)(?=\n## Spec Quality Gate)/);
  const updatedBody = bodyMatch ? bodyMatch[1].trim() : null;

  return {
    passed,
    report: result,
    updatedBody,
  };
}
