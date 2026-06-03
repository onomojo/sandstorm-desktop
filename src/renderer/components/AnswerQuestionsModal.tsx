import React, { useState, useEffect, useCallback } from 'react';
import { RefineQuestion } from '../store';
import { QuestionList, QuestionAnswer, normalizeQuestion, combineAnswers, defaultAnswers, isSubmitDisabled } from './QuestionList';

interface AnswerQuestionsModalProps {
  stackId: string;
  onClose: () => void;
  onResumed: () => void;
}

export function AnswerQuestionsModal({ stackId, onClose, onResumed }: AnswerQuestionsModalProps) {
  const [questions, setQuestions] = useState<RefineQuestion[] | null>(null);
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);
  const [answers, setAnswers] = useState<QuestionAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.sandstorm.stacks.getNeedsHumanQuestions(stackId)
      .then((raw) => {
        if (cancelled) return;
        if (!raw) {
          setFallbackMessage('Agent requested human input but provided no structured questions.');
          setLoading(false);
          return;
        }
        try {
          const parsed = JSON.parse(raw) as unknown[];
          const normalized = parsed.map((q, i) => normalizeQuestion(q, i));
          if (normalized.length === 0) {
            setFallbackMessage(raw);
            setLoading(false);
            return;
          }
          setQuestions(normalized);
          setAnswers(defaultAnswers(normalized));
        } catch {
          setFallbackMessage(raw);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setFallbackMessage(`Could not load questions: ${err instanceof Error ? err.message : String(err)}`);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [stackId]);

  const handleSubmit = useCallback(async () => {
    if (!questions) return;
    setSubmitting(true);
    setError(null);
    try {
      const combined = combineAnswers(questions, answers);
      await window.sandstorm.stacks.resumeNeedsHuman(stackId, combined);
      onResumed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [stackId, questions, answers, onResumed]);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
      data-testid="answer-questions-modal"
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[640px] max-h-[80vh] overflow-y-auto shadow-dialog animate-slide-up">
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">Answer Agent Questions</h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">
              The agent needs your input to continue
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-sandstorm-muted hover:text-sandstorm-text transition-colors p-1.5 rounded-md hover:bg-sandstorm-surface-hover disabled:opacity-40"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5" data-testid="answer-modal-error">
              {error}
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-xs text-sandstorm-muted" data-testid="answer-modal-loading">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="48" strokeDashoffset="32"/>
              </svg>
              Loading questions…
            </div>
          )}

          {!loading && fallbackMessage && (
            <div className="space-y-3" data-testid="answer-modal-fallback">
              <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
                The agent halted with the following message. Review it and re-dispatch manually if needed.
              </div>
              <div className="text-xs text-sandstorm-muted bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2.5 whitespace-pre-wrap font-mono">
                {fallbackMessage}
              </div>
            </div>
          )}

          {!loading && questions && questions.length > 0 && (
            <QuestionList
              questions={questions}
              answers={answers}
              onAnswersChange={setAnswers}
              testIdPrefix="answer"
            />
          )}
        </div>

        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover disabled:opacity-40"
          >
            Cancel
          </button>
          {!loading && questions && questions.length > 0 && (
            <button
              onClick={handleSubmit}
              disabled={submitting || isSubmitDisabled(answers)}
              className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
              data-testid="answer-modal-submit"
            >
              {submitting ? 'Resuming…' : 'Submit & Resume'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
