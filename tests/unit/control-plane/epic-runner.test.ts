import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EpicRunner,
  EpicRunnerDeps,
  EpicStatusSnapshot,
  StartEpicResult,
  computeArticulationPoints,
  computeRunnableSet,
  onBarrierReached,
  topologicalSort,
} from '../../../src/main/control-plane/epic-runner';
import type { EpicTask, ProjectTicketConfig, Stack } from '../../../src/main/control-plane/registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): ProjectTicketConfig {
  return { provider: 'github' };
}

type StackStatus =
  | 'building'
  | 'rebuilding'
  | 'up'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_human'
  | 'needs_key'
  | 'verify_blocked_environmental'
  | 'idle'
  | 'stopped'
  | 'pushed'
  | 'pr_created'
  | 'rate_limited'
  | 'session_paused';

function makeStack(ticket: string | null, status: StackStatus = 'running'): Stack {
  return {
    id: `stack-${ticket ?? 'none'}`,
    project: 'myproject',
    project_dir: '/project',
    ticket,
    branch: null,
    description: null,
    status,
    runtime: 'docker',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Stack;
}

function makeEpicTask(ticketId: string, done: 0 | 1 = 0): EpicTask {
  return {
    epic_id: 'epic-1',
    ticket_id: ticketId,
    role: 'build',
    origin: 'planned',
    crit_id: null,
    gap_cycles: 0,
    done,
  };
}

/**
 * Build a valid RunPlan body text for the given subtask IDs.
 * First task gets <!-- spine -->, last gets <!-- acceptance-gate -->.
 * Generates a linear chain: subtasks[0] --> subtasks[1] --> ...
 */
function makeEpicBody(epicId: string, subtasks: string[]): string {
  if (subtasks.length === 0) return '';

  const checks = subtasks.map((id, i) => {
    const spineTag = i === 0 ? ' <!-- spine -->' : '';
    const gateTag = i === subtasks.length - 1 ? ' <!-- acceptance-gate -->' : '';
    return `- [ ] #${id} · Task ${id}${spineTag}${gateTag}`;
  });

  const dagLines = subtasks
    .slice(0, -1)
    .map((id, i) => `#${id} --> #${subtasks[i + 1]}`);

  const dagBlock = dagLines.length > 0
    ? `\`\`\`dag\n${dagLines.join('\n')}\n\`\`\``
    : '```dag\n```';

  return [
    'Labels: epic',
    '## Subtasks',
    ...checks,
    '',
    dagBlock,
    '',
    '## Acceptance for the epic',
    `- [ ] Epic ${epicId} done <!-- crit:done -->`,
  ].join('\n');
}

/** Body with 'State: CLOSED' prefix so isClosed() returns true. */
function closedBody(ticketId: string): string {
  return `State: CLOSED\n\n# Ticket ${ticketId}\n\nSome description`;
}

function openBody(ticketId: string): string {
  return `State: OPEN\n\n# Ticket ${ticketId}\n\nSome description`;
}

function buildDeps(overrides: Partial<EpicRunnerDeps> = {}): EpicRunnerDeps {
  return {
    listStacks: vi.fn().mockReturnValue([]),
    getEpicTasks: vi.fn().mockReturnValue([]),
    upsertEpicRunState: vi.fn(),
    upsertEpicTask: vi.fn(),
    setEpicTaskDone: vi.fn(),
    getEpicRunState: vi.fn().mockReturnValue(null),
    getDarkFactoryEnabled: vi.fn().mockReturnValue(true),
    getEpicMaxParallelStacks: vi.fn().mockReturnValue(3),
    getProjectTicketConfig: vi.fn().mockReturnValue(makeConfig()),
    createStack: vi.fn().mockImplementation(({ name }: { name: string }) => makeStack(null)),
    dispatchTask: vi.fn().mockResolvedValue({ id: 1, stack_id: 'stack-1', status: 'queued' }),
    fetchTicketWithConfig: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure DAG helpers
// ---------------------------------------------------------------------------

describe('topologicalSort', () => {
  it('returns empty for no subtasks', () => {
    expect(topologicalSort([], [])).toEqual([]);
  });

  it('returns single node', () => {
    expect(topologicalSort(['a'], [])).toEqual(['a']);
  });

  it('orders a simple chain a→b→c', () => {
    const ids = ['c', 'b', 'a'];
    const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }];
    const result = topologicalSort(ids, edges);
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('c'));
  });

  it('handles diamond DAG (two independent paths)', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
    ];
    const result = topologicalSort(ids, edges);
    expect(result[0]).toBe('a');
    expect(result[result.length - 1]).toBe('d');
  });

  it('handles independent nodes (no edges)', () => {
    const ids = ['x', 'y', 'z'];
    const result = topologicalSort(ids, []);
    expect(result).toHaveLength(3);
    expect(result).toContain('x');
    expect(result).toContain('y');
    expect(result).toContain('z');
  });
});

