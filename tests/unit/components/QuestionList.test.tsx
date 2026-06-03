/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(() => { cleanup(); });
import { QuestionList, normalizeQuestion, combineAnswers, defaultAnswers, isSubmitDisabled } from '../../../src/renderer/components/QuestionList';
import type { QuestionAnswer } from '../../../src/renderer/components/QuestionList';
import type { RefineQuestion } from '../../../src/renderer/store';

const q1: RefineQuestion = {
  id: 'q1',
  question: 'What approach?',
  options: [
    { id: 'a', label: 'Option A', recommended: true },
    { id: 'b', label: 'Option B' },
  ],
};

const q2: RefineQuestion = {
  id: 'q2',
  question: 'Which library?',
  options: [
    { id: 'x', label: 'Library X' },
    { id: 'y', label: 'Library Y', recommended: true },
  ],
};

describe('normalizeQuestion', () => {
  it('wraps a string into a RefineQuestion', () => {
    const result = normalizeQuestion('some question', 0);
    expect(result).toEqual({ id: 'q0', question: 'some question', options: [] });
  });

  it('fills in missing options array', () => {
    const result = normalizeQuestion({ id: 'qx', question: 'What?' } as unknown, 0);
    expect((result as RefineQuestion).options).toEqual([]);
  });

  it('passes through a valid RefineQuestion unchanged', () => {
    expect(normalizeQuestion(q1, 0)).toEqual(q1);
  });
});

describe('defaultAnswers', () => {
  it('pre-selects the first recommended option', () => {
    const ans = defaultAnswers([q1]);
    expect(ans[0].optionId).toBe('a');
    expect(ans[0].text).toBe('');
  });

  it('starts with null when no recommended option', () => {
    const q: RefineQuestion = { id: 'q', question: 'Q?', options: [{ id: 'z', label: 'Z' }] };
    const ans = defaultAnswers([q]);
    expect(ans[0].optionId).toBeNull();
  });

  it('starts with null for questions with no options', () => {
    const q: RefineQuestion = { id: 'q', question: 'Q?', options: [] };
    const ans = defaultAnswers([q]);
    expect(ans[0].optionId).toBeNull();
  });
});

describe('isSubmitDisabled', () => {
  it('returns true when any answer has no optionId and no text', () => {
    const answers: QuestionAnswer[] = [{ optionId: 'a', text: '' }, { optionId: null, text: '' }];
    expect(isSubmitDisabled(answers)).toBe(true);
  });

  it('returns false when each answer has optionId or text', () => {
    const answers: QuestionAnswer[] = [{ optionId: 'a', text: '' }, { optionId: null, text: 'some text' }];
    expect(isSubmitDisabled(answers)).toBe(false);
  });

  it('returns false when all have optionIds', () => {
    const answers: QuestionAnswer[] = [{ optionId: 'a', text: '' }, { optionId: 'b', text: '' }];
    expect(isSubmitDisabled(answers)).toBe(false);
  });
});

describe('combineAnswers', () => {
  it('formats questions and answers into structured text', () => {
    const questions = [q1, q2];
    const answers: QuestionAnswer[] = [
      { optionId: 'a', text: 'more detail' },
      { optionId: 'y', text: '' },
    ];
    const result = combineAnswers(questions, answers);
    expect(result).toContain('Q1: What approach?');
    expect(result).toContain('Selected: Option A');
    expect(result).toContain('Additional context: more detail');
    expect(result).toContain('Q2: Which library?');
    expect(result).toContain('Selected: Library Y');
    expect(result).toContain('Additional context: (none)');
  });

  it('uses (none) when no option selected', () => {
    const questions = [q1];
    const answers: QuestionAnswer[] = [{ optionId: null, text: '' }];
    const result = combineAnswers(questions, answers);
    expect(result).toContain('Selected: (none)');
  });
});

describe('QuestionList component', () => {
  it('renders question text', () => {
    const answers: QuestionAnswer[] = [{ optionId: null, text: '' }];
    render(
      <QuestionList
        questions={[q1]}
        answers={answers}
        onAnswersChange={() => {}}
        testIdPrefix="test"
      />
    );
    expect(screen.getByText('What approach?')).toBeDefined();
  });

  it('renders all options', () => {
    const answers: QuestionAnswer[] = [{ optionId: null, text: '' }];
    render(
      <QuestionList
        questions={[q1]}
        answers={answers}
        onAnswersChange={() => {}}
        testIdPrefix="test"
      />
    );
    expect(screen.getByText('Option A')).toBeDefined();
    expect(screen.getByText('Option B')).toBeDefined();
  });

  it('renders Recommended badge for the first recommended option', () => {
    const answers: QuestionAnswer[] = [{ optionId: null, text: '' }];
    render(
      <QuestionList
        questions={[q1]}
        answers={answers}
        onAnswersChange={() => {}}
        testIdPrefix="test"
      />
    );
    expect(screen.getByTestId('test-option-recommended-0-a')).toBeDefined();
  });

  it('does not render Recommended badge for non-recommended options', () => {
    const answers: QuestionAnswer[] = [{ optionId: null, text: '' }];
    render(
      <QuestionList
        questions={[q1]}
        answers={answers}
        onAnswersChange={() => {}}
        testIdPrefix="test"
      />
    );
    expect(screen.queryByTestId('test-option-recommended-0-b')).toBeNull();
  });

  it('calls onAnswersChange when an option is clicked', () => {
    let captured: QuestionAnswer[] = [{ optionId: null, text: '' }];
    const { rerender } = render(
      <QuestionList
        questions={[q1]}
        answers={captured}
        onAnswersChange={(next) => { captured = next; }}
        testIdPrefix="test"
      />
    );
    fireEvent.click(screen.getByTestId('test-option-0-b'));
    expect(captured[0].optionId).toBe('b');
  });

  it('renders textarea for additional context', () => {
    const answers: QuestionAnswer[] = [{ optionId: null, text: '' }];
    render(
      <QuestionList
        questions={[q1]}
        answers={answers}
        onAnswersChange={() => {}}
        testIdPrefix="test"
      />
    );
    expect(screen.getByTestId('test-answer-0')).toBeDefined();
  });
});
