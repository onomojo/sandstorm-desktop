import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleToolCall, validateProjectDir } from '../../src/main/claude/tools';

// Mock the stackManager, agentBackend, and registry imports
vi.mock('../../src/main/index', () => ({
  stackManager: {
    createStack: vi.fn().mockResolvedValue({ id: 'test', status: 'building', services: [] }),
    dispatchTask: vi.fn().mockResolvedValue({ id: 1, status: 'running' }),
    listStacksWithServices: vi.fn().mockResolvedValue([]),
  },
  agentBackend: {
    runEphemeralAgent: vi.fn().mockResolvedValue(''),
  },
  registry: {
    getProjectTicketConfig: vi.fn().mockReturnValue({ provider: 'github' }),
  },
}));

vi.mock('../../src/main/scheduler', () => ({
  createSchedule: vi.fn().mockReturnValue({
    id: 'sch_abc123456789',
    cronExpression: '0 * * * *',
    action: { kind: 'run-script', scriptName: 'do-stuff.sh' },
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }),
  listSchedules: vi.fn().mockReturnValue([]),
  updateSchedule: vi.fn().mockReturnValue({
    id: 'sch_abc123456789',
    cronExpression: '*/5 * * * *',
    action: { kind: 'run-script', scriptName: 'do-stuff.sh' },
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }),
  deleteSchedule: vi.fn(),
}));

vi.mock('../../src/main/scheduler/scheduler-manager', () => ({
  syncAllProjectsCrontab: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/main/control-plane/ticket-config', () => ({
  fetchTicketWithConfig: vi.fn().mockResolvedValue(null),
  updateTicketWithConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/main/spec-quality-gate', () => ({
  getSpecQualityGate: vi.fn().mockReturnValue(''),
}));

import { stackManager, agentBackend, registry } from '../../src/main/index';
import { fetchTicketWithConfig, updateTicketWithConfig } from '../../src/main/control-plane/ticket-config';
import { getSpecQualityGate } from '../../src/main/spec-quality-gate';
import { createSchedule, listSchedules, updateSchedule, deleteSchedule } from '../../src/main/scheduler';
import { syncAllProjectsCrontab } from '../../src/main/scheduler/scheduler-manager';

const mockGetProviderConfig = vi.mocked(registry.getProjectTicketConfig);

