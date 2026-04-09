/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { WorkflowProgressPanel } from '../../../src/renderer/components/WorkflowProgress';
import { WorkflowProgress } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeProgress(overrides: Partial<WorkflowProgress> = {}): WorkflowProgress {
  return {
    stackId: 'test-stack',
    currentPhase: 'execution',
    outerIteration: 1,
    innerIteration: 1,
    phases: [
      { phase: 'execution', status: 'running' },
      { phase: 'review', status: 'pending' },
      { phase: 'verify', status: 'pending' },
    ],
    steps: [
      { phase: 'execution', iteration: 1, input_tokens: 5000, output_tokens: 2000, live: true },
    ],
    taskPrompt: 'Fix the login bug',
    startedAt: new Date().toISOString(),
    model: 'sonnet',
    ...overrides,
  };
}

describe('WorkflowProgressPanel', () => {
  beforeEach(() => {
    mockSandstormApi();
  });

  it('renders the workflow progress panel', () => {
    render(<WorkflowProgressPanel progress={makeProgress()} />);
    expect(screen.getByTestId('workflow-progress-panel')).toBeDefined();
  });

  it('displays loop counters', () => {
    render(<WorkflowProgressPanel progress={makeProgress({ outerIteration: 2, innerIteration: 3 })} />);
    expect(screen.getByTestId('outer-loop-counter').textContent).toBe('2 of 5');
    expect(screen.getByTestId('inner-loop-counter').textContent).toBe('3 of 5');
  });

  it('shows execution phase as running', () => {
    render(<WorkflowProgressPanel progress={makeProgress()} />);
    const executionPhase = screen.getByTestId('phase-execution');
    expect(executionPhase.textContent).toContain('Execution');
    expect(executionPhase.textContent).toContain('running');
  });

  it('shows review phase as passed', () => {
    const progress = makeProgress({
      currentPhase: 'verify',
      phases: [
        { phase: 'execution', status: 'passed' },
        { phase: 'review', status: 'passed' },
        { phase: 'verify', status: 'running' },
      ],
    });
    render(<WorkflowProgressPanel progress={progress} />);
    const reviewPhase = screen.getByTestId('phase-review');
    expect(reviewPhase.textContent).toContain('Review');
    expect(reviewPhase.textContent).toContain('\u2713');
  });

  it('shows verify phase as failed', () => {
    const progress = makeProgress({
      currentPhase: 'execution',
      outerIteration: 2,
      phases: [
        { phase: 'execution', status: 'running' },
        { phase: 'review', status: 'pending' },
        { phase: 'verify', status: 'failed' },
      ],
    });
    render(<WorkflowProgressPanel progress={progress} />);
    const verifyPhase = screen.getByTestId('phase-verify');
    expect(verifyPhase.textContent).toContain('Verify');
    expect(verifyPhase.textContent).toContain('\u2717');
  });

  it('renders step token table with live indicator', () => {
    const progress = makeProgress({
      steps: [
        { phase: 'execution', iteration: 1, input_tokens: 45200, output_tokens: 12100, live: false },
        { phase: 'review', iteration: 1, input_tokens: 38700, output_tokens: 8400, live: false },
        { phase: 'execution', iteration: 2, input_tokens: 52100, output_tokens: 15300, live: true },
      ],
    });
    render(<WorkflowProgressPanel progress={progress} />);
    const table = screen.getByTestId('step-token-table');
    expect(table.textContent).toContain('execution 1');
    expect(table.textContent).toContain('review 1');
    expect(table.textContent).toContain('execution 2');
    // Live indicator (▲)
    expect(table.textContent).toContain('\u25B2');
    // Total row
    expect(table.textContent).toContain('Total');
  });

  it('shows task prompt in bottom bar', () => {
    render(<WorkflowProgressPanel progress={makeProgress({ taskPrompt: 'Refactor auth handler' })} />);
    expect(screen.getByText(/Refactor auth handler/)).toBeDefined();
  });

  it('shows model name', () => {
    render(<WorkflowProgressPanel progress={makeProgress({ model: 'opus' })} />);
    expect(screen.getByText('Model: opus')).toBeDefined();
  });

  it('renders all three phase boxes', () => {
    render(<WorkflowProgressPanel progress={makeProgress()} />);
    expect(screen.getByTestId('phase-execution')).toBeDefined();
    expect(screen.getByTestId('phase-review')).toBeDefined();
    expect(screen.getByTestId('phase-verify')).toBeDefined();
  });

  it('shows idle state when no task has been dispatched', () => {
    const idleProgress = makeProgress({
      currentPhase: 'idle',
      outerIteration: 0,
      innerIteration: 0,
      phases: [
        { phase: 'execution', status: 'pending' },
        { phase: 'review', status: 'pending' },
        { phase: 'verify', status: 'pending' },
      ],
      steps: [],
      taskPrompt: null,
      startedAt: null,
      model: null,
    });
    render(<WorkflowProgressPanel progress={idleProgress} />);
    expect(screen.getByTestId('workflow-idle-label')).toBeDefined();
    expect(screen.getByTestId('workflow-idle-label').textContent).toBe('No task dispatched yet');
    // Should not show loop counters
    expect(screen.queryByTestId('outer-loop-counter')).toBeNull();
    expect(screen.queryByTestId('inner-loop-counter')).toBeNull();
  });

  it('shows completed state with all phases passed', () => {
    const completedProgress = makeProgress({
      currentPhase: 'idle',
      outerIteration: 1,
      innerIteration: 2,
      phases: [
        { phase: 'execution', status: 'passed' },
        { phase: 'review', status: 'passed' },
        { phase: 'verify', status: 'passed' },
      ],
      steps: [
        { phase: 'execution', iteration: 1, input_tokens: 5000, output_tokens: 2000, live: false },
        { phase: 'review', iteration: 1, input_tokens: 3000, output_tokens: 1000, live: false },
        { phase: 'verify', iteration: 1, input_tokens: 1000, output_tokens: 500, live: false },
      ],
      taskPrompt: 'Fix bug',
      startedAt: new Date().toISOString(),
      model: 'sonnet',
    });
    render(<WorkflowProgressPanel progress={completedProgress} />);

    // All phases should show checkmarks
    expect(screen.getByTestId('phase-execution').textContent).toContain('\u2713');
    expect(screen.getByTestId('phase-review').textContent).toContain('\u2713');
    expect(screen.getByTestId('phase-verify').textContent).toContain('\u2713');

    // Loop counters should still be visible
    expect(screen.getByTestId('outer-loop-counter').textContent).toBe('1 of 5');
  });

  it('does not show bottom info bar when no task data exists', () => {
    const idleProgress = makeProgress({
      currentPhase: 'idle',
      outerIteration: 0,
      innerIteration: 0,
      phases: [
        { phase: 'execution', status: 'pending' },
        { phase: 'review', status: 'pending' },
        { phase: 'verify', status: 'pending' },
      ],
      steps: [],
      taskPrompt: null,
      startedAt: null,
      model: null,
    });
    render(<WorkflowProgressPanel progress={idleProgress} />);
    // Should not render the bottom info bar
    expect(screen.queryByText(/Task:/)).toBeNull();
    expect(screen.queryByText(/Started:/)).toBeNull();
    expect(screen.queryByText(/Model:/)).toBeNull();
  });

  it('calculates token totals correctly', () => {
    const progress = makeProgress({
      steps: [
        { phase: 'execution', iteration: 1, input_tokens: 1000, output_tokens: 500, live: false },
        { phase: 'review', iteration: 1, input_tokens: 2000, output_tokens: 800, live: false },
      ],
    });
    render(<WorkflowProgressPanel progress={progress} />);
    const table = screen.getByTestId('step-token-table');
    // Total input: 3000 = 3.0k, Total output: 1300 = 1.3k
    expect(table.textContent).toContain('3.0k');
    expect(table.textContent).toContain('1.3k');
  });
});
