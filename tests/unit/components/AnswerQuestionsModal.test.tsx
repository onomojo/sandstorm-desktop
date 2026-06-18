/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { AnswerQuestionsModal } from '../../../src/renderer/components/AnswerQuestionsModal';
import { mockSandstormApi } from './setup';

const QUESTIONS_JSON = JSON.stringify([
  {
    id: 'q1',
    question: 'How should we handle it?',
    options: [
      { id: 'a', label: 'Option A', recommended: true },
      { id: 'b', label: 'Option B' },
    ],
  },
]);

function renderModal(overrides: Partial<{
  stackId: string;
  onClose: () => void;
  onResumed: () => void;
}> = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onResumed = overrides.onResumed ?? vi.fn();
  return render(
    <AnswerQuestionsModal
      stackId={overrides.stackId ?? 'test-stack'}
      onClose={onClose}
      onResumed={onResumed}
    />
  );
}

describe('AnswerQuestionsModal', () => {
  beforeEach(() => {
    mockSandstormApi();
  });

  it('shows loading state initially', () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(QUESTIONS_JSON);
    renderModal();
    expect(screen.getByTestId('answer-modal-loading')).toBeDefined();
  });

  it('renders structured questions after loading', async () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(QUESTIONS_JSON);
    renderModal();
    await waitFor(() => {
      expect(screen.queryByTestId('answer-modal-loading')).toBeNull();
    });
    expect(screen.getByText('How should we handle it?')).toBeDefined();
    expect(screen.getByText('Option A')).toBeDefined();
    expect(screen.getByText('Option B')).toBeDefined();
  });

  it('pre-selects the recommended option', async () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(QUESTIONS_JSON);
    renderModal();
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());
    const radioA = screen.getByTestId('answer-option-0-a') as HTMLInputElement;
    expect(radioA.checked).toBe(true);
  });

  it('shows submit button that is enabled when recommended option is preselected', async () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(QUESTIONS_JSON);
    renderModal();
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());
    const btn = screen.getByTestId('answer-modal-submit') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('shows fallback message when questions JSON is null', async () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(null);
    renderModal();
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());
    expect(screen.getByTestId('answer-modal-fallback')).toBeDefined();
    expect(screen.queryByTestId('answer-modal-submit')).toBeNull();
  });

  it('shows fallback message when JSON is malformed', async () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue('not valid json {{');
    renderModal();
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());
    expect(screen.getByTestId('answer-modal-fallback')).toBeDefined();
  });

  it('calls resumeNeedsHuman and onResumed on submit', async () => {
    const onResumed = vi.fn();
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(QUESTIONS_JSON);
    (window.sandstorm.stacks.resumeNeedsHuman as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);
    renderModal({ onResumed });
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());
    await act(async () => {
      screen.getByTestId('answer-modal-submit').click();
    });
    expect(window.sandstorm.stacks.resumeNeedsHuman).toHaveBeenCalledWith(
      'test-stack',
      expect.stringContaining('Q1: How should we handle it?')
    );
    expect(onResumed).toHaveBeenCalled();
  });

  it('shows error when resumeNeedsHuman fails', async () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(QUESTIONS_JSON);
    (window.sandstorm.stacks.resumeNeedsHuman as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('Network failure'));
    renderModal();
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());
    await act(async () => {
      screen.getByTestId('answer-modal-submit').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('answer-modal-error')).toBeDefined();
    });
    expect(screen.getByTestId('answer-modal-error').textContent).toContain('Network failure');
  });

  it('renders "Ask for clarifying questions" button in fallback when no questions', async () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(null);
    renderModal();
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());
    expect(screen.getByTestId('answer-modal-fallback')).toBeDefined();
    expect(screen.getByTestId('answer-modal-ask-clarifying')).toBeDefined();
    expect(screen.queryByTestId('answer-modal-submit')).toBeNull();
  });

  it('calls askClarifyingQuestions and refetches when button is clicked', async () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(null);
    (window.sandstorm.stacks.askClarifyingQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);
    renderModal();
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());

    await act(async () => {
      screen.getByTestId('answer-modal-ask-clarifying').click();
    });

    expect(window.sandstorm.stacks.askClarifyingQuestions).toHaveBeenCalledWith('test-stack');
    expect(window.sandstorm.stacks.getNeedsHumanQuestions).toHaveBeenCalledTimes(2);
  });

  it('shows terminal message when ask returns still no questions', async () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(null);
    (window.sandstorm.stacks.askClarifyingQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);
    renderModal();
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());

    await act(async () => {
      screen.getByTestId('answer-modal-ask-clarifying').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('answer-modal-terminal-no-questions')).toBeDefined();
    });
    expect(screen.queryByTestId('answer-modal-ask-clarifying')).toBeNull();
  });

  it('shows questions when ask clarifying questions populates them', async () => {
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(QUESTIONS_JSON);
    (window.sandstorm.stacks.askClarifyingQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);
    renderModal();
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());

    await act(async () => {
      screen.getByTestId('answer-modal-ask-clarifying').click();
    });

    await waitFor(() => {
      expect(screen.getByText('How should we handle it?')).toBeDefined();
    });
    expect(screen.queryByTestId('answer-modal-terminal-no-questions')).toBeNull();
  });

  it('disables "Ask for clarifying questions" button while in flight', async () => {
    let resolveAsk!: () => void;
    const askPromise = new Promise<void>((resolve) => { resolveAsk = resolve; });
    (window.sandstorm.stacks.getNeedsHumanQuestions as ReturnType<typeof vi.fn>)
      .mockResolvedValue(null);
    (window.sandstorm.stacks.askClarifyingQuestions as ReturnType<typeof vi.fn>)
      .mockReturnValue(askPromise);
    renderModal();
    await waitFor(() => expect(screen.queryByTestId('answer-modal-loading')).toBeNull());

    act(() => {
      screen.getByTestId('answer-modal-ask-clarifying').click();
    });

    // Button should be disabled during in-flight
    await waitFor(() => {
      const btn = screen.getByTestId('answer-modal-ask-clarifying') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    // Resolve the ask
    await act(async () => { resolveAsk(); });
  });
});
