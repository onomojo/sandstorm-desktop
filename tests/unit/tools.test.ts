import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tools, handleToolCall } from '../../src/main/claude/tools';

// Mock the stackManager import
vi.mock('../../src/main/index', () => ({
  stackManager: {
    createStack: vi.fn().mockResolvedValue({ id: 'test', status: 'building', services: [] }),
    dispatchTask: vi.fn().mockResolvedValue({ id: 1, status: 'running' }),
    listStacksWithServices: vi.fn().mockResolvedValue([]),
  },
}));

import { stackManager } from '../../src/main/index';

describe('MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tool definitions', () => {
    it('create_stack model enum includes auto, sonnet, opus', () => {
      const createStack = tools.find((t) => t.name === 'create_stack')!;
      const modelProp = (createStack.inputSchema.properties as Record<string, { enum?: string[] }>).model;
      expect(modelProp.enum).toEqual(['auto', 'sonnet', 'opus']);
    });

    it('dispatch_task model enum includes auto, sonnet, opus', () => {
      const dispatchTask = tools.find((t) => t.name === 'dispatch_task')!;
      const modelProp = (dispatchTask.inputSchema.properties as Record<string, { enum?: string[] }>).model;
      expect(modelProp.enum).toEqual(['auto', 'sonnet', 'opus']);
    });

    it('create_stack model description mentions triage and complexity signals', () => {
      const createStack = tools.find((t) => t.name === 'create_stack')!;
      const modelProp = (createStack.inputSchema.properties as Record<string, { description?: string }>).model;
      expect(modelProp.description).toContain('triage');
      expect(modelProp.description).toContain('architectural');
      expect(modelProp.description).toContain('security');
    });
  });

  describe('handleToolCall — model passthrough', () => {
    it('passes "auto" through to createStack (resolution happens in stack-manager)', async () => {
      await handleToolCall('create_stack', {
        name: 'test-stack',
        projectDir: '/proj',
        model: 'auto',
      });

      expect(stackManager.createStack).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'auto' })
      );
    });

    it('passes concrete model through for create_stack', async () => {
      await handleToolCall('create_stack', {
        name: 'test-stack',
        projectDir: '/proj',
        model: 'opus',
      });

      expect(stackManager.createStack).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'opus' })
      );
    });

    it('passes "auto" through to dispatchTask (resolution happens in stack-manager)', async () => {
      await handleToolCall('dispatch_task', {
        stackId: 'test-stack',
        prompt: 'Fix a typo',
        model: 'auto',
      });

      expect(stackManager.dispatchTask).toHaveBeenCalledWith(
        'test-stack',
        'Fix a typo',
        'auto',
        undefined
      );
    });

    it('passes concrete model through for dispatch_task', async () => {
      await handleToolCall('dispatch_task', {
        stackId: 'test-stack',
        prompt: 'Refactor auth',
        model: 'sonnet',
      });

      expect(stackManager.dispatchTask).toHaveBeenCalledWith(
        'test-stack',
        'Refactor auth',
        'sonnet',
        undefined
      );
    });

    it('treats omitted model as undefined', async () => {
      await handleToolCall('dispatch_task', {
        stackId: 'test-stack',
        prompt: 'Some task',
      });

      expect(stackManager.dispatchTask).toHaveBeenCalledWith(
        'test-stack',
        'Some task',
        undefined,
        undefined
      );
    });

    it('passes issueUrl through to dispatchTask', async () => {
      await handleToolCall('dispatch_task', {
        stackId: 'test-stack',
        prompt: 'Fix the bug',
        model: 'opus',
        issueUrl: 'https://github.com/owner/repo/issues/42',
      });

      expect(stackManager.dispatchTask).toHaveBeenCalledWith(
        'test-stack',
        'Fix the bug',
        'opus',
        'https://github.com/owner/repo/issues/42'
      );
    });
  });
});
