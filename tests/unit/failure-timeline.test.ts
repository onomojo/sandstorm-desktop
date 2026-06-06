import { describe, it, expect } from 'vitest';
import { buildFailureTimeline } from '../../src/main/control-plane/failure-timeline';
import type { Task } from '../../src/main/control-plane/registry';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    stack_id: 'test-stack',
    prompt: 'test prompt',
    model: null,
    resolved_model: null,
    status: 'failed',
    exit_code: 1,
    warnings: null,
    session_id: null,
    input_tokens: 0,
    output_tokens: 0,
    execution_input_tokens: 0,
    execution_output_tokens: 0,
    review_input_tokens: 0,
    review_output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    review_iterations: 2,
    verify_retries: 1,
    review_verdicts: null,
    verify_outputs: null,
    execute_outputs: null,
    execution_summary: null,
    needs_human_questions: null,
    execution_started_at: null,
    execution_finished_at: null,
    review_started_at: null,
    review_finished_at: null,
    verify_started_at: null,
    verify_finished_at: null,
    started_at: '2026-06-01T10:00:00Z',
    finished_at: '2026-06-01T10:30:00Z',
    resumed_at: null,
    ...overrides,
  };
}

describe('buildFailureTimeline', () => {
  it('returns empty timeline when all arrays are null', () => {
    const task = makeTask();
    expect(buildFailureTimeline(task)).toEqual([]);
  });

  it('builds execute + review pairs in iteration order', () => {
    const task = makeTask({
      execute_outputs: JSON.stringify([
        'EXECUTE_PASS\nSome output',
        'EXECUTE_FAIL\nError output',
      ]),
      review_verdicts: JSON.stringify([
        'REVIEW_PASS',
        'REVIEW_FAIL\nIssues found: missing tests',
      ]),
    });

    const timeline = buildFailureTimeline(task);
    expect(timeline).toHaveLength(4);

    expect(timeline[0]).toMatchObject({ iteration: 1, phase: 'execute', verdict: 'pass' });
    expect(timeline[1]).toMatchObject({ iteration: 1, phase: 'review', verdict: 'pass' });
    expect(timeline[2]).toMatchObject({ iteration: 2, phase: 'execute', verdict: 'fail' });
    expect(timeline[3]).toMatchObject({ iteration: 2, phase: 'review', verdict: 'fail' });
    expect(timeline[3].detail).toContain('Issues found');
  });

  it('appends verify entries after execute/review pairs', () => {
    const task = makeTask({
      review_verdicts: JSON.stringify(['REVIEW_PASS']),
      verify_outputs: JSON.stringify([
        'VERIFY_FAIL\nTests failed: 3 errors',
        'VERIFY_PASS',
      ]),
    });

    const timeline = buildFailureTimeline(task);
    const verifyEntries = timeline.filter((e) => e.phase === 'verify');
    expect(verifyEntries).toHaveLength(2);
    expect(verifyEntries[0]).toMatchObject({ iteration: 1, phase: 'verify', verdict: 'fail' });
    expect(verifyEntries[0].detail).toContain('Tests failed');
    expect(verifyEntries[1]).toMatchObject({ iteration: 2, phase: 'verify', verdict: 'pass' });
  });

  it('marks VERIFY_INFRA as fail with environmental note', () => {
    const task = makeTask({
      verify_outputs: JSON.stringify(['VERIFY_INFRA\nPermission denied on port 3000']),
    });

    const timeline = buildFailureTimeline(task);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ phase: 'verify', verdict: 'fail' });
    expect(timeline[0].detail).toContain('environmental');
    expect(timeline[0].detail).toContain('Permission denied');
  });

  it('tolerates absent execute_outputs — review entries still appear', () => {
    const task = makeTask({
      review_verdicts: JSON.stringify(['REVIEW_FAIL\nNeeds work', 'REVIEW_PASS']),
    });

    const timeline = buildFailureTimeline(task);
    // No execute entries since execute_outputs is null
    const reviews = timeline.filter((e) => e.phase === 'review');
    const executes = timeline.filter((e) => e.phase === 'execute');
    expect(reviews).toHaveLength(2);
    expect(executes).toHaveLength(0);
  });

  it('tolerates short execute_outputs (fewer than reviews)', () => {
    const task = makeTask({
      execute_outputs: JSON.stringify(['EXECUTE_PASS\nInitial run']),
      review_verdicts: JSON.stringify([
        'REVIEW_FAIL\nFirst review',
        'REVIEW_FAIL\nSecond review',
        'REVIEW_PASS',
      ]),
    });

    const timeline = buildFailureTimeline(task);
    // 1 execute entry + 3 review entries = 4
    expect(timeline).toHaveLength(4);
    expect(timeline.filter((e) => e.phase === 'execute')).toHaveLength(1);
    expect(timeline.filter((e) => e.phase === 'review')).toHaveLength(3);
  });

  it('does not throw on malformed JSON arrays', () => {
    const task = makeTask({
      execute_outputs: 'not-valid-json',
      review_verdicts: '{also:not-json}',
    });
    expect(() => buildFailureTimeline(task)).not.toThrow();
    expect(buildFailureTimeline(task)).toEqual([]);
  });

  it('extracts detail from lines after the verdict prefix', () => {
    const task = makeTask({
      review_verdicts: JSON.stringify([
        'REVIEW_FAIL\nLine 1\nLine 2\nLine 3',
      ]),
    });
    const [entry] = buildFailureTimeline(task);
    expect(entry.verdict).toBe('fail');
    expect(entry.detail).toBe('Line 1\nLine 2\nLine 3');
  });

  it('handles EXECUTE_FAIL correctly', () => {
    const task = makeTask({
      execute_outputs: JSON.stringify(['EXECUTE_FAIL\ncompile error']),
      review_verdicts: JSON.stringify([]),
    });
    const [entry] = buildFailureTimeline(task);
    expect(entry).toMatchObject({ phase: 'execute', verdict: 'fail' });
  });
});
