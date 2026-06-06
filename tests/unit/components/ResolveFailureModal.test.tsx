/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { ResolveFailureModal } from '../../../src/renderer/components/ResolveFailureModal';
import { mockSandstormApi } from './setup';
import type { Stack, FailureDiagnosis } from '../../../src/renderer/store';

function makeFailedStack(overrides: Partial<Stack> = {}): Stack {
  return {
    id: 'feat/123-fix-auth',
    project: 'proj',
    project_dir: '/proj',
    ticket: '123',
    branch: 'feat/123-fix-auth',
    description: null,
    status: 'failed',
    error: 'Review cap exhausted',
    pr_url: null,
    pr_number: null,
    runtime: 'docker',
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_execution_input_tokens: 0,
    total_execution_output_tokens: 0,
    total_review_input_tokens: 0,
    total_review_output_tokens: 0,
    rate_limit_reset_at: null,
    created_at: '2026-06-01T10:00:00Z',
    updated_at: '2026-06-01T10:30:00Z',
    current_model: null,
    selfheal_continue_used: 0,
    services: [],
    ...overrides,
  };
}

const DIAGNOSIS_SELF_HEAL: FailureDiagnosis = {
  summary: 'The review failed due to missing test coverage. Another attempt may succeed.',
  eligibility: { selfHeal: true, answerQuestions: false, reincorporateSpec: false },
  timeline: [
    { iteration: 1, phase: 'execute', verdict: 'pass', detail: 'Code written' },
    { iteration: 1, phase: 'review', verdict: 'fail', detail: 'Missing tests' },
  ],
};

const DIAGNOSIS_QUESTIONS: FailureDiagnosis = {
  summary: 'The agent needs clarification.',
  eligibility: { selfHeal: false, answerQuestions: true, reincorporateSpec: false },
  questions: [
    {
      id: 'q1',
      question: 'Which return code for unknown IDs?',
      options: [
        { id: 'a', label: '404 Not Found', recommended: true },
        { id: 'b', label: '400 Bad Request' },
      ],
    },
  ],
  timeline: [],
};

const DIAGNOSIS_ALL_DISABLED: FailureDiagnosis = {
  summary: 'No viable recovery path found.',
  eligibility: { selfHeal: false, answerQuestions: false, reincorporateSpec: false },
  timeline: [],
};

const DIAGNOSIS_REINCORPORATE: FailureDiagnosis = {
  summary: 'The spec was ambiguous about error handling.',
  eligibility: { selfHeal: false, answerQuestions: false, reincorporateSpec: true },
  timeline: [],
};

