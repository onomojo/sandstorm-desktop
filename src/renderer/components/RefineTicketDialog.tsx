import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useAppStore, SpecGateResult, RefinementSession, RefineQuestion } from '../store';
import type { KanbanColumn } from '../store';
import { ConfirmDialog } from './ConfirmDialog';

type LocalPhase = 'input' | 'starting';

interface TeardownConfirmPending {
  ticketId: string;
  projectDir: string;
  previousColumn: KanbanColumn;
  stackId: string;
}

function suggestStackName(ticketId: string): string {
  const id = ticketId.replace(/^#/, '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return id ? `ticket-${id}` : '';
}

/** MM:SS elapsed since a startedAt epoch ms. Ticks once per second while mounted. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono tabular-nums" data-testid="refine-elapsed-timer">
      {formatElapsed(now - startedAt)}
    </span>
  );
}

export function RefineTicketDialog() {
  const {
    setShowRefineTicketDialog,
    refreshStacks,
    activeProject,
    consumeRefineTicketPrefill,
    refinementSessions,
    currentRefinementSessionId,
    setCurrentRefinementSessionId,
    removeRefinementSession,
    upsertRefinementSession,
    moveTicketColumn,
    resolveRefinementTargets,
    commitRefinementContext,
    boardTickets,
  } = useAppStore();
  const project = activeProject();

  const [ticketId, setTicketId] = useState('');
  const [localPhase, setLocalPhase] = useState<LocalPhase>('input');
  const [answers, setAnswers] = useState<{ optionId: string | null; text: string }[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [stackName, setStackName] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [teardownConfirmPending, setTeardownConfirmPending] = useState<TeardownConfirmPending | null>(null);

  const session: RefinementSession | null = currentRefinementSessionId
    ? (refinementSessions.find((s) => s.id === currentRefinementSessionId) ?? null)
    : null;

  const cleanTicketId = useMemo(() => ticketId.trim().replace(/^#/, ''), [ticketId]);
  const projectDir = project?.directory ?? '';

  // Effective status: use session status if we have a session, otherwise local phase
  const gate: SpecGateResult | null = session?.result ?? null;
  const sessionError = session?.error ?? null;

  // Initialise answers when gate questions change.
  // Defensively coerce legacy string[] items (old persisted sessions) to RefineQuestion.
  useEffect(() => {
    if (gate && !gate.passed && gate.questions.length > 0) {
      const normalized = gate.questions.map((q): RefineQuestion =>
        typeof q === 'string'
          ? { id: 'q', question: q as string, options: [] }
          : (!Array.isArray((q as RefineQuestion).options) ? { ...(q as RefineQuestion), options: [] } : q as RefineQuestion)
      );
      setAnswers(normalized.map((q) => {
        const firstRecommended = q.options.find((o) => o.recommended === true);
        return { optionId: firstRecommended ? firstRecommended.id : null, text: '' };
      }));
    }
  }, [gate]);

  // Suggest stack name when gate passes
  useEffect(() => {
    if (gate?.passed && session) {
      setStackName((s) => s || suggestStackName(session.ticketId));
    }
  }, [gate?.passed, session]);

  // Shared: run specCheckAsync and update session id.
  const startGateSession = useCallback(async (tId: string, pDir: string) => {
    const { sessionId } = await window.sandstorm.tickets.specCheckAsync(tId, pDir);
    setCurrentRefinementSessionId(sessionId);
  }, [setCurrentRefinementSessionId]);

  // Shared: commit context + move column, then start gate. Optionally tears down a stack.
  const proceedWithRefinement = useCallback(async (
    tId: string,
    pDir: string,
    prevCol: KanbanColumn,
    stackIdToTeardown?: string,
  ) => {
    commitRefinementContext(tId, pDir, prevCol);
    await startGateSession(tId, pDir);
    if (stackIdToTeardown) {
      window.sandstorm.stacks.teardown(stackIdToTeardown).catch((err: unknown) => {
        setLocalError(`Stack teardown failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }, [commitRefinementContext, startGateSession]);

  // Hand-off from CreateTicketDialog → "Refine #N" (#317).
  useEffect(() => {
    const prefill = consumeRefineTicketPrefill();
    if (!prefill || !projectDir) return;
    const tId = prefill.replace(/^#/, '');
    setTicketId(prefill);

    const resolution = resolveRefinementTargets(tId, projectDir);
    if (resolution.kind === 'error') {
      setLocalError(resolution.message);
      return;
    }
    if (resolution.kind === 'confirm') {
      setTeardownConfirmPending({
        ticketId: tId,
        projectDir,
        previousColumn: resolution.previousColumn,
        stackId: resolution.stackId,
      });
      return;
    }
    // silent: move + run gate immediately
    void proceedWithRefinement(tId, projectDir, resolution.previousColumn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRunGate = useCallback(async () => {
    if (!cleanTicketId || !projectDir) {
      setLocalError('Ticket ID and an active project are both required');
      return;
    }
    setLocalError(null);

    const resolution = resolveRefinementTargets(cleanTicketId, projectDir);
    if (resolution.kind === 'error') {
      setLocalError(resolution.message);
      return;
    }
    if (resolution.kind === 'confirm') {
      setTeardownConfirmPending({
        ticketId: cleanTicketId,
        projectDir,
        previousColumn: resolution.previousColumn,
        stackId: resolution.stackId,
      });
      return;
    }
    // silent
    await proceedWithRefinement(cleanTicketId, projectDir, resolution.previousColumn);
  }, [cleanTicketId, projectDir, resolveRefinementTargets, proceedWithRefinement]);

  const handleTeardownConfirm = useCallback(async () => {
    if (!teardownConfirmPending) return;
    const { ticketId: tId, projectDir: pDir, previousColumn, stackId } = teardownConfirmPending;
    setTeardownConfirmPending(null);
    setLocalError(null);
    await proceedWithRefinement(tId, pDir, previousColumn, stackId);
  }, [teardownConfirmPending, proceedWithRefinement]);

  const handleTeardownCancel = useCallback(() => {
    setTeardownConfirmPending(null);
  }, []);

  const handleSubmitAnswers = useCallback(async () => {
    if (!session || !projectDir) return;
    const questions = gate?.questions ?? [];
    const combined = questions
      .map((q, i) => {
        const ans = answers[i];
        const questionText = typeof q === 'string' ? q : q.question;
        const selectedLabel =
          ans?.optionId != null
            ? (typeof q === 'string' ? null : q.options.find((o) => o.id === ans.optionId)?.label ?? null)
            : null;
        const lines = [
          `Q${i + 1}: ${questionText}`,
          `Selected: ${selectedLabel ?? '(none)'}`,
          `Additional context: ${ans?.text.trim() || '(none)'}`,
        ];
        return lines.join('\n');
      })
      .join('\n\n');
    setLocalError(null);
    // Update session optimistically to 'running' while we wait
    upsertRefinementSession({ ...session, status: 'running', phase: 'refine' });
    // Persist answers to comments (best-effort) so phase-aware Retry can resume.
    if (combined.trim()) {
      await window.sandstorm.tickets.postAnswers(
        session.ticketId,
        projectDir,
        combined,
      ).catch(() => {
        // non-fatal: Retry falls back to check if no answer comments found
      });
    }
    await window.sandstorm.tickets.specRefineAsync(
      session.id,
      session.ticketId,
      projectDir,
      combined,
    );
  }, [session, gate, answers, projectDir, upsertRefinementSession]);

  const handleStartStack = useCallback(async () => {
    if (!session || !projectDir) return;
    const name = stackName.trim();
    if (!name) { setLocalError('Stack name is required'); return; }
    setLocalError(null);
    setLocalPhase('starting');
    try {
      const fetched = await window.sandstorm.tickets.fetch(session.ticketId, projectDir);
      await window.sandstorm.stacks.create({
        name,
        projectDir,
        ticket: session.ticketId,
        branch: `feat/${session.ticketId}-${name}`,
        description: fetched.body.split('\n').find((l) => l.trim())?.replace(/^#\s*/, '').slice(0, 120) ?? null,
        runtime: 'docker',
        task: fetched.body,
        gateApproved: true,
      });
      // Advance the kanban column to in_stack now that the stack exists.
      // Parallel to the card-based path (openNewStackDialogForTicket); without this,
      // tickets started from the Refine dialog stayed in spec_ready / backlog (#388).
      await moveTicketColumn(session.ticketId, projectDir, 'in_stack');
      await refreshStacks();
      // Clean up session after stack created
      removeRefinementSession(session.id);
      await window.sandstorm.tickets.cancelRefinement(session.id).catch(() => {});
      setShowRefineTicketDialog(false);
    } catch (err) {
      setLocalPhase('input');
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }, [session, stackName, projectDir, refreshStacks, removeRefinementSession, setShowRefineTicketDialog, moveTicketColumn]);

  const handleRetry = useCallback(async () => {
    if (!session || !projectDir) return;
    setLocalError(null);
    await window.sandstorm.tickets.cancelRefinement(session.id).catch(() => {});
    removeRefinementSession(session.id);
    const { sessionId } = await window.sandstorm.tickets.specCheckAsync(session.ticketId, projectDir);
    setCurrentRefinementSessionId(sessionId);
  }, [session, projectDir, setCurrentRefinementSessionId, removeRefinementSession]);

  /** Close the dialog — keep in-flight sessions alive. */
  const handleClose = () => {
    setShowRefineTicketDialog(false);
    // Don't clear currentRefinementSessionId — the indicator will let user reopen
  };

  /** Cancel with confirmation. */
  const handleCancelConfirm = async () => {
    if (session) {
      await window.sandstorm.tickets.cancelRefinement(session.id).catch(() => {});
      removeRefinementSession(session.id);
    }
    setConfirmingCancel(false);
    setShowRefineTicketDialog(false);
  };

  const streamingOutput = session?.streamingOutput ?? '';
  const streamPanelRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the streaming panel to the bottom as new content arrives.
  useEffect(() => {
    const el = streamPanelRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streamingOutput]);

  const isRunning = session?.status === 'running' || localPhase === 'starting';
  const isStarting = localPhase === 'starting';
  const noSession = !session;
  const showPassState = session?.status === 'ready' && gate?.passed;
  const showFailState = session?.status === 'ready' && gate && !gate.passed && !gate.error;
  const showErrorState = session?.status === 'errored' || (session?.status === 'ready' && gate?.error);
  const showInterrupted = session?.status === 'interrupted';
  const effectiveError = localError ?? sessionError ?? (gate?.error ?? null);

  return (
    <>
      {teardownConfirmPending && (
        <ConfirmDialog
          title="Tear down active stack?"
          body={`Ticket #${teardownConfirmPending.ticketId} has an active stack. Re-refining will permanently tear it down. Any unpushed work will be lost. Continue?`}
          confirmLabel="Tear Down & Refine"
          onConfirm={handleTeardownConfirm}
          onCancel={handleTeardownCancel}
          data-testid="refine-teardown-confirm-dialog"
        />
      )}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
        onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        data-testid="refine-ticket-dialog"
      >
        <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[768px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
          <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-sandstorm-text">Refine Ticket</h2>
              <p className="text-[11px] text-sandstorm-muted mt-0.5">
                Run the spec quality gate, refine, and start a stack — all in-process
              </p>
            </div>
            <button
              onClick={handleClose}
              className="text-sandstorm-muted hover:text-sandstorm-text transition-colors p-1.5 rounded-md hover:bg-sandstorm-surface-hover"
              aria-label="Close"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>

          <div className="px-6 py-5 space-y-4">
            {!project && (
              <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
                Select a project tab first — the spec gate needs a project to fetch the ticket from.
              </div>
            )}

            {effectiveError && !confirmingCancel && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5" data-testid="refine-error">
                {effectiveError}
              </div>
            )}

            {confirmingCancel && (
              <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5" data-testid="refine-cancel-confirm">
                The refinement session will be lost. Are you sure?
              </div>
            )}

            {/* Ticket ID input — shown only when starting a new refinement */}
            {noSession && (
              <div>
                <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                  Ticket ID <span className="text-sandstorm-accent">*</span>
                </label>
                <input
                  type="text"
                  value={ticketId}
                  onChange={(e) => setTicketId(e.target.value)}
                  placeholder="310"
                  className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[13px] font-mono text-sandstorm-text placeholder-sandstorm-muted/50 outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                  data-testid="refine-ticket-id"
                  autoFocus
                />
              </div>
            )}

            {/* Show ticket ID read-only when a session exists */}
            {session && (() => {
              const boardEntry = boardTickets.find(
                (t) => t.ticket_id === session.ticketId && t.project_dir === session.projectDir
              );
              const title = boardEntry?.title?.trim() || '';
              return (
                <div className="text-xs text-sandstorm-muted flex items-baseline gap-1.5 min-w-0">
                  <span className="shrink-0">Ticket:</span>
                  <span className="font-mono text-sandstorm-text shrink-0">#{session.ticketId}</span>
                  {title && (
                    <>
                      <span className="shrink-0">—</span>
                      <span className="text-sandstorm-text truncate min-w-0" data-testid="refine-ticket-title">{title}</span>
                    </>
                  )}
                </div>
              );
            })()}

            {isRunning && (
              <div className="space-y-2" data-testid="refine-running">
                <div className="text-xs text-sandstorm-muted flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="48" strokeDashoffset="32"/>
                  </svg>
                  <span>{isStarting ? 'Starting stack…' : 'Running spec gate…'}</span>
                  {!isStarting && session?.startedAt && (
                    <>
                      <span className="text-sandstorm-border">·</span>
                      <ElapsedTimer startedAt={session.startedAt} />
                    </>
                  )}
                </div>
                {!isStarting && (
                  <div
                    ref={streamPanelRef}
                    className="h-32 overflow-y-auto bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 font-mono text-[11px] text-sandstorm-muted whitespace-pre-wrap"
                    data-testid="refine-stream-panel"
                  >
                    {streamingOutput
                      ? streamingOutput.split('\n').map((line, i, arr) => {
                          const isIndicator = line.startsWith('→ ');
                          return (
                            <span
                              key={i}
                              className={isIndicator ? 'opacity-50 italic' : undefined}
                            >
                              {line}{i < arr.length - 1 ? '\n' : ''}
                            </span>
                          );
                        })
                      : <span className="opacity-50">Waiting for output…</span>}
                  </div>
                )}
              </div>
            )}

            {showInterrupted && (
              <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5" data-testid="refine-interrupted">
                Refinement was interrupted (app was closed while it ran). You can retry.
              </div>
            )}

            {showPassState && gate && (
              <div className="space-y-3" data-testid="refine-pass">
                <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5 flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M20 6L9 17l-5-5"/>
                  </svg>
                  {gate.cached
                    ? 'Ticket already passed — body unchanged since last gate run.'
                    : 'Spec quality gate passed. Ready to start a stack.'}
                </div>
                <div>
                  <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                    Stack Name <span className="text-sandstorm-accent">*</span>
                  </label>
                  <input
                    type="text"
                    value={stackName}
                    onChange={(e) => setStackName(e.target.value)}
                    disabled={isStarting}
                    className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[13px] font-mono text-sandstorm-text outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                    data-testid="refine-stack-name"
                  />
                </div>
              </div>
            )}

            {showFailState && gate && (
              <div className="space-y-3" data-testid="refine-fail">
                <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
                  Spec gate failed. {gate.gateSummary}
                </div>
                {gate.questions.length === 0 ? (
                  <div className="text-xs text-sandstorm-muted">
                    No structured questions parsed. The full report was committed to the ticket — open it on GitHub to read it.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {gate.questions.map((q, i) => {
                      const qItem: RefineQuestion = typeof q === 'string'
                        ? { id: `q${i}`, question: q as string, options: [] }
                        : (!Array.isArray((q as RefineQuestion).options) ? { ...(q as RefineQuestion), options: [] } : q as RefineQuestion);
                      const ans = answers[i] ?? { optionId: null, text: '' };
                      return (
                        <div key={i} className="space-y-2">
                          <p className="text-xs text-sandstorm-text-secondary">
                            <span className="text-sandstorm-muted">{i + 1}.</span> {qItem.question}
                          </p>
                          {qItem.options.length > 0 && (
                            <div className="space-y-1 pl-3">
                              {qItem.options.map((opt, optIdx) => {
                                const isFirstRecommended = opt.recommended === true && optIdx === qItem.options.findIndex((o) => o.recommended === true);
                                return (
                                  <label key={opt.id} className="flex items-center gap-2 cursor-pointer">
                                    <input
                                      type="radio"
                                      name={`refine-q-${i}`}
                                      value={opt.id}
                                      checked={ans.optionId === opt.id}
                                      onChange={() => {}}
                                      onClick={() => {
                                        const next = [...answers];
                                        next[i] = { ...ans, optionId: ans.optionId === opt.id ? null : opt.id };
                                        setAnswers(next);
                                      }}
                                      className="accent-sandstorm-accent"
                                      data-testid={`refine-option-${i}-${opt.id}`}
                                    />
                                    <span className="text-xs text-sandstorm-text">{opt.label}</span>
                                    {isFirstRecommended && (
                                      <span
                                        className="text-xs font-medium text-sandstorm-accent border border-sandstorm-accent/40 rounded px-1.5 py-0.5 leading-none"
                                        data-testid={`refine-option-recommended-${i}-${opt.id}`}
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
                              setAnswers(next);
                            }}
                            rows={2}
                            placeholder="Add more detail…"
                            className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs text-sandstorm-text resize-none outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                            data-testid={`refine-answer-${i}`}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {(showErrorState) && !confirmingCancel && (
              <div className="text-xs text-sandstorm-muted" data-testid="refine-error-state">
                Use Retry to run the gate again.
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
            {confirmingCancel ? (
              <>
                <button
                  onClick={() => setConfirmingCancel(false)}
                  className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
                >
                  Keep Running
                </button>
                <button
                  onClick={handleCancelConfirm}
                  className="px-4 py-2 text-xs font-medium text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-400/50 rounded-lg transition-colors"
                  data-testid="refine-cancel-confirm-btn"
                >
                  Cancel Refinement
                </button>
              </>
            ) : (
              <>
                {isRunning ? (
                  <button
                    onClick={() => setConfirmingCancel(true)}
                    className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-red-400 transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
                    data-testid="refine-cancel-btn"
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
                  >
                    {session ? 'Dismiss' : 'Cancel'}
                  </button>
                )}

                {noSession && (
                  <button
                    onClick={handleRunGate}
                    disabled={!cleanTicketId || !projectDir}
                    className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
                    data-testid="refine-run-gate"
                  >
                    Run Gate
                  </button>
                )}

                {showFailState && gate && gate.questions.length > 0 && (
                  <button
                    onClick={handleSubmitAnswers}
                    disabled={answers.some((a) => a.optionId === null && !a.text.trim())}
                    className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
                    data-testid="refine-submit-answers"
                  >
                    Submit Answers
                  </button>
                )}

                {showFailState && gate && gate.questions.length === 0 && (
                  <button
                    onClick={handleRetry}
                    className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg transition-all active:scale-[0.98] shadow-glow"
                    data-testid="refine-run-gate"
                  >
                    Run Gate
                  </button>
                )}

                {(showErrorState || showInterrupted) && (
                  <button
                    onClick={handleRetry}
                    className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg transition-all active:scale-[0.98] shadow-glow"
                    data-testid="refine-retry"
                  >
                    Retry
                  </button>
                )}

                {showPassState && (
                  <button
                    onClick={handleStartStack}
                    disabled={!stackName.trim() || isStarting}
                    className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
                    data-testid="refine-start-stack"
                  >
                    Start Stack
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
