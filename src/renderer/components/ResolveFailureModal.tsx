import React, { useState, useEffect, useCallback } from 'react';
import { Stack, FailureDiagnosis, FailureTimelineEntry, RefineQuestion } from '../store';
import { QuestionList, QuestionAnswer, normalizeQuestion, combineAnswers, defaultAnswers, isSubmitDisabled } from './QuestionList';

interface ResolveFailureModalProps {
  stack: Stack;
  onClose: () => void;
  onResolved: () => void;
}

export function ResolveFailureModal({ stack, onClose, onResolved }: ResolveFailureModalProps) {
  const [diagnosis, setDiagnosis] = useState<FailureDiagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [answers, setAnswers] = useState<QuestionAnswer[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.sandstorm.stacks.getFailureDiagnosis(stack.id)
      .then((d) => {
        if (cancelled) return;
        const diag = d as FailureDiagnosis;
        setDiagnosis(diag);
        if (diag.questions && diag.questions.length > 0) {
          setAnswers(defaultAnswers(diag.questions.map((q, i) => normalizeQuestion(q, i))));
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [stack.id]);

  const canSelfHeal = diagnosis?.eligibility.selfHeal === true && stack.selfheal_continue_used === 0;
  const canAnswerQuestions = diagnosis?.eligibility.answerQuestions === true && (diagnosis.questions?.length ?? 0) > 0;
  const canReincorporate = diagnosis?.eligibility.reincorporateSpec === true;

  const handleSelfHeal = useCallback(async () => {
    setSubmitting(true);
    setActionError(null);
    try {
      await window.sandstorm.stacks.selfHealContinue(stack.id);
      onResolved();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [stack.id, onResolved]);

  const handleAnswerQuestions = useCallback(async () => {
    if (!diagnosis?.questions) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const normalized = diagnosis.questions.map((q, i) => normalizeQuestion(q, i));
      const combined = combineAnswers(normalized, answers);
      await window.sandstorm.stacks.resumeNeedsHuman(stack.id, combined);
      onResolved();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [stack.id, diagnosis, answers, onResolved]);

  const handleReincorporate = useCallback(async () => {
    setSubmitting(true);
    setActionError(null);
    try {
      // Use the assessment as the updated ticket body seed
      const updatedBody = diagnosis?.summary ?? '';
      await window.sandstorm.stacks.restartWithFindings(stack.id, updatedBody);
      onResolved();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [stack.id, diagnosis, onResolved]);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
      data-testid="resolve-failure-modal"
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[720px] max-h-[85vh] overflow-y-auto shadow-dialog animate-slide-up">
        {/* Header */}
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">Resolve Failure</h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">
              Stack <span className="font-mono text-sandstorm-text-secondary">{stack.id}</span> hit the review cap
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

        <div className="px-6 py-5 space-y-5">
          {/* Loading state */}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-sandstorm-muted py-4" data-testid="resolve-modal-loading">
              <div className="w-3.5 h-3.5 border-2 border-sandstorm-accent/30 border-t-sandstorm-accent rounded-full animate-spin" />
              Running diagnostic agent…
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5" data-testid="resolve-modal-error">
              {error}
            </div>
          )}

          {/* Action error */}
          {actionError && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5" data-testid="resolve-action-error">
              {actionError}
            </div>
          )}

          {diagnosis && (
            <>
              {/* Assessment */}
              <section data-testid="resolve-assessment">
                <h3 className="text-xs font-semibold text-sandstorm-text-secondary uppercase tracking-wide mb-2">Assessment</h3>
                <p className="text-xs text-sandstorm-text leading-relaxed whitespace-pre-wrap">{diagnosis.summary}</p>
              </section>

              {/* Timeline */}
              {diagnosis.timeline.length > 0 && (
                <section data-testid="resolve-timeline">
                  <h3 className="text-xs font-semibold text-sandstorm-text-secondary uppercase tracking-wide mb-2">Timeline</h3>
                  <div className="space-y-1.5">
                    {diagnosis.timeline.map((entry, i) => (
                      <TimelineRow key={i} entry={entry} />
                    ))}
                  </div>
                </section>
              )}

              {/* Recovery actions */}
              <section data-testid="resolve-actions">
                <h3 className="text-xs font-semibold text-sandstorm-text-secondary uppercase tracking-wide mb-3">Recovery Options</h3>
                <div className="space-y-3">
                  {/* Self-heal continue */}
                  <RecoveryAction
                    title="Self-heal continue"
                    description="Re-dispatch the task on this same stack for one more review round."
                    enabled={canSelfHeal && !submitting}
                    disabledReason={
                      stack.selfheal_continue_used !== 0
                        ? 'Continuation already consumed'
                        : !diagnosis.eligibility.selfHeal
                          ? 'Diagnostic agent recommends against another attempt'
                          : undefined
                    }
                    onAction={handleSelfHeal}
                    actionLabel="Continue"
                    testId="self-heal-btn"
                  />

                  {/* Answer questions */}
                  {canAnswerQuestions && diagnosis.questions && (
                    <div className="border border-sandstorm-border rounded-lg p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs font-medium text-sandstorm-text">Answer questions</p>
                          <p className="text-[11px] text-sandstorm-muted mt-0.5">The agent has blocking questions that need your answers.</p>
                        </div>
                        <button
                          onClick={handleAnswerQuestions}
                          disabled={submitting || isSubmitDisabled(answers)}
                          className="text-[11px] font-medium px-3 py-1.5 rounded-md bg-sandstorm-accent/10 text-sandstorm-accent hover:bg-sandstorm-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          data-testid="answer-questions-btn"
                        >
                          Submit answers
                        </button>
                      </div>
                      <QuestionList
                        questions={diagnosis.questions.map((q, i) => normalizeQuestion(q, i))}
                        answers={answers}
                        onAnswersChange={setAnswers}
                        testIdPrefix="resolve-question"
                      />
                    </div>
                  )}

                  {/* Re-incorporate spec */}
                  <RecoveryAction
                    title="Re-incorporate findings & restart"
                    description="Update the ticket spec with what was learned, push the failed branch, then restart on a fresh branch."
                    enabled={canReincorporate && !submitting}
                    disabledReason={
                      !diagnosis.eligibility.reincorporateSpec
                        ? 'Diagnostic agent recommends against spec restart'
                        : undefined
                    }
                    onAction={handleReincorporate}
                    actionLabel="Restart"
                    testId="reincorporate-btn"
                    destructive
                  />
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineRow({ entry }: { entry: FailureTimelineEntry }) {
  const phaseLabel = entry.phase === 'execute' ? 'Execute' : entry.phase === 'review' ? 'Review' : 'Verify';
  const verdictColor = entry.verdict === 'pass'
    ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
    : 'text-red-400 bg-red-500/10 border-red-500/20';

  return (
    <div className="flex items-start gap-2 text-[11px]" data-testid="timeline-row">
      <span className="mt-0.5 text-sandstorm-muted font-mono w-5 shrink-0">{entry.iteration}</span>
      <span className="mt-0.5 w-14 text-sandstorm-text-secondary shrink-0">{phaseLabel}</span>
      <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0 ${verdictColor}`}>
        {entry.verdict.toUpperCase()}
      </span>
      {entry.detail && (
        <span className="text-sandstorm-muted truncate" title={entry.detail}>{entry.detail.slice(0, 120)}</span>
      )}
    </div>
  );
}

function RecoveryAction({
  title,
  description,
  enabled,
  disabledReason,
  onAction,
  actionLabel,
  testId,
  destructive,
}: {
  title: string;
  description: string;
  enabled: boolean;
  disabledReason?: string;
  onAction: () => void;
  actionLabel: string;
  testId: string;
  destructive?: boolean;
}) {
  return (
    <div className={`border rounded-lg p-4 flex items-start justify-between gap-4 ${enabled ? 'border-sandstorm-border' : 'border-sandstorm-border/40 opacity-60'}`}>
      <div className="min-w-0">
        <p className="text-xs font-medium text-sandstorm-text">{title}</p>
        <p className="text-[11px] text-sandstorm-muted mt-0.5">{description}</p>
        {!enabled && disabledReason && (
          <p className="text-[10px] text-sandstorm-muted/60 mt-1 italic">{disabledReason}</p>
        )}
      </div>
      <button
        onClick={onAction}
        disabled={!enabled}
        className={`shrink-0 text-[11px] font-medium px-3 py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          destructive
            ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
            : 'bg-sandstorm-accent/10 text-sandstorm-accent hover:bg-sandstorm-accent/20'
        }`}
        data-testid={testId}
      >
        {actionLabel}
      </button>
    </div>
  );
}
