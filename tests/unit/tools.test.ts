import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleToolCall, validateProjectDir, _clearTicketBodyCacheForTests, _disposeAllRefineSessionsForTests, spawnSpecRefine, spawnSpecCheck } from '../../src/main/claude/tools';
import type { EphemeralSessionHandle } from '../../src/main/agent/types';

vi.mock('../../src/main/tray', () => ({
  showNotification: vi.fn(),
}));

// Mock the stackManager, agentBackend, and registry imports
vi.mock('../../src/main/index', () => ({
  stackManager: {
    createStack: vi.fn().mockResolvedValue({ id: 'test', status: 'building', services: [] }),
    dispatchTask: vi.fn().mockResolvedValue({ id: 1, status: 'running' }),
    listStacksWithServices: vi.fn().mockResolvedValue([]),
  },
  agentBackend: {
    runEphemeralAgent: vi.fn().mockResolvedValue(''),
    spawnEphemeralAgent: vi.fn(),
    spawnEphemeralSession: vi.fn(),
  },
  registry: {
    getProjectTicketConfig: vi.fn().mockReturnValue({ provider: 'github' }),
    getEffectiveRoutingFor: vi.fn().mockReturnValue({ backend: 'claude', model: 'sonnet' }),
    getLegacyEffectiveModels: vi.fn().mockReturnValue({ inner_model: 'sonnet', outer_model: 'opus' }),
    getEffectiveTouchpointDescriptor: vi.fn().mockReturnValue({ backend: 'claude', provider: 'anthropic', model: 'sonnet', credentials: {} }),
    getEpicForTicket: vi.fn().mockReturnValue(null),
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
  getDefaultSpecQualityGate: vi.fn().mockReturnValue('### Problem Statement\nIs the why clear?'),
}));

vi.mock('../../src/main/control-plane/ticket-references', () => ({
  resolveTicketReferences: vi.fn().mockResolvedValue([]),
  renderResolvedReferences: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/main/control-plane/git-freshness', () => ({
  ensureFreshAgainstMain: vi.fn().mockResolvedValue({ mutated: false }),
}));

import { stackManager, agentBackend, registry } from '../../src/main/index';
import { fetchTicketWithConfig, updateTicketWithConfig } from '../../src/main/control-plane/ticket-config';
import { resolveTicketReferences, renderResolvedReferences } from '../../src/main/control-plane/ticket-references';
import { createSchedule, listSchedules, updateSchedule, deleteSchedule } from '../../src/main/scheduler';
import { syncAllProjectsCrontab } from '../../src/main/scheduler/scheduler-manager';
import { ensureFreshAgainstMain } from '../../src/main/control-plane/git-freshness';

const mockGetProviderConfig = vi.mocked(registry.getProjectTicketConfig);

describe('MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearTicketBodyCacheForTests();
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

    it('spawns ephemeral agent and returns passed=true when report says PASS', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Fix bug\nDetailed description');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: PASS\n\n### Results\n| Criterion | Result |\n|---|---|\n| Problem Statement | PASS |'
      );

      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/proj',
      }) as { passed: boolean; report: string };

      expect(agentBackend.runEphemeralAgent).toHaveBeenCalledWith(
        expect.stringContaining('Fix bug'),
        '/proj',
        1_800_000,
        { ticketId: '42', stage: 'spec' },
        'sonnet', // model resolved from refine touchpoint routing
        'refine', // touchpoint always passed
      );
      expect(result.passed).toBe(true);
      expect(result.report).toContain('PASS');
    });

    it('returns passed=false when report says FAIL', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Vague task');
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
      expect(prompt).toContain('Dependency Contracts');
      expect(prompt).toContain('Questions Requiring User Answers');
    });

    it('prepends staleness warning to report when ensureFreshAgainstMain returns a warning', async () => {
      const WARNING = '[Staleness warning] Project dir is on `feat/some-branch@aaa0000`, behind `origin/main` — citations may be stale; refresh before trusting a FAIL.';
      vi.mocked(ensureFreshAgainstMain).mockResolvedValue({ mutated: false, warning: WARNING });
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Has citations\nBody');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: PASS\n\n### Results\n| C | R |\n|---|---|\n| X | PASS |',
      );

      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/proj',
      }) as { passed: boolean; report: string };

      expect(result.passed).toBe(true);
      expect(result.report).toMatch(/^\[Staleness warning\]/);
      expect(result.report).toContain(WARNING);
      expect(result.report).toContain('## Spec Quality Gate: PASS');
    });

    it('PASS/FAIL parse is unaffected by a prepended warning', async () => {
      const WARNING = '[Staleness warning] fetch failed/offline — results may be stale.';
      vi.mocked(ensureFreshAgainstMain).mockResolvedValue({ mutated: false, warning: WARNING });
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Has citations\nBody');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: FAIL\n\n### Gaps\n- [ ] Missing detail',
      );

      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/proj',
      }) as { passed: boolean; report: string };

      expect(result.passed).toBe(false);
      expect(result.report).toContain(WARNING);
    });

    it('no warning prepended when ensureFreshAgainstMain returns clean result', async () => {
      vi.mocked(ensureFreshAgainstMain).mockResolvedValue({ mutated: true });
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Up to date\nBody');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: PASS\n\n### Results\n| C | R |\n|---|---|\n| X | PASS |',
      );

      const result = await handleToolCall('spec_check', {
        ticketId: '42',
        projectDir: '/proj',
      }) as { passed: boolean; report: string };

      expect(result.passed).toBe(true);
      expect(result.report).not.toContain('Staleness warning');
      expect(result.report).toMatch(/^## Spec Quality Gate/);
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

    it('spec_refine unconfigured provider error is actionable', async () => {
      mockGetProviderConfig.mockReturnValue(null);
      const result = await handleToolCall('spec_refine', {
        ticketId: '42',
        projectDir: '/home/user/my-project',
      }) as { passed: boolean; reason: string };
      expect(result.reason).toContain('No ticket provider configured');
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
        '/proj',
        1_800_000,
        { ticketId: '42', stage: 'refine' },
        undefined,
        'refine',
      );
      expect(result.passed).toBe(true);
      expect(result.updatedBody).toContain('Better spec');
    });

    describe('ticket write-back', () => {
      beforeEach(() => {
        vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: stale');
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
      expect(prompt).toContain('Dependency Contracts');
    });

    it('spec_refine initial: prepends staleness warning to report when ensureFreshAgainstMain warns', async () => {
      const WARNING = '[Staleness warning] Project dir is on `main@deadbeef`, behind `origin/main`.';
      vi.mocked(ensureFreshAgainstMain).mockResolvedValue({ mutated: false, warning: WARNING });
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Needs refine\nBody');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: FAIL\n\n### Questions Requiring User Answers\n1. What?',
      );

      const result = await handleToolCall('spec_refine', {
        ticketId: 'T-42',
        projectDir: '/proj',
      }) as { passed: boolean; report: string };

      expect(result.passed).toBe(false);
      expect(result.report).toContain(WARNING);
    });

    it('spec_refine answer: prepends staleness warning to report when ensureFreshAgainstMain warns', async () => {
      const WARNING = '[Staleness warning] fetch failed/offline — results may be stale.';
      vi.mocked(ensureFreshAgainstMain).mockResolvedValue({ mutated: false, warning: WARNING });
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Needs refine\nBody');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Updated Ticket Body\n\n# Issue: Updated\n\n## Spec Quality Gate: PASS\n\n### Results\n| C | R |\n|---|---|\n| X | PASS |',
      );
      vi.mocked(updateTicketWithConfig).mockResolvedValue(undefined);

      const result = await handleToolCall('spec_refine', {
        ticketId: 'T-42',
        projectDir: '/proj',
        userAnswers: 'some answers',
      }) as { passed: boolean; report: string };

      expect(result.passed).toBe(true);
      expect(result.report).toContain(WARNING);
    });

    describe('ticket body cache (#370)', () => {
      beforeEach(() => {
        _clearTicketBodyCacheForTests();
      });

      it('reuses the cached body for repeated calls within the TTL window', async () => {
        vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: cached body');
        vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
          '## Spec Quality Gate: PASS\n\n### Results\n| C | Result |\n|---|---|\n| X | PASS |',
        );

        await handleToolCall('spec_check', { ticketId: '42', projectDir: '/proj' });
        await handleToolCall('spec_check', { ticketId: '42', projectDir: '/proj' });

        expect(vi.mocked(fetchTicketWithConfig)).toHaveBeenCalledTimes(1);
      });

      it('refetches when the cache key differs (project or ticket)', async () => {
        vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: body');
        vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
          '## Spec Quality Gate: PASS\n\n### Results\n| C | Result |\n|---|---|\n| X | PASS |',
        );

        await handleToolCall('spec_check', { ticketId: '42', projectDir: '/proj' });
        await handleToolCall('spec_check', { ticketId: '43', projectDir: '/proj' });
        await handleToolCall('spec_check', { ticketId: '42', projectDir: '/other' });

        expect(vi.mocked(fetchTicketWithConfig)).toHaveBeenCalledTimes(3);
      });

      it('refetches after the TTL expires', async () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
          vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: body');
          vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
            '## Spec Quality Gate: PASS\n\n### Results\n| C | Result |\n|---|---|\n| X | PASS |',
          );

          await handleToolCall('spec_check', { ticketId: '42', projectDir: '/proj' });

          // Advance past the 30s TTL.
          vi.setSystemTime(new Date('2026-05-28T12:00:31Z'));

          await handleToolCall('spec_check', { ticketId: '42', projectDir: '/proj' });

          expect(vi.mocked(fetchTicketWithConfig)).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('spec_refine refinement prompt includes enhanced evaluation criteria', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: Test\nBody');
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
      expect(prompt).toContain('Dependency Contracts');
      expect(prompt).toContain('Replace resolved assumptions with verified facts');
    });
  });

  describe('spawnSpecRefine — process reuse across initial+answers (#370 item 5)', () => {
    let fakeHandle: EphemeralSessionHandle & {
      initialResolve: (text: string) => void;
      followUpResolve: (text: string) => void;
      disposeMock: ReturnType<typeof vi.fn>;
      sendFollowUpMock: ReturnType<typeof vi.fn>;
    };

    function makeFakeHandle(): typeof fakeHandle {
      let initialResolve!: (text: string) => void;
      let followUpResolve: ((text: string) => void) | null = null;
      const initialResult = new Promise<string>((res) => { initialResolve = res; });
      const sendFollowUpMock = vi.fn().mockImplementation((_prompt: string): Promise<string> => {
        return new Promise<string>((res) => { followUpResolve = res; });
      });
      const disposeMock = vi.fn();
      return {
        initialResult,
        sendFollowUp: sendFollowUpMock,
        dispose: disposeMock,
        initialResolve,
        followUpResolve: (text: string) => { followUpResolve?.(text); },
        disposeMock,
        sendFollowUpMock,
      };
    }

    beforeEach(() => {
      _disposeAllRefineSessionsForTests();
      _clearTicketBodyCacheForTests();
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: body');
      fakeHandle = makeFakeHandle();
      vi.mocked(agentBackend.spawnEphemeralSession).mockReturnValue(fakeHandle);
    });

    it('initial pass with FAIL pools the handle for reuse', async () => {
      const { promise } = spawnSpecRefine('42', '/proj');
      fakeHandle.initialResolve(
        '## Spec Quality Gate: FAIL\n\n### Questions Requiring User Answers\n1. What?',
      );
      const result = await promise as { passed: boolean; report: string };
      expect(result.passed).toBe(false);
      // Handle is still alive — pooled, not disposed.
      expect(fakeHandle.disposeMock).not.toHaveBeenCalled();
    });

    it('after-answers pass reuses the pooled handle via sendFollowUp', async () => {
      // Pool a session from the initial pass.
      const { promise: initial } = spawnSpecRefine('42', '/proj');
      fakeHandle.initialResolve('## Spec Quality Gate: FAIL\n\n### Questions\n1. What?');
      await initial;

      vi.mocked(updateTicketWithConfig).mockResolvedValue(undefined);

      // After-answers pass — must use the same handle, not spawn a new one.
      vi.mocked(agentBackend.spawnEphemeralAgent).mockClear();
      const { promise: followUp } = spawnSpecRefine('42', '/proj', 'Answer text');

      // Wait until sendFollowUp has actually been invoked, then resolve its result.
      await vi.waitFor(() => expect(fakeHandle.sendFollowUpMock).toHaveBeenCalledTimes(1));
      fakeHandle.followUpResolve(
        '## Updated Ticket Body\n\n# Issue: Updated\n\n## Spec Quality Gate: PASS\n\n### Results\n| C | R |\n|---|---|\n| X | PASS |',
      );
      await followUp;

      expect(vi.mocked(agentBackend.spawnEphemeralAgent)).not.toHaveBeenCalled();
      // After-answers pass disposes when done.
      expect(fakeHandle.disposeMock).toHaveBeenCalled();
    });

    it('initial pass with PASS disposes immediately (no follow-up expected)', async () => {
      const { promise } = spawnSpecRefine('42', '/proj');
      fakeHandle.initialResolve(
        '## Spec Quality Gate: PASS\n\n### Results\n| C | R |\n|---|---|\n| X | PASS |',
      );
      await promise;
      expect(fakeHandle.disposeMock).toHaveBeenCalled();
    });

    it('after-answers cold-starts via spawnEphemeralAgent when no pooled session exists', async () => {
      // No pool — simulate stale session / app restart by calling directly with answers.
      const coldEp = { promise: Promise.resolve('## Updated Ticket Body\n\n# Issue: Cold\n\n## Spec Quality Gate: PASS\n\n### Results\n| C | R |\n|---|---|\n| X | PASS |'), cancel: vi.fn() };
      vi.mocked(agentBackend.spawnEphemeralAgent).mockReturnValue(coldEp);
      vi.mocked(updateTicketWithConfig).mockResolvedValue(undefined);

      const { promise } = spawnSpecRefine('42', '/proj', 'Answer text');
      await promise;

      expect(vi.mocked(agentBackend.spawnEphemeralAgent)).toHaveBeenCalledTimes(1);
      // The pooled session machinery was never touched on this fallback path.
      expect(fakeHandle.sendFollowUpMock).not.toHaveBeenCalled();
    });

    it('cancel during the initial pass (after spawn) disposes the held handle', async () => {
      const { promise, cancel } = spawnSpecRefine('42', '/proj');
      // Wait until spawnEphemeralSession has actually been invoked.
      await vi.waitFor(() => expect(agentBackend.spawnEphemeralSession).toHaveBeenCalled());
      cancel();
      // Unblock the initial await so the cancellation path can finalize.
      fakeHandle.initialResolve('## Spec Quality Gate: FAIL\n\n### Questions\n1. What?');
      await expect(promise).rejects.toThrow('Cancelled');
      expect(fakeHandle.disposeMock).toHaveBeenCalled();
    });

    it('cancel during pooled follow-up disposes the session and rejects with Cancelled', async () => {
      // Establish a pooled session from the initial pass.
      const { promise: initial } = spawnSpecRefine('42', '/proj');
      fakeHandle.initialResolve('## Spec Quality Gate: FAIL\n\n### Questions\n1. What?');
      await initial;

      // Wire disposeMock to reject the pending sendFollowUp promise, mirroring
      // the real EphemeralSessionHandle.dispose() behavior.
      let rejectFollowUp!: (err: Error) => void;
      const pendingFollowUp = new Promise<string>((_, rej) => { rejectFollowUp = rej; });
      fakeHandle.sendFollowUpMock.mockReturnValue(pendingFollowUp);
      fakeHandle.disposeMock.mockImplementation(() => rejectFollowUp(new Error('Cancelled')));

      vi.mocked(updateTicketWithConfig).mockResolvedValue(undefined);

      const { promise: followUp, cancel } = spawnSpecRefine('42', '/proj', 'Answer text');

      await vi.waitFor(() => expect(fakeHandle.sendFollowUpMock).toHaveBeenCalled());
      cancel();

      await expect(followUp).rejects.toThrow('Cancelled');
      expect(fakeHandle.disposeMock).toHaveBeenCalled();
    });

    it('cancel during cold-fallback invokes epCancel and rejects with Cancelled', async () => {
      // No pooled session — simulate stale/app-restart scenario.
      let rejectEp!: (err: Error) => void;
      const ep = new Promise<string>((_, reject) => { rejectEp = reject; });
      const epCancelMock = vi.fn(() => rejectEp(new Error('Cancelled')));
      vi.mocked(agentBackend.spawnEphemeralAgent).mockReturnValue({ promise: ep, cancel: epCancelMock });
      vi.mocked(updateTicketWithConfig).mockResolvedValue(undefined);

      const { promise, cancel } = spawnSpecRefine('42', '/proj', 'Answer text');

      await vi.waitFor(() => expect(agentBackend.spawnEphemeralAgent).toHaveBeenCalled());
      cancel();

      await expect(promise).rejects.toThrow('Cancelled');
      expect(epCancelMock).toHaveBeenCalled();
    });
  });

  describe('spawnSpecCheck — cancel regression guard (#375)', () => {
    let cancelFn: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      _clearTicketBodyCacheForTests();
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: body');
      // The mock cancel function rejects the promise, mirroring real spawnEphemeralAgent behavior.
      let rejectEp!: (err: Error) => void;
      const ep = new Promise<string>((_, reject) => { rejectEp = reject; });
      cancelFn = vi.fn(() => rejectEp(new Error('Cancelled')));
      vi.mocked(agentBackend.spawnEphemeralAgent).mockReturnValue({ promise: ep, cancel: cancelFn });
    });

    it('cancel() propagates to the inner ephemeral agent and rejects with Cancelled', async () => {
      const { promise, cancel } = spawnSpecCheck('42', '/proj');

      await vi.waitFor(() => expect(agentBackend.spawnEphemeralAgent).toHaveBeenCalled());
      cancel();

      await expect(promise).rejects.toThrow('Cancelled');
      expect(cancelFn).toHaveBeenCalled();
    });

    it('spawnSpecCheck passes 0 as timeout to spawnEphemeralAgent (interactive, no ceiling)', async () => {
      spawnSpecCheck('42', '/proj');

      await vi.waitFor(() => expect(agentBackend.spawnEphemeralAgent).toHaveBeenCalled());
      const [, , timeoutArg] = vi.mocked(agentBackend.spawnEphemeralAgent).mock.calls[0];
      expect(timeoutArg).toBe(0);
    });

    it('spawnSpecCheck calls resolveTicketReferences with the ticket body', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: body with [ref](http://example.com)');
      vi.mocked(resolveTicketReferences).mockResolvedValue([{ url: 'http://example.com', kind: 'other', content: 'ref content' }]);
      vi.mocked(renderResolvedReferences).mockReturnValue('## External References\n\nref content');

      spawnSpecCheck('42', '/proj');
      await vi.waitFor(() => expect(agentBackend.spawnEphemeralAgent).toHaveBeenCalled());

      expect(resolveTicketReferences).toHaveBeenCalledWith('# Issue: body with [ref](http://example.com)');
    });

    it('spawnSpecCheck forwards renderResolvedReferences output to buildSpecCheckPrompt via spawnEphemeralAgent prompt', async () => {
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: body');
      vi.mocked(resolveTicketReferences).mockResolvedValue([{ url: 'http://example.com', kind: 'other', content: 'ref content' }]);
      vi.mocked(renderResolvedReferences).mockReturnValue('## External References\n\nref content');

      spawnSpecCheck('42', '/proj');
      await vi.waitFor(() => expect(agentBackend.spawnEphemeralAgent).toHaveBeenCalled());

      const [promptArg] = vi.mocked(agentBackend.spawnEphemeralAgent).mock.calls[0];
      expect(promptArg).toContain('## External References');
      expect(promptArg).toContain('ref content');
    });
  });

  // -------------------------------------------------------------------------
  // refine routing — touchpoint dispatch tests
  // -------------------------------------------------------------------------
  describe('refine routing — touchpoint dispatch', () => {
    beforeEach(() => {
      _clearTicketBodyCacheForTests();
      vi.mocked(fetchTicketWithConfig).mockResolvedValue('# Issue: T-99\nbody text');
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue('## Spec Quality Gate: PASS\nAll good.');
      vi.mocked(agentBackend.spawnEphemeralAgent).mockReturnValue({
        promise: Promise.resolve('## Spec Quality Gate: PASS'),
        cancel: vi.fn(),
      });
      vi.mocked(registry.getEffectiveTouchpointDescriptor).mockReturnValue({ backend: 'claude', provider: 'anthropic', model: 'sonnet', credentials: {} });
    });

    it('handleSpecCheck passes resolved model to runEphemeralAgent', async () => {
      await handleToolCall('spec_check', { ticketId: 'T-99', projectDir: '/proj' });

      const calls = vi.mocked(agentBackend.runEphemeralAgent).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[4]).toBe('sonnet'); // model resolved from refine touchpoint routing
      expect(lastCall[5]).toBe('refine'); // touchpoint always passed
    });

    it('spawnSpecCheck passes resolved model to spawnEphemeralAgent', async () => {
      spawnSpecCheck('T-99', '/proj');
      await vi.waitFor(() => expect(agentBackend.spawnEphemeralAgent).toHaveBeenCalled());

      const calls = vi.mocked(agentBackend.spawnEphemeralAgent).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[5]).toBe('sonnet'); // model resolved from refine touchpoint routing
      expect(lastCall[6]).toBe('refine'); // touchpoint always passed
    });

    it('handleSpecCheck forwards non-default descriptor.model to runEphemeralAgent', async () => {
      vi.mocked(registry.getEffectiveTouchpointDescriptor).mockReturnValue({
        backend: 'claude', provider: 'anthropic', model: 'claude-opus-4-8', credentials: {},
      });

      await handleToolCall('spec_check', { ticketId: 'T-99', projectDir: '/proj' });

      const calls = vi.mocked(agentBackend.runEphemeralAgent).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[4]).toBe('claude-opus-4-8');
    });

    it('shows needs_key notification and does NOT run agent when opencode backend has no credentials', async () => {
      const { showNotification } = await import('../../src/main/tray');
      vi.mocked(registry.getEffectiveTouchpointDescriptor).mockReturnValue({
        backend: 'opencode', provider: 'openai', model: 'gpt-4o', credentials: null,
      });

      const result = await handleToolCall('spec_check', { ticketId: 'T-99', projectDir: '/proj' });

      expect(vi.mocked(showNotification)).toHaveBeenCalledWith(
        'Refine blocked',
        expect.stringContaining('openai'),
      );
      expect(agentBackend.runEphemeralAgent).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'needs_key', backend: 'opencode', provider: 'openai' });
    });

    it('handleSpecRefine initial passes touchpoint "refine" to runEphemeralAgent', async () => {
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Spec Quality Gate: FAIL\n\n### Questions Requiring User Answers\n1. What?',
      );

      await handleToolCall('spec_refine', { ticketId: 'T-99', projectDir: '/proj' });

      const calls = vi.mocked(agentBackend.runEphemeralAgent).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[4]).toBeUndefined(); // model not passed
      expect(lastCall[5]).toBe('refine');
    });

    it('handleSpecRefine answer passes touchpoint "refine" to runEphemeralAgent', async () => {
      vi.mocked(agentBackend.runEphemeralAgent).mockResolvedValue(
        '## Updated Ticket Body\n\n# Issue: Updated\n\n## Spec Quality Gate: PASS\n\n### Results\n| C | R |\n|---|---|\n| X | PASS |',
      );
      vi.mocked(updateTicketWithConfig).mockResolvedValue(undefined);

      await handleToolCall('spec_refine', { ticketId: 'T-99', projectDir: '/proj', userAnswers: 'some answers' });

      const calls = vi.mocked(agentBackend.runEphemeralAgent).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[4]).toBeUndefined();
      expect(lastCall[5]).toBe('refine');
    });

    it('spawnSpecRefine cold fallback passes touchpoint "refine" to spawnEphemeralAgent', async () => {
      _disposeAllRefineSessionsForTests();
      vi.mocked(agentBackend.spawnEphemeralAgent).mockReturnValue({
        promise: Promise.resolve(
          '## Updated Ticket Body\n\n# Issue: Cold\n\n## Spec Quality Gate: PASS\n\n### Results\n| C | R |\n|---|---|\n| X | PASS |',
        ),
        cancel: vi.fn(),
      });
      vi.mocked(updateTicketWithConfig).mockResolvedValue(undefined);

      const { promise } = spawnSpecRefine('T-99', '/proj', 'Answer text');
      await promise;

      const calls = vi.mocked(agentBackend.spawnEphemeralAgent).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[5]).toBeUndefined(); // model not passed
      expect(lastCall[6]).toBe('refine');
    });
  });
});