describe('MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: provider is configured as GitHub
    mockGetProviderConfig.mockReturnValue({ provider: 'github' });
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
        expect.anything()
      );
    });

    it('passes gateApproved through to dispatchTask', async () => {
      await handleToolCall('dispatch_task', {
        stackId: 'test-stack',
        prompt: 'Some task',
        gateApproved: true,
      });

      expect(stackManager.dispatchTask).toHaveBeenCalledWith(
        'test-stack',
        'Some task',
        undefined,
        { gateApproved: true, forceBypass: undefined }
      );
    });

    it('passes forceBypass through to dispatchTask', async () => {
      await handleToolCall('dispatch_task', {
        stackId: 'test-stack',
        prompt: 'Some task',
        forceBypass: true,
      });

      expect(stackManager.dispatchTask).toHaveBeenCalledWith(
        'test-stack',
        'Some task',
        undefined,
        { gateApproved: undefined, forceBypass: true }
      );
    });

    it('passes no gate flags through when neither provided', async () => {
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

  describe('handleToolCall — spec_check', () => {
    it('returns passed:false with reason when no ticket provider is configured', async () => {
      mockGetProviderConfig.mockReturnValue(null);
      const result = await handleToolCall('spec_check', {
        ticketId: '999',
        projectDir: '/proj',
      }) as { passed: boolean; reason: string };
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('No ticket provider configured');
    });

    it('returns passed:false with reason when fetch returns no output', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue(null);
      const result = await handleToolCall('spec_check', {
        ticketId: '999',
        projectDir: '/proj',
      }) as { passed: boolean; reason: string };
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('returned no output');
    });

    it('returns error when quality gate is not configured', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Test\nSome body');
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
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Fix bug\nDetailed description');
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
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Vague task');
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

    it('spec_check prompt includes assumption resolution phase', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Test\nBody');
      vi.mocked(getSpecQualityGate).mockReturnValue('### Problem Statement\nClear?');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: PASS\n\n### Assumption Resolution\n| # | Assumption | Type | Resolution |\n|---|---|---|---|'
      );

      await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/proj',
      });

      const prompt = vi.mocked(agentBackend.runEphemeralAgent).mock.calls[0][0];
      expect(prompt).toContain('Phase 1: Assumption Resolution');
      expect(prompt).toContain('Self-resolvable');
      expect(prompt).toContain('Requires human input');
      expect(prompt).toContain('Zero Unresolved');
      expect(prompt).toContain('End-to-End Data Flow');
      expect(prompt).toContain('Dependency Contracts');
      expect(prompt).toContain('Automated Visual Verification');
      expect(prompt).toContain('All Verification Automatable');
      expect(prompt).toContain('Questions Requiring User Answers');
    });
  });

  describe('validateProjectDir', () => {
    it('returns null for valid absolute paths', () => {
      expect(validateProjectDir('/home/user/project')).toBeNull();
      expect(validateProjectDir('/tmp/my-project')).toBeNull();
      expect(validateProjectDir('/home/user/path with spaces/project')).toBeNull();
    });

    it('returns error for empty string', () => {
      const result = validateProjectDir('');
      expect(result).not.toBeNull();
      expect(result!.error).toContain('required');
    });

    it('returns error for undefined', () => {
      const result = validateProjectDir(undefined);
      expect(result).not.toBeNull();
      expect(result!.error).toContain('required');
    });

    it('returns error for null', () => {
      const result = validateProjectDir(null);
      expect(result).not.toBeNull();
      expect(result!.error).toContain('required');
    });

    it('returns error for whitespace-only string', () => {
      const result = validateProjectDir('   ');
      expect(result).not.toBeNull();
      expect(result!.error).toContain('required');
    });

    it('returns error for relative path "."', () => {
      const result = validateProjectDir('.');
      expect(result).not.toBeNull();
      expect(result!.error).toContain('absolute path');
      expect(result!.error).toContain('"."');
    });

    it('returns error for relative path "./project"', () => {
      const result = validateProjectDir('./project');
      expect(result).not.toBeNull();
      expect(result!.error).toContain('absolute path');
    });

    it('returns error for relative path "project"', () => {
      const result = validateProjectDir('project');
      expect(result).not.toBeNull();
      expect(result!.error).toContain('absolute path');
    });

    it('returns error for non-string types', () => {
      expect(validateProjectDir(123)).not.toBeNull();
      expect(validateProjectDir(true)).not.toBeNull();
      expect(validateProjectDir({})).not.toBeNull();
    });

    it('returns error for paths with traversal sequences', () => {
      const result = validateProjectDir('/home/user/../etc/passwd');
      expect(result).not.toBeNull();
      expect(result!.error).toContain('traversal');
    });

    it('returns null for valid paths that contain no traversal sequences', () => {
      expect(validateProjectDir('/home/user/projects/my-app')).toBeNull();
      expect(validateProjectDir('/tmp/sandstorm')).toBeNull();
    });
  });

  describe('handleToolCall — projectDir validation', () => {
    it('spec_check rejects empty projectDir', async () => {
      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '',
      }) as { error: string };
      expect(result.error).toContain('required');
    });

    it('spec_check rejects relative projectDir', async () => {
      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '.',
      }) as { error: string };
      expect(result.error).toContain('absolute path');
    });

    it('spec_check rejects undefined projectDir', async () => {
      const result = await handleToolCall('spec_check', {
        ticketId: '42',
      }) as { error: string };
      expect(result.error).toContain('required');
    });

    it('spec_refine rejects empty projectDir', async () => {
      const result = await handleToolCall('spec_refine', {
        ticketId: '42',
        projectDir: '',
      }) as { error: string };
      expect(result.error).toContain('required');
    });

    it('spec_refine rejects relative projectDir', async () => {
      const result = await handleToolCall('spec_refine', {
        ticketId: '42',
        projectDir: './my-project',
      }) as { error: string };
      expect(result.error).toContain('absolute path');
    });

    it('create_stack rejects empty projectDir', async () => {
      const result = await handleToolCall('create_stack', {
        name: 'test',
        projectDir: '',
      }) as { error: string };
      expect(result.error).toContain('required');
    });

    it('create_stack rejects relative projectDir', async () => {
      const result = await handleToolCall('create_stack', {
        name: 'test',
        projectDir: '.',
      }) as { error: string };
      expect(result.error).toContain('absolute path');
    });

    it('spec_check accepts valid absolute projectDir', async () => {
      mockGetProviderConfig.mockReturnValue(null);
      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/home/user/my-project',
      }) as { passed: boolean; reason: string };
      // Should proceed past validation and fail on provider config
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('No ticket provider configured');
    });
  });

  describe('handleToolCall — error messages', () => {
    it('spec_check unconfigured provider error is actionable', async () => {
      mockGetProviderConfig.mockReturnValue(null);
      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/home/user/my-project',
      }) as { passed: boolean; reason: string };
      expect(result.reason).toContain('No ticket provider configured');
      expect(result.reason).toContain('Project Settings');
    });

    it('spec_check no-quality-gate error includes absolute path', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Ticket body');
      vi.mocked(getSpecQualityGate).mockReturnValue('');
      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/home/user/my-project',
      }) as { error: string };
      expect(result.error).toContain('/home/user/my-project/.sandstorm/spec-quality-gate.md');
    });

    it('spec_refine unconfigured provider error is actionable', async () => {
      mockGetProviderConfig.mockReturnValue(null);
      const result = await handleToolCall('spec_refine', {
        ticketId: '42',
        projectDir: '/home/user/my-project',
      }) as { passed: boolean; reason: string };
      expect(result.reason).toContain('No ticket provider configured');
    });

    it('spec_refine no-quality-gate error includes absolute path', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Ticket body');
      vi.mocked(getSpecQualityGate).mockReturnValue('');
      const result = await handleToolCall('spec_refine', {
        ticketId: '42',
        projectDir: '/home/user/my-project',
      }) as { error: string };
      expect(result.error).toContain('/home/user/my-project/.sandstorm/spec-quality-gate.md');
    });
  });

  describe('handleToolCall — schedule tools', () => {
    it('schedule_create rejects empty projectDir', async () => {
      const result = await handleToolCall('schedule_create', {
        projectDir: '',
        cronExpression: '0 * * * *',
        action: { kind: 'run-script', scriptName: 'do-stuff.sh' },
      }) as { error: string };
      expect(result.error).toContain('required');
    });

    it('schedule_create rejects relative projectDir', async () => {
      const result = await handleToolCall('schedule_create', {
        projectDir: './my-project',
        cronExpression: '0 * * * *',
        action: { kind: 'run-script', scriptName: 'do-stuff.sh' },
      }) as { error: string };
      expect(result.error).toContain('absolute path');
    });

    it('schedule_create calls createSchedule and syncAllProjectsCrontab', async () => {
      const result = await handleToolCall('schedule_create', {
        projectDir: '/proj',
        cronExpression: '0 * * * *',
        action: { kind: 'run-script', scriptName: 'do-stuff.sh' },
        enabled: true,
      }) as { id: string };

      expect(createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          projectDir: '/proj',
          cronExpression: '0 * * * *',
          action: { kind: 'run-script', scriptName: 'do-stuff.sh' },
          enabled: true,
        })
      );
      expect(syncAllProjectsCrontab).toHaveBeenCalled();
      expect(result.id).toBe('sch_abc123456789');
    });

    it('schedule_create still returns id when syncAllProjectsCrontab fails', async () => {
      vi.mocked(syncAllProjectsCrontab).mockRejectedValueOnce(new Error('crontab unavailable'));

      const result = await handleToolCall('schedule_create', {
        projectDir: '/proj',
        cronExpression: '0 * * * *',
        action: { kind: 'run-script', scriptName: 'do-stuff.sh' },
      }) as { id: string };

      expect(result.id).toBe('sch_abc123456789');
    });

    it('schedule_list rejects empty projectDir', async () => {
      const result = await handleToolCall('schedule_list', {
        projectDir: '',
      }) as { error: string };
      expect(result.error).toContain('required');
    });

    it('schedule_list calls listSchedules and returns schedules array', async () => {
      const mockSchedules = [{ id: 'sch_abc123456789', cronExpression: '0 * * * *', action: { kind: 'run-script', scriptName: 'do-stuff.sh' }, enabled: true, createdAt: '', updatedAt: '' }];
      vi.mocked(listSchedules).mockReturnValueOnce(mockSchedules);

      const result = await handleToolCall('schedule_list', {
        projectDir: '/proj',
      }) as { schedules: unknown[] };

      expect(listSchedules).toHaveBeenCalledWith('/proj');
      expect(result.schedules).toEqual(mockSchedules);
    });

    it('schedule_update rejects empty projectDir', async () => {
      const result = await handleToolCall('schedule_update', {
        projectDir: '',
        id: 'sch_abc123456789',
        patch: { enabled: false },
      }) as { error: string };
      expect(result.error).toContain('required');
    });

    it('schedule_update calls updateSchedule and syncAllProjectsCrontab', async () => {
      const result = await handleToolCall('schedule_update', {
        projectDir: '/proj',
        id: 'sch_abc123456789',
        patch: { enabled: false },
      }) as { schedule: unknown };

      expect(updateSchedule).toHaveBeenCalledWith('/proj', 'sch_abc123456789', { enabled: false });
      expect(syncAllProjectsCrontab).toHaveBeenCalled();
      expect(result.schedule).toBeDefined();
    });

    it('schedule_delete rejects empty projectDir', async () => {
      const result = await handleToolCall('schedule_delete', {
        projectDir: '',
        id: 'sch_abc123456789',
      }) as { error: string };
      expect(result.error).toContain('required');
    });

    it('schedule_delete calls deleteSchedule and syncAllProjectsCrontab', async () => {
      const result = await handleToolCall('schedule_delete', {
        projectDir: '/proj',
        id: 'sch_abc123456789',
      }) as { ok: boolean };

      expect(deleteSchedule).toHaveBeenCalledWith('/proj', 'sch_abc123456789');
      expect(syncAllProjectsCrontab).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it('schedule_delete still returns ok when syncAllProjectsCrontab fails', async () => {
      vi.mocked(syncAllProjectsCrontab).mockRejectedValueOnce(new Error('crontab unavailable'));

      const result = await handleToolCall('schedule_delete', {
        projectDir: '/proj',
        id: 'sch_abc123456789',
      }) as { ok: boolean };

      expect(result.ok).toBe(true);
    });
  });

  describe('handleToolCall — spec_refine', () => {
    it('returns passed:false with reason when no ticket provider is configured', async () => {
      mockGetProviderConfig.mockReturnValue(null);
      const result = await handleToolCall('spec_refine', {
        ticketId: '999',
        projectDir: '/proj',
      }) as { passed: boolean; reason: string };
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('No ticket provider configured');
    });

    it('returns passed:false with reason when fetch returns no output', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue(null);
      const result = await handleToolCall('spec_refine', {
        ticketId: '999',
        projectDir: '/proj',
      }) as { passed: boolean; reason: string };
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('returned no output');
    });

    it('returns initial gaps when called without userAnswers', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Incomplete spec');
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
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Incomplete spec');
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

    describe('ticket write-back', () => {
      beforeEach(() => {
        vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: stale');
        vi.mocked(getSpecQualityGate).mockReturnValue('### Problem Statement');
      });

      it('calls updateTicketWithConfig with the refined body when refinement produces one', async () => {
        vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
          '## Updated Ticket Body\n\n# Issue: Refined\nWith answers.\n\n## Spec Quality Gate: PASS\n\n### Results\n| C | R |\n|---|---|',
        );

        await handleToolCall('spec_refine', {
          ticketId: '42',
          projectDir: '/proj',
          userAnswers: 'My answer',
        });

        expect(updateTicketWithConfig).toHaveBeenCalledTimes(1);
        expect(updateTicketWithConfig).toHaveBeenCalledWith(
          '42',
          '# Issue: Refined\nWith answers.',
          expect.objectContaining({ provider: 'github' }),
          '/proj',
        );
      });

      it('writes back even when the refinement still FAILs (iterative loops)', async () => {
        vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
          '## Updated Ticket Body\n\n# Issue: Refined v1\nPartial.\n\n## Spec Quality Gate: FAIL\n\n### Questions to Resolve Remaining Gaps\n1. Still need X?',
        );

        const result = await handleToolCall('spec_refine', {
          ticketId: '42',
          projectDir: '/proj',
          userAnswers: 'Partial answer',
        }) as { passed: boolean; updatedBody: string | null };

        expect(updateTicketWithConfig).toHaveBeenCalledOnce();
        expect(result.passed).toBe(false);
        expect(result.updatedBody).toContain('Refined v1');
      });

      it('does NOT call updateTicketWithConfig on the initial call (no userAnswers)', async () => {
        vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
          '## Spec Quality Gate: FAIL\n\n### Questions to Resolve Gaps\n1. What problem?',
        );

        await handleToolCall('spec_refine', {
          ticketId: '42',
          projectDir: '/proj',
        });

        expect(updateTicketWithConfig).not.toHaveBeenCalled();
      });

      it('returns an error when write-back fails so the renderer can surface it', async () => {
        vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
          '## Updated Ticket Body\n\n# Issue: Refined\n\n## Spec Quality Gate: PASS',
        );
        vi.mocked(updateTicketWithConfig).mockRejectedValueOnce(new Error('gh: not authenticated'));

        const result = await handleToolCall('spec_refine', {
          ticketId: '42',
          projectDir: '/proj',
          userAnswers: 'A',
        }) as { passed: boolean; updatedBody: string | null; error?: string };

        expect(result.passed).toBe(false);
        expect(result.error).toMatch(/gh: not authenticated/);
        expect(result.updatedBody).toContain('Refined');
      });

      it('returns an error when refinement should have produced an updatedBody but did not', async () => {
        vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
          '## Spec Quality Gate: PASS\n\n### Results\n| C | R |\n|---|---|',
        );

        const result = await handleToolCall('spec_refine', {
          ticketId: '42',
          projectDir: '/proj',
          userAnswers: 'A',
        }) as { passed: boolean; updatedBody: string | null; error?: string };

        expect(updateTicketWithConfig).not.toHaveBeenCalled();
        expect(result.passed).toBe(false);
        expect(result.error).toMatch(/did not produce/i);
        expect(result.updatedBody).toBeNull();
      });
    });

    it('spec_refine initial prompt includes assumption resolution and enhanced checks', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Test\nBody');
      vi.mocked(getSpecQualityGate).mockReturnValue('### Problem Statement\nClear?');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: FAIL\n\n### Questions to Resolve Gaps\n1. What is X?'
      );

      await handleToolCall('spec_refine', {
        ticketId: '42',
        projectDir: '/proj',
      });

      const prompt = vi.mocked(agentBackend.runEphemeralAgent).mock.calls[0][0];
      expect(prompt).toContain('Phase 1: Assumption Resolution');
      expect(prompt).toContain('Self-resolvable');
      expect(prompt).toContain('Requires human input');
      expect(prompt).toContain('Zero Unresolved Assumptions');
      expect(prompt).toContain('End-to-End Data Flow');
      expect(prompt).toContain('Dependency Contracts');
      expect(prompt).toContain('Automated Visual Verification');
      expect(prompt).toContain('All Verification Automatable');
    });

    it('spec_refine refinement prompt includes enhanced evaluation criteria', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Test\nBody');
      vi.mocked(getSpecQualityGate).mockReturnValue('### Problem Statement\nClear?');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Updated Ticket Body\n\n# Issue: Updated\n\n## Spec Quality Gate: PASS\n\n### Results\n| Criterion | Result |\n|---|---|\n| Problem Statement | PASS |'
      );

      await handleToolCall('spec_refine', {
        ticketId: '42',
        projectDir: '/proj',
        userAnswers: 'Answer to question 1',
      });

      const prompt = vi.mocked(agentBackend.runEphemeralAgent).mock.calls[0][0];
      expect(prompt).toContain('Zero Unresolved Assumptions');
      expect(prompt).toContain('End-to-End Data Flow');
      expect(prompt).toContain('Dependency Contracts');
      expect(prompt).toContain('Automated Visual Verification');
      expect(prompt).toContain('All Verification Automatable');
      expect(prompt).toContain('Replace resolved assumptions with verified facts');
    });
  });
});