describe('ResolveFailureModal', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
  });

  it('shows loading state initially', () => {
    api.stacks.getFailureDiagnosis.mockReturnValue(new Promise(() => {}));
    render(
      <ResolveFailureModal stack={makeFailedStack()} onClose={vi.fn()} onResolved={vi.fn()} />
    );
    expect(screen.getByTestId('resolve-modal-loading')).toBeDefined();
  });

  it('shows assessment and timeline after loading', async () => {
    api.stacks.getFailureDiagnosis.mockResolvedValue(DIAGNOSIS_SELF_HEAL);
    render(
      <ResolveFailureModal stack={makeFailedStack()} onClose={vi.fn()} onResolved={vi.fn()} />
    );
    await waitFor(() => expect(screen.queryByTestId('resolve-modal-loading')).toBeNull());

    expect(screen.getByTestId('resolve-assessment')).toBeDefined();
    expect(screen.getByText(/missing test coverage/i)).toBeDefined();
    expect(screen.getByTestId('resolve-timeline')).toBeDefined();
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(2);
  });

  it('shows self-heal button enabled when eligible', async () => {
    api.stacks.getFailureDiagnosis.mockResolvedValue(DIAGNOSIS_SELF_HEAL);
    render(
      <ResolveFailureModal stack={makeFailedStack({ selfheal_continue_used: 0 })} onClose={vi.fn()} onResolved={vi.fn()} />
    );
    await waitFor(() => expect(screen.queryByTestId('resolve-modal-loading')).toBeNull());

    const btn = screen.getByTestId('self-heal-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('self-heal button is enabled even when selfheal_continue_used is 1 (repeatable)', async () => {
    api.stacks.getFailureDiagnosis.mockResolvedValue(DIAGNOSIS_SELF_HEAL);
    render(
      <ResolveFailureModal stack={makeFailedStack({ selfheal_continue_used: 1 })} onClose={vi.fn()} onResolved={vi.fn()} />
    );
    await waitFor(() => expect(screen.queryByTestId('resolve-modal-loading')).toBeNull());

    const btn = screen.getByTestId('self-heal-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('clicking self-heal calls selfHealContinue and triggers onResolved', async () => {
    api.stacks.getFailureDiagnosis.mockResolvedValue(DIAGNOSIS_SELF_HEAL);
    api.stacks.selfHealContinue.mockResolvedValue(undefined);
    const onResolved = vi.fn();

    render(
      <ResolveFailureModal stack={makeFailedStack()} onClose={vi.fn()} onResolved={onResolved} />
    );
    await waitFor(() => expect(screen.queryByTestId('resolve-modal-loading')).toBeNull());

    await act(async () => {
      screen.getByTestId('self-heal-btn').click();
    });

    await waitFor(() => expect(api.stacks.selfHealContinue).toHaveBeenCalledWith('feat/123-fix-auth'));
    expect(onResolved).toHaveBeenCalled();
  });

  it('shows QuestionList when answerQuestions is true', async () => {
    api.stacks.getFailureDiagnosis.mockResolvedValue(DIAGNOSIS_QUESTIONS);
    render(
      <ResolveFailureModal stack={makeFailedStack()} onClose={vi.fn()} onResolved={vi.fn()} />
    );
    await waitFor(() => expect(screen.queryByTestId('resolve-modal-loading')).toBeNull());

    expect(screen.getByTestId('answer-questions-btn')).toBeDefined();
    expect(screen.getByText(/Which return code for unknown IDs\?/)).toBeDefined();
  });

  it('all recovery actions disabled when no eligible options', async () => {
    api.stacks.getFailureDiagnosis.mockResolvedValue(DIAGNOSIS_ALL_DISABLED);
    render(
      <ResolveFailureModal stack={makeFailedStack()} onClose={vi.fn()} onResolved={vi.fn()} />
    );
    await waitFor(() => expect(screen.queryByTestId('resolve-modal-loading')).toBeNull());

    const selfHealBtn = screen.getByTestId('self-heal-btn') as HTMLButtonElement;
    const reincorpBtn = screen.getByTestId('reincorporate-btn') as HTMLButtonElement;
    expect(selfHealBtn.disabled).toBe(true);
    expect(reincorpBtn.disabled).toBe(true);
    expect(screen.queryByTestId('answer-questions-btn')).toBeNull();
  });

  it('shows error message when getFailureDiagnosis fails', async () => {
    api.stacks.getFailureDiagnosis.mockRejectedValue(new Error('Network error'));
    render(
      <ResolveFailureModal stack={makeFailedStack()} onClose={vi.fn()} onResolved={vi.fn()} />
    );
    await waitFor(() => expect(screen.queryByTestId('resolve-modal-loading')).toBeNull());

    expect(screen.getByTestId('resolve-modal-error')).toBeDefined();
    expect(screen.getByTestId('resolve-modal-error').textContent).toContain('Network error');
  });

  it('shows no timeline section when timeline is empty', async () => {
    api.stacks.getFailureDiagnosis.mockResolvedValue(DIAGNOSIS_ALL_DISABLED);
    render(
      <ResolveFailureModal stack={makeFailedStack()} onClose={vi.fn()} onResolved={vi.fn()} />
    );
    await waitFor(() => expect(screen.queryByTestId('resolve-modal-loading')).toBeNull());

    expect(screen.queryByTestId('resolve-timeline')).toBeNull();
  });

  it('clicking reincorporate calls restartWithFindings with the diagnosis summary as findings', async () => {
    api.stacks.getFailureDiagnosis.mockResolvedValue(DIAGNOSIS_REINCORPORATE);
    api.stacks.restartWithFindings.mockResolvedValue({ newStackId: 'feat/123-fix-auth-r2' });
    const onResolved = vi.fn();

    render(
      <ResolveFailureModal stack={makeFailedStack()} onClose={vi.fn()} onResolved={onResolved} />
    );
    await waitFor(() => expect(screen.queryByTestId('resolve-modal-loading')).toBeNull());

    const btn = screen.getByTestId('reincorporate-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    await act(async () => {
      btn.click();
    });

    await waitFor(() =>
      expect(api.stacks.restartWithFindings).toHaveBeenCalledWith(
        'feat/123-fix-auth',
        'The spec was ambiguous about error handling.',
      )
    );
    expect(onResolved).toHaveBeenCalled();
  });

  it('answer-questions button is rendered and submittable (first recommended option pre-selected)', async () => {
    api.stacks.getFailureDiagnosis.mockResolvedValue(DIAGNOSIS_QUESTIONS);
    api.stacks.resumeNeedsHuman.mockResolvedValue(undefined);
    const onResolved = vi.fn();

    render(
      <ResolveFailureModal stack={makeFailedStack()} onClose={vi.fn()} onResolved={onResolved} />
    );
    await waitFor(() => expect(screen.queryByTestId('resolve-modal-loading')).toBeNull());

    // The recommended option is pre-selected by defaultAnswers, so submit is enabled
    const submitBtn = screen.getByTestId('answer-questions-btn') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    await act(async () => {
      submitBtn.click();
    });

    await waitFor(() =>
      expect(api.stacks.resumeNeedsHuman).toHaveBeenCalledWith('feat/123-fix-auth', expect.any(String))
    );
    expect(onResolved).toHaveBeenCalled();
  });
});