describe('computeArticulationPoints', () => {
  it('returns empty set for no nodes', () => {
    expect(computeArticulationPoints([], [])).toEqual(new Set());
  });

  it('returns empty set for single node', () => {
    expect(computeArticulationPoints(['a'], [])).toEqual(new Set());
  });

  it('returns no APs for a graph with two nodes no edges', () => {
    expect(computeArticulationPoints(['a', 'b'], [])).toEqual(new Set());
  });

  it('identifies the bridge node in a chain a-b-c', () => {
    // a-b-c: removing b disconnects a from c
    const aps = computeArticulationPoints(
      ['a', 'b', 'c'],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    );
    expect(aps.has('b')).toBe(true);
    expect(aps.has('a')).toBe(false);
    expect(aps.has('c')).toBe(false);
  });

  it('finds no AP in a complete triangle (all nodes equally connected)', () => {
    const aps = computeArticulationPoints(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'a', to: 'c' },
      ],
    );
    expect(aps.size).toBe(0);
  });

  it('identifies the single required node in a star topology', () => {
    // center connects to a, b, c — removing center disconnects everything
    const aps = computeArticulationPoints(
      ['center', 'a', 'b', 'c'],
      [
        { from: 'center', to: 'a' },
        { from: 'center', to: 'b' },
        { from: 'center', to: 'c' },
      ],
    );
    expect(aps.has('center')).toBe(true);
  });

  it('handles disconnected subgraphs without error', () => {
    // Two separate chains: a-b and c-d
    const aps = computeArticulationPoints(
      ['a', 'b', 'c', 'd'],
      [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }],
    );
    // b is AP of chain a-b if we consider the whole graph — actually not, since each
    // is its own component.  Neither chain has an AP (2-node chain endpoints aren't APs).
    expect(aps.has('a')).toBe(false);
    expect(aps.has('b')).toBe(false);
  });
});

describe('computeRunnableSet', () => {
  it('returns all tasks when no edges and none done', () => {
    expect(computeRunnableSet(['a', 'b'], [], new Set())).toEqual(['a', 'b']);
  });

  it('excludes done tasks', () => {
    const result = computeRunnableSet(['a', 'b'], [], new Set(['a']));
    expect(result).toEqual(['b']);
  });

  it('returns only tasks whose predecessors are done', () => {
    // a→b: b is runnable only when a is done
    const noneResult = computeRunnableSet(
      ['a', 'b'],
      [{ from: 'a', to: 'b' }],
      new Set(),
    );
    expect(noneResult).toEqual(['a']);

    const aResult = computeRunnableSet(
      ['a', 'b'],
      [{ from: 'a', to: 'b' }],
      new Set(['a']),
    );
    expect(aResult).toEqual(['b']);
  });

  it('handles diamond: both b and c runnable when a done', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
    ];
    const doneA = new Set(['a']);
    const result = computeRunnableSet(['a', 'b', 'c', 'd'], edges, doneA);
    expect(result).toContain('b');
    expect(result).toContain('c');
    expect(result).not.toContain('a');
    expect(result).not.toContain('d');
  });
});

