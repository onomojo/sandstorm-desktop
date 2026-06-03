import React from 'react';
import { RefineQuestion } from '../store';

export interface QuestionAnswer {
  optionId: string | null;
  text: string;
}

export function normalizeQuestion(q: unknown, index: number): RefineQuestion {
  if (typeof q === 'string') {
    return { id: `q${index}`, question: q as string, options: [] };
  }
  const qObj = q as RefineQuestion;
  if (!Array.isArray(qObj.options)) {
    return { ...qObj, options: [] };
  }
  return qObj;
}

export function combineAnswers(questions: RefineQuestion[], answers: QuestionAnswer[]): string {
  return questions
    .map((q, i) => {
      const ans = answers[i];
      const selectedLabel =
        ans?.optionId != null
          ? q.options.find((o) => o.id === ans.optionId)?.label ?? null
          : null;
      return [
        `Q${i + 1}: ${q.question}`,
        `Selected: ${selectedLabel ?? '(none)'}`,
        `Additional context: ${ans?.text.trim() || '(none)'}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function defaultAnswers(questions: RefineQuestion[]): QuestionAnswer[] {
  return questions.map((q) => {
    const firstRecommended = q.options.find((o) => o.recommended === true);
    return { optionId: firstRecommended ? firstRecommended.id : null, text: '' };
  });
}

export function isSubmitDisabled(answers: QuestionAnswer[]): boolean {
  return answers.some((a) => a.optionId === null && !a.text.trim());
}

interface QuestionListProps {
  questions: RefineQuestion[];
  answers: QuestionAnswer[];
  onAnswersChange: (answers: QuestionAnswer[]) => void;
  testIdPrefix?: string;
}

export function QuestionList({ questions, answers, onAnswersChange, testIdPrefix = 'question' }: QuestionListProps) {
  return (
    <div className="space-y-4">
      {questions.map((q, i) => {
        const ans = answers[i] ?? { optionId: null, text: '' };
        return (
          <div key={i} className="space-y-2">
            <p className="text-xs text-sandstorm-text-secondary">
              <span className="text-sandstorm-muted">{i + 1}.</span> {q.question}
            </p>
            {q.options.length > 0 && (
              <div className="space-y-1 pl-3">
                {q.options.map((opt, optIdx) => {
                  const isFirstRecommended =
                    opt.recommended === true &&
                    optIdx === q.options.findIndex((o) => o.recommended === true);
                  return (
                    <label key={opt.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name={`${testIdPrefix}-q-${i}`}
                        value={opt.id}
                        checked={ans.optionId === opt.id}
                        onChange={() => {}}
                        onClick={() => {
                          const next = [...answers];
                          next[i] = { ...ans, optionId: ans.optionId === opt.id ? null : opt.id };
                          onAnswersChange(next);
                        }}
                        className="accent-sandstorm-accent"
                        data-testid={`${testIdPrefix}-option-${i}-${opt.id}`}
                      />
                      <span className="text-xs text-sandstorm-text">{opt.label}</span>
                      {isFirstRecommended && (
                        <span
                          className="text-xs font-medium text-sandstorm-accent border border-sandstorm-accent/40 rounded px-1.5 py-0.5 leading-none"
                          data-testid={`${testIdPrefix}-option-recommended-${i}-${opt.id}`}
                        >
                          Recommended
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
            <textarea
              value={ans.text}
              onChange={(e) => {
                const next = [...answers];
                next[i] = { ...ans, text: e.target.value };
                onAnswersChange(next);
              }}
              rows={2}
              placeholder="Add more detail…"
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs text-sandstorm-text resize-none outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
              data-testid={`${testIdPrefix}-answer-${i}`}
            />
          </div>
        );
      })}
    </div>
  );
}
