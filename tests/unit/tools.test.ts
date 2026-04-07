import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tools, handleToolCall } from '../../src/main/claude/tools';

// Mock the stackManager and agentBackend imports
vi.mock('../../src/main/index', () => ({
  stackManager: {
    createStack: vi.fn().mockResolvedValue({ id: 'test', status: 'building', services: [] }),
    dispatchTask: vi.fn().mockResolvedValue({ id: 1, status: 'running' }),
    listStacksWithServices: vi.fn().mockResolvedValue([]),
  },
  agentBackend: {
    runEphemeralAgent: vi.fn().mockResolvedValue(''),
  },
}));

vi.mock('../../src/main/control-plane/ticket-fetcher', () => ({
  fetchTicketContext: vi.fn().mockResolvedValue(null),
  getScriptStatus: vi.fn().mockReturnValue('ok'),
}));

vi.mock('../../src/main/spec-quality-gate', () => ({
  getSpecQualityGate: vi.fn().mockReturnValue(''),
}));

import { stackManager, agentBackend } from '../../src/main/index';
import { fetchTicketContext, getScriptStatus } from '../../src/main/control-plane/ticket-fetcher';
import { getSpecQualityGate } from '../../src/main/spec-quality-gate';

describe('MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: script exists and is executable (individual tests override as needed)
    vi.mocked(getScriptStatus).mockReturnValue('ok');
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
      expect(modelProp.description).toContain('Security');
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
        { gateApproved: undefined, forceBypass: undefined }
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
        { gateApproved: undefined, forceBypass: undefined }
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
        { gateApproved: undefined, forceBypass: undefined }
      );
    });
  });

  describe('tool definitions — spec tools', () => {
    it('spec_check tool is defined with required ticketId and projectDir', () => {
      const specCheck = tools.find((t) => t.name === 'spec_check');
      expect(specCheck).toBeDefined();
      expect(specCheck!.inputSchema.required).toEqual(['ticketId', 'projectDir']);
    });

    it('spec_refine tool is defined with required ticketId and projectDir', () => {
      const specRefine = tools.find((t) => t.name === 'spec_refine');
      expect(specRefine).toBeDefined();
      expect(specRefine!.inputSchema.required).toEqual(['ticketId', 'projectDir']);
    });
  });

  describe('handleToolCall — spec_check', () => {
    it('returns passed:false with reason when fetch-ticket.sh is missing', async () => {
      vi.mocked(getScriptStatus).mockReturnValue('missing');
      const result = await handleToolCall('spec_check', {
        ticketId: '999',
        projectDir: '/proj',
      }) as { passed: boolean; reason: string };
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('fetch-ticket.sh not found');
      expect(result.reason).toContain('sandstorm init');
    });

    it('returns passed:false with reason when fetch-ticket.sh is not executable', async () => {
      vi.mocked(getScriptStatus).mockReturnValue('not_executable');
      const result = await handleToolCall('spec_check', {
        ticketId: '999',
        projectDir: '/proj',
      }) as { passed: boolean; reason: string };
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('not executable');
      expect(result.reason).toContain('chmod');
    });

    it('returns passed:false with reason when script runs but returns no output', async () => {
      vi.mocked(getScriptStatus).mockReturnValue('ok');
      vi.mocked(fetchTicketContext).mockResolvedValue(null);
      const result = await handleToolCall('spec_check', {
        ticketId: '999',
        projectDir: '/proj',
      }) as { passed: boolean; reason: string };
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('returned no output');
    });

    it('returns error when quality gate is not configured', async () => {
      vi.mocked(fetchTicketContext).mockResolvedValue('# Issue: Test\nSome body');
      vi.mocked(getSpecQualityGate).mockReturnValue('');
      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/proj',
      });
      expect(result).toEqual(
        expect.objectContaining({ error: expect.stringContaining('No quality gate') })
      );
    });

    it('spawns ephemeral agent and returns passed=true when report says PASS', async () => {
      vi.mocked(fetchTicketContext).mockResolvedValue('# Issue: Fix bug\nDetailed description');
      vi.mocked(getSpecQualityGate).mockReturnValue('### Problem Statement\nIs the why clear?');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: PASS\n\n### Results\n| Criterion | Result |\n|---|---|\n| Problem Statement | PASS |'
      );

      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/proj',
      }) as { passed: boolean; report: string };

      expect(agentBackend.runEphemeralAgent).toHaveBeenCalledWith(
        expect.stringContaining('Fix bug'),
        '/proj'
      );
      expect(result.passed).toBe(true);
      expect(result.report).toContain('PASS');
    });

    it('returns passed=false when report says FAIL', async () => {
      vi.mocked(fetchTicketContext).mockResolvedValue('# Issue: Vague task');
      vi.mocked(getSpecQualityGate).mockReturnValue('### Problem Statement\nIs the why clear?');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: FAIL\n\n### Gaps\n- [ ] Missing problem statement'
      );

      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/proj',
      }) as { passed: boolean; report: string };

      expect(result.passed).toBe(false);
    });
  });

  describe('handleToolCall — spec_refine', () => {
    it('returns passed:false with reason when fetch-ticket.sh is missing', async () => {
      vi.mocked(getScriptStatus).mockReturnValue('missing');
      const result = await handleToolCall('spec_refine', {
        ticketId: '999',
        projectDir: '/proj',
      }) as { passed: boolean; reason: string };
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('fetch-ticket.sh not found');
    });

    it('returns passed:false with reason when script runs but returns no output', async () => {
      vi.mocked(getScriptStatus).mockReturnValue('ok');
      vi.mocked(fetchTicketContext).mockResolvedValue(null);
      const result = await handleToolCall('spec_refine', {
        ticketId: '999',
        projectDir: '/proj',
      }) as { passed: boolean; reason: string };
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('returned no output');
    });

    it('returns initial gaps when called without userAnswers', async () => {
      vi.mocked(fetchTicketContext).mockResolvedValue('# Issue: Incomplete spec');
      vi.mocked(getSpecQualityGate).mockReturnValue('### Problem Statement\nIs the why clear?');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: FAIL\n\n### Questions to Resolve Gaps\n1. What problem does this solve?'
      );

      const result = await handleToolCall('spec_refine', {
        ticketId: '42',
        projectDir: '/proj',
      }) as { passed: boolean; report: string };

      expect(result.passed).toBe(false);
      expect(result.report).toContain('What problem does this solve');
    });

    it('incorporates user answers and re-evaluates when called with userAnswers', async () => {
      vi.mocked(fetchTicketContext).mockResolvedValue('# Issue: Incomplete spec');
      vi.mocked(getSpecQualityGate).mockReturnValue('### Problem Statement\nIs the why clear?');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Updated Ticket Body\n\n# Issue: Better spec\nThe problem is X.\n\n## Spec Quality Gate: PASS\n\n### Results\n| Criterion | Result |\n|---|---|\n| Problem Statement | PASS |'
      );

      const result = await handleToolCall('spec_refine', {
        ticketId: '42',
        projectDir: '/proj',
        userAnswers: 'The problem is that auth tokens expire silently.',
      }) as { passed: boolean; report: string; updatedBody: string | null };

      expect(agentBackend.runEphemeralAgent).toHaveBeenCalledWith(
        expect.stringContaining('auth tokens expire silently'),
        '/proj'
      );
      expect(result.passed).toBe(true);
      expect(result.updatedBody).toContain('Better spec');
    });
  });
});