// ---------------------------------------------------------------------------
// onBarrierReached hook
// ---------------------------------------------------------------------------

describe('onBarrierReached', () => {
  it('resolves without throwing (no-op hook)', async () => {
    await expect(onBarrierReached('epic-1', 'ticket-42')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EpicRunner — startEpic
// ---------------------------------------------------------------------------

describe('EpicRunner.startEpic', () => {
  let deps: EpicRunnerDeps;
  let runner: EpicRunner;

  beforeEach(() => {
    deps = buildDeps();
    runner = new EpicRunner(deps);
  });

  it('returns { already: true } when epic is already in-flight (in-memory guard)', async () => {
    // Set up a valid epic so first startEpic succeeds
    const epicBody = makeEpicBody('epic-1', ['101']);
    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody) // for epic ticket
      .mockResolvedValueOnce(openBody('101')); // for subtask seeding

    await runner.startEpic('epic-1', '/project');

    // Second call: same epic
    const result = await runner.startEpic('epic-1', '/project');
    expect(result).toEqual({ already: true });
  });

  it('returns { already: true } when persisted state is running (cross-session guard)', async () => {
    // Fresh runner instance — no in-memory activeEpics — but persisted state says running
    vi.mocked(deps.getEpicRunState).mockReturnValue({
      epic_id: 'epic-1',
      project_dir: '/project',
      status: 'running',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const result = await runner.startEpic('epic-1', '/project');
    expect(result).toEqual({ already: true });
    // Should short-circuit before fetching the ticket
    expect(deps.fetchTicketWithConfig).not.toHaveBeenCalled();
  });

  it('returns { runnable: false } when ticket config is missing', async () => {
    vi.mocked(deps.getProjectTicketConfig).mockReturnValue(null);
    const result = await runner.startEpic('epic-1', '/project');
    expect(result).toMatchObject({ runnable: false });
  });

  it('returns { runnable: false } when epic ticket fetch returns null', async () => {
    vi.mocked(deps.fetchTicketWithConfig).mockResolvedValue(null);
    const result = await runner.startEpic('epic-1', '/project');
    expect(result).toMatchObject({ runnable: false });
  });

  it('returns { runnable: false } when ticket is not labeled as epic', async () => {
    const nonEpicBody = 'Labels: bug, feature\n\n## Some content\nNot an epic';
    vi.mocked(deps.fetchTicketWithConfig).mockResolvedValue(nonEpicBody);
    const result = await runner.startEpic('epic-1', '/project');
    expect(result).toMatchObject({ runnable: false, reasons: ['Not an epic ticket'] });
  });

  it('returns { ok: true, snapshot } on successful start', async () => {
    const epicBody = makeEpicBody('epic-1', ['101', '102']);
    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)
      .mockResolvedValue(openBody('any'));

    const result = await runner.startEpic('epic-1', '/project') as { ok: true; snapshot: EpicStatusSnapshot };
    expect(result.ok).toBe(true);
    expect(result.snapshot.epicId).toBe('epic-1');
    expect(result.snapshot.status).toBe('running');
  });

  it('registers epic run state as running', async () => {
    const epicBody = makeEpicBody('epic-1', ['101']);
    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)
      .mockResolvedValue(openBody('101'));

    await runner.startEpic('epic-1', '/project');
    expect(deps.upsertEpicRunState).toHaveBeenCalledWith('epic-1', '/project', 'running');
  });

  it('upserts all subtasks into registry', async () => {
    const epicBody = makeEpicBody('epic-1', ['101', '102', '103']);
    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)
      .mockResolvedValue(openBody('any'));

    await runner.startEpic('epic-1', '/project');
    expect(deps.upsertEpicTask).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// EpicRunner — cold-start seeding
// ---------------------------------------------------------------------------

describe('EpicRunner — cold-start seeding', () => {
  it('marks CLOSED subtasks done during startEpic', async () => {
    const deps = buildDeps();
    const runner = new EpicRunner(deps);
    const epicBody = makeEpicBody('epic-1', ['101', '102']);

    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody) // epic body
      .mockResolvedValueOnce(closedBody('101')) // 101 is CLOSED
      .mockResolvedValueOnce(openBody('102')); // 102 is OPEN

    await runner.startEpic('epic-1', '/project');

    expect(deps.setEpicTaskDone).toHaveBeenCalledWith('epic-1', '101');
    expect(deps.setEpicTaskDone).not.toHaveBeenCalledWith('epic-1', '102');
  });

  it('does not re-fetch tickets already marked done in registry', async () => {
    const deps = buildDeps({
      getEpicTasks: vi.fn().mockReturnValue([makeEpicTask('101', 1)]),
    });
    const runner = new EpicRunner(deps);
    const epicBody = makeEpicBody('epic-1', ['101', '102']);

    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody) // epic body
      .mockResolvedValue(openBody('any'));

    await runner.startEpic('epic-1', '/project');

    // 101 is already done — should not be re-fetched (no setEpicTaskDone for it)
    expect(deps.setEpicTaskDone).not.toHaveBeenCalledWith('epic-1', '101');
  });
});

// ---------------------------------------------------------------------------
// EpicRunner — dispatch & adoption
// ---------------------------------------------------------------------------

describe('EpicRunner — dispatch', () => {
  it('calls createStack and dispatchTask for runnable subtask', async () => {
    const deps = buildDeps();
    const runner = new EpicRunner(deps);
    const epicBody = makeEpicBody('epic-1', ['101']);

    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)
      .mockResolvedValue(openBody('101'));

    await runner.startEpic('epic-1', '/project');

    expect(deps.createStack).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: '101', gateApproved: true, runtime: 'docker' }),
    );
    expect(deps.dispatchTask).toHaveBeenCalled();
  });

  it('skips dispatch when a live stack already works the ticket (adoption)', async () => {
    const deps = buildDeps({
      listStacks: vi.fn().mockReturnValue([makeStack('101', 'running')]),
    });
    const runner = new EpicRunner(deps);
    const epicBody = makeEpicBody('epic-1', ['101']);

    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)
      .mockResolvedValue(openBody('101'));

    await runner.startEpic('epic-1', '/project');

    // Adopted — should NOT create another stack
    expect(deps.createStack).not.toHaveBeenCalled();
  });

  it('respects concurrency cap (cap=1, two runnable tasks → dispatches only 1)', async () => {
    const deps = buildDeps({
      getEpicMaxParallelStacks: vi.fn().mockReturnValue(1),
    });
    const runner = new EpicRunner(deps);
    // Build a body with two independent root tasks (no dag edges) so both are
    // runnable at startup — the cap should limit dispatch to exactly one.
    const epicBody = [
      'Labels: epic',
      '## Subtasks',
      '- [ ] #101 · Task 101 <!-- spine -->',
      '- [ ] #102 · Task 102 <!-- acceptance-gate -->',
      '',
      '```dag',
      '```',
      '',
      '## Acceptance for the epic',
      '- [ ] Epic epic-1 done <!-- crit:done -->',
    ].join('\n');

    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)
      .mockResolvedValue(openBody('any'));

    await runner.startEpic('epic-1', '/project');

    expect(deps.createStack).toHaveBeenCalledTimes(1);
    expect(deps.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it('coerces cap < 1 to 1', async () => {
    const deps = buildDeps({
      getEpicMaxParallelStacks: vi.fn().mockReturnValue(0),
    });
    const runner = new EpicRunner(deps);
    const epicBody = makeEpicBody('epic-1', ['101']);

    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)
      .mockResolvedValue(openBody('101'));

    await runner.startEpic('epic-1', '/project');

    expect(deps.createStack).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// EpicRunner — one-way done latch
// ---------------------------------------------------------------------------

describe('EpicRunner — one-way done latch', () => {
  it('does not re-dispatch a ticket that was marked done, even if it appears runnable', async () => {
    // Task 101 is done in registry; 102 has 101 as predecessor (chain: 101→102).
    // After startEpic: doneSet={'101'}, runnable=['102'], so only 102 is dispatched.
    const deps = buildDeps({
      getEpicTasks: vi.fn().mockReturnValue([
        makeEpicTask('101', 1), // already done
        makeEpicTask('102', 0),
      ]),
    });
    const runner = new EpicRunner(deps);

    // Valid epic body: 101→102 chain; 101 already done so 102 is the only runnable task.
    const epicBody = makeEpicBody('epic-1', ['101', '102']);

    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody) // epic body
      .mockResolvedValue(openBody('any')); // seed 102, one-way-latch 101, dispatch 102

    await runner.startEpic('epic-1', '/project');

    // 101 is in doneSet — computeRunnableSet excludes it, so createStack is never called for 101
    const createCalls = vi.mocked(deps.createStack).mock.calls;
    const ticketsCreated = createCalls.map((c) => c[0].ticket);
    expect(ticketsCreated).not.toContain('101');
  });

  it('logs warning but skips re-dispatch for done tickets that appear in runnable set', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Manually set up scenario: task is done (done=1) but dispatchSubtask is called for it
    // We simulate this by having the task already done AND then trying to start the epic fresh
    const deps = buildDeps({
      getEpicTasks: vi.fn().mockReturnValue([makeEpicTask('101', 1)]),
    });
    const runner = new EpicRunner(deps);
    const epicBody = makeEpicBody('epic-1', ['101']);

    // Epic body shows 101 as an open subtask, but registry says it's done
    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)
      // For cold-start seeding: already done, so skipped
      .mockResolvedValue(openBody('101')); // subtask body returns OPEN even though done in DB

    await runner.startEpic('epic-1', '/project');

    // 101 is in doneSet (from registry), so computeRunnableSet excludes it.
    // No dispatch should happen.
    expect(deps.createStack).not.toHaveBeenCalled();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('one-way latch'));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// EpicRunner — barrier detection
// ---------------------------------------------------------------------------

describe('EpicRunner — barrier detection', () => {
  it('does not dispatch barrier task when in-flight stacks exist', async () => {
    // Chain: 101 → 102 (barrier/AP) → 103
    // 101 is DONE but its stack is still running (not terminal).
    // advanceEpic sees doneSet={'101'}, runnable=['102'], inFlightCount=1 (running stack for 101).
    // Because 102 is an articulation point and inFlightCount > 0, barrier drain triggers —
    // 102 must NOT be dispatched until the in-flight stack settles.
    const deps = buildDeps({
      listStacks: vi.fn().mockReturnValue([makeStack('101', 'running')]),
      getEpicTasks: vi.fn().mockReturnValue([
        makeEpicTask('101', 1), // DONE — so 102 enters runnable set
        makeEpicTask('102', 0),
        makeEpicTask('103', 0),
      ]),
    });
    const runner = new EpicRunner(deps);

    const epicBody = makeEpicBody('epic-1', ['101', '102', '103']); // chain 101→102→103
    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody) // epic body
      .mockResolvedValue(openBody('any')); // seed 102/103, one-way-latch 101

    await runner.startEpic('epic-1', '/project');

    // 102 is an AP and in-flight count > 0 — barrier drain must block its dispatch
    const ticketsCreated = vi.mocked(deps.createStack).mock.calls.map((c) => c[0].ticket);
    expect(ticketsCreated).not.toContain('102');
  });
});

// ---------------------------------------------------------------------------
// EpicRunner — getRunPlan (parse-only dry run)
// ---------------------------------------------------------------------------

describe('EpicRunner.getRunPlan', () => {
  it('returns parsed RunPlan without writing state', async () => {
    const deps = buildDeps();
    const runner = new EpicRunner(deps);
    const epicBody = makeEpicBody('epic-1', ['101', '102']);
    vi.mocked(deps.fetchTicketWithConfig).mockResolvedValue(epicBody);

    const plan = await runner.getRunPlan('epic-1', '/project');

    expect(plan).not.toBeNull();
    expect(plan!.epicId).toBe('epic-1');
    expect(deps.upsertEpicRunState).not.toHaveBeenCalled();
    expect(deps.upsertEpicTask).not.toHaveBeenCalled();
    expect(deps.setEpicTaskDone).not.toHaveBeenCalled();
    expect(deps.createStack).not.toHaveBeenCalled();
    expect(deps.dispatchTask).not.toHaveBeenCalled();
  });

  it('returns null when ticket config is absent', async () => {
    const deps = buildDeps({ getProjectTicketConfig: vi.fn().mockReturnValue(null) });
    const runner = new EpicRunner(deps);
    const plan = await runner.getRunPlan('epic-1', '/project');
    expect(plan).toBeNull();
  });

  it('returns null when fetch returns null', async () => {
    const deps = buildDeps();
    const runner = new EpicRunner(deps);
    vi.mocked(deps.fetchTicketWithConfig).mockResolvedValue(null);
    const plan = await runner.getRunPlan('epic-1', '/project');
    expect(plan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EpicRunner — status snapshot
// ---------------------------------------------------------------------------

describe('EpicRunner — status snapshot', () => {
  it('emits snapshot via setOnStatusUpdate callback', async () => {
    const deps = buildDeps();
    const runner = new EpicRunner(deps);
    const onStatus = vi.fn<[string, EpicStatusSnapshot], void>();
    runner.setOnStatusUpdate(onStatus);

    const epicBody = makeEpicBody('epic-1', ['101']);
    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)
      .mockResolvedValue(openBody('101'));

    await runner.startEpic('epic-1', '/project');

    expect(onStatus).toHaveBeenCalled();
    const [epicId, snapshot] = onStatus.mock.calls[0];
    expect(epicId).toBe('epic-1');
    expect(snapshot.subtasks).toHaveLength(1);
    expect(snapshot.subtasks[0].ticketId).toBe('101');
  });

  it('marks epic completed when all subtasks are done', async () => {
    const deps = buildDeps({
      // All tasks already done in registry
      getEpicTasks: vi.fn().mockReturnValue([makeEpicTask('101', 1)]),
    });
    const runner = new EpicRunner(deps);
    const onStatus = vi.fn<[string, EpicStatusSnapshot], void>();
    runner.setOnStatusUpdate(onStatus);

    const epicBody = makeEpicBody('epic-1', ['101']);
    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)
      .mockResolvedValue(closedBody('101')); // CLOSED

    await runner.startEpic('epic-1', '/project');

    expect(deps.upsertEpicRunState).toHaveBeenCalledWith('epic-1', '/project', 'completed');
  });
});

// ---------------------------------------------------------------------------
// EpicRunner — onAnyStackUpdated
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EpicRunner — dark factory governance
// ---------------------------------------------------------------------------

describe('EpicRunner — dark factory governance', () => {
  it('skips markNewlyClosedTasks when dark factory is disabled (pause at merge)', async () => {
    // Setup: 101 has TWO stacks — one running (in-flight, prevents re-dispatch) and one
    // completed (terminal, candidate for markNewlyClosedTasks).
    // Cold-start seeding fetches 101 as OPEN → not marked done.
    // With dark factory OFF: markNewlyClosedTasks must be skipped, so the 3rd fetch for
    // 101 (the one that would detect CLOSED) must NOT happen.
    const deps = buildDeps({
      getDarkFactoryEnabled: vi.fn().mockReturnValue(false),
      listStacks: vi.fn().mockReturnValue([
        makeStack('101', 'running'),   // in-flight — prevents re-dispatch
        makeStack('101', 'completed'), // terminal — markNewlyClosedTasks candidate
      ]),
      getEpicTasks: vi.fn().mockReturnValue([makeEpicTask('101', 0)]),
    });
    const runner = new EpicRunner(deps);
    const epicBody = makeEpicBody('epic-1', ['101']);

    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)      // call 1: epic body
      .mockResolvedValueOnce(openBody('101')); // call 2: cold-start seeding → OPEN, not marked done

    await runner.startEpic('epic-1', '/project');

    // With dark factory OFF, markNewlyClosedTasks is skipped.
    // Only 2 fetches should occur: epic body + cold-start seeding.
    // A 3rd fetch (markNewlyClosedTasks re-fetching 101) must NOT happen.
    expect(vi.mocked(deps.fetchTicketWithConfig)).toHaveBeenCalledTimes(2);
    expect(deps.setEpicTaskDone).not.toHaveBeenCalled();
  });

  it('runs markNewlyClosedTasks when dark factory is enabled (auto-advance)', async () => {
    // Same setup but dark factory ON → markNewlyClosedTasks runs and detects 101 CLOSED.
    const deps = buildDeps({
      getDarkFactoryEnabled: vi.fn().mockReturnValue(true),
      listStacks: vi.fn().mockReturnValue([
        makeStack('101', 'running'),   // in-flight — prevents re-dispatch
        makeStack('101', 'completed'), // terminal — markNewlyClosedTasks candidate
      ]),
      getEpicTasks: vi.fn().mockReturnValue([makeEpicTask('101', 0)]),
    });
    const runner = new EpicRunner(deps);
    const epicBody = makeEpicBody('epic-1', ['101']);

    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)        // call 1: epic body
      .mockResolvedValueOnce(openBody('101')) // call 2: cold-start seeding → OPEN
      .mockResolvedValueOnce(closedBody('101')); // call 3: markNewlyClosedTasks → CLOSED

    await runner.startEpic('epic-1', '/project');

    // Dark factory ON: markNewlyClosedTasks ran, detected 101 CLOSED, marked done.
    expect(deps.setEpicTaskDone).toHaveBeenCalledWith('epic-1', '101');
    expect(vi.mocked(deps.fetchTicketWithConfig)).toHaveBeenCalledTimes(3);
  });
});

describe('EpicRunner.onAnyStackUpdated', () => {
  it('does nothing when no epics are active', async () => {
    const deps = buildDeps();
    const runner = new EpicRunner(deps);
    await expect(runner.onAnyStackUpdated()).resolves.toBeUndefined();
    expect(deps.fetchTicketWithConfig).not.toHaveBeenCalled();
  });

  it('advances active epics when stacks update', async () => {
    const deps = buildDeps();
    const runner = new EpicRunner(deps);

    const epicBody = makeEpicBody('epic-1', ['101', '102']);
    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValue(openBody('any'));

    // Manually inject the epic as active (bypass full startEpic for simplicity)
    // We do this by actually starting it with minimal fixture
    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody) // epic body for startEpic
      .mockResolvedValue(openBody('any'));

    await runner.startEpic('epic-1', '/project');
    vi.mocked(deps.fetchTicketWithConfig).mockResolvedValue(epicBody);

    // After startEpic, onAnyStackUpdated should trigger re-evaluation
    await runner.onAnyStackUpdated();
    // Just verify it doesn't throw and calls fetchTicketWithConfig for the epic
    expect(deps.fetchTicketWithConfig).toHaveBeenCalled();
  });

  it('does not mark epic completed when advanceEpicFromRegistry gets a non-runnable plan', async () => {
    // Start with a valid epic body so startEpic succeeds and registers epic as active.
    const deps = buildDeps();
    const runner = new EpicRunner(deps);
    const epicBody = makeEpicBody('epic-1', ['101']);

    vi.mocked(deps.fetchTicketWithConfig)
      .mockResolvedValueOnce(epicBody)    // startEpic: epic body
      .mockResolvedValueOnce(openBody('101')); // startEpic: cold-start seed

    await runner.startEpic('epic-1', '/project');
    vi.mocked(deps.upsertEpicRunState).mockClear();

    // On the next poll (onAnyStackUpdated), the re-fetch returns a non-runnable body
    // (empty string → parseEpicBody returns { runnable: false, ... }).
    // advanceEpicFromRegistry must return early and never call advanceEpic.
    vi.mocked(deps.fetchTicketWithConfig).mockResolvedValueOnce('');

    await runner.onAnyStackUpdated();

    expect(deps.upsertEpicRunState).not.toHaveBeenCalledWith('epic-1', '/project', 'completed');
  });
});
