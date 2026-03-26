/**
 * MCP tool definitions that Claude can use to interact with the control plane.
 * These are exposed to the Claude chat window so the AI can create stacks,
 * dispatch tasks, and manage the lifecycle programmatically.
 */

import { stackManager } from '../index';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const tools: ToolDefinition[] = [
  {
    name: 'create_stack',
    description:
      'Create a new Sandstorm stack with a name, project directory, and optional task',
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
        model: { type: 'string', enum: ['sonnet', 'opus'], description: 'Claude model for inner agent (default: sonnet). Use "opus" for complex architectural tasks, "sonnet" for simpler work.' },
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
    description: 'Dispatch a task to an existing stack',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string', description: 'Stack ID to dispatch to' },
        prompt: { type: 'string', description: 'Task description for inner Claude' },
        model: { type: 'string', enum: ['sonnet', 'opus'], description: 'Claude model for this task (default: sonnet). Use "opus" for complex tasks, "sonnet" for simpler work.' },
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
      });

    case 'list_stacks':
      return stackManager.listStacksWithServices();

    case 'dispatch_task':
      return stackManager.dispatchTask(
        input.stackId as string,
        input.prompt as string,
        input.model as string | undefined
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
      stackManager.teardownStack(input.stackId as string);
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
