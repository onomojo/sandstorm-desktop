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
  // NOTE: teardown_stack intentionally removed from Claude tools.
  // Stacks should only be torn down by explicit user action in the UI,
  // never automatically by the outer Claude agent.
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
      });

    case 'list_stacks':
      return stackManager.listStacksWithServices();

    case 'dispatch_task':
      return stackManager.dispatchTask(
        input.stackId as string,
        input.prompt as string
      );

    case 'get_diff':
      return stackManager.getDiff(input.stackId as string);

    case 'push_stack':
      await stackManager.push(
        input.stackId as string,
        input.message as string | undefined
      );
      return { success: true };

    case 'teardown_stack':
      throw new Error(
        'Automated stack teardown is disabled. Stacks can only be torn down by the user through the UI.'
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
