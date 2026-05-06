/**
 * @vitest-environment jsdom
 *
 * UI regression: after startup reconciliation changes a stack from
 * `running` → `completed`, the "Make PR" button must become visible
 * without any manual user action.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { StackCard } from '../../../src/renderer/components/StackCard';
import { useAppStore, Stack } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeStack(overrides: Partial<Stack> = {}): Stack {
  return {
    id: 'reconcile-test-stack',
    project: 'proj',
    project_dir: '/proj',
    ticket: null,
    branch: null,
    description: null,
    status: 'running',
    error: null,
    pr_url: null,
    pr_number: null,
    runtime: 'docker',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_execution_input_tokens: 0,
    total_execution_output_tokens: 0,
    total_review_input_tokens: 0,
    total_review_output_tokens: 0,
    rate_limit_reset_at: null,
    current_model: null,
    services: [],
    ...overrides,
  };
}

describe('Reconciliation UI — Make PR button visibility', () => {
  beforeEach(() => {
    mockSandstormApi();
    useAppStore.setState({ stacks: [], selectedStackId: null });
  });

  it('does not show Make PR button for a running stack', () => {
    const stack = makeStack({ status: 'running' });
    render(<StackCard stack={stack} />);
    expect(screen.queryByTestId(`card-make-pr-${stack.id}`)).toBeNull();
  });

  it('shows Make PR button for a completed stack', () => {
    const stack = makeStack({ status: 'completed' });
    render(<StackCard stack={stack} />);
    expect(screen.getByTestId(`card-make-pr-${stack.id}`)).toBeDefined();
  });

  it('Make PR button becomes visible after reconciliation changes status from running to completed', () => {
    const stack = makeStack({ status: 'running' });
    const { rerender } = render(<StackCard stack={stack} />);

    // Initially hidden — stack is running
    expect(screen.queryByTestId(`card-make-pr-${stack.id}`)).toBeNull();

    // Simulate reconciliation completing: status flips to completed
    const reconciledStack = makeStack({ status: 'completed' });
    act(() => {
      rerender(<StackCard stack={reconciledStack} />);
    });

    // Button must now be visible without any manual user action
    expect(screen.getByTestId(`card-make-pr-${stack.id}`)).toBeDefined();
  });
});
