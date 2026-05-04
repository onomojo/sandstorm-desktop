import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useAppStore, SpecGateResult, RefinementSession } from '../store';

type LocalPhase = 'input' | 'starting';

function suggestStackName(ticketId: string): string {
  const id = ticketId.replace(/^#/, '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return id ? `ticket-${id}` : '';
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
  } = useAppStore();
  const project = activeProject();

  const [ticketId, setTicketId] = useState('');
  const [localPhase, setLocalPhase] = useState<LocalPhase>('input');
  const [answers, setAnswers] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [stackName, setStackName] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const session: RefinementSession | null = currentRefinementSessionId
    ? (refinementSessions.find((s) => s.id === currentRefinementSessionId) ?? null)
    : null;

  const cleanTicketId = useMemo(() => ticketId.trim().replace(/^#/, ''), [ticketId]);
  const projectDir = project?.directory ?? '';

  // Effective status: use session status if we have a session, otherwise local phase
  const gate: SpecGateResult | null = session?.result ?? null;
  const sessionError = session?.error ?? null;

  // Initialise answers when gate questions change
  useEffect(() => {
    if (gate && !gate.passed && gate.questions.length > 0) {
      setAnswers(gate.questions.map(() => ''));
    }
  }, [gate]);

  // Suggest stack name when gate passes
  useEffect(() => {
    if (gate?.passed && session) {
      setStackName((s) => s || suggestStackName(session.ticketId));
    }
  }, [gate?.passed, session]);

  // Hand-off from CreateTicketDialog → "Refine #N" (#317).
  useEffect(() => {
    const prefill = consumeRefineTicketPrefill();
    if (!prefill || !projectDir) return;
    setTicketId(prefill);
    void (async () => {
      const { sessionId } = await window.sandstorm.tickets.specCheckAsync(
        prefill.replace(/^#/, ''),
        projectDir,
      );
      setCurrentRefinementSessionId(sessionId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRunGate = useCallback(async () => {
    if (!cleanTicketId || !projectDir) {
      setLocalError('Ticket ID and an active project are both required');
      return;
    }
    setLocalError(null);
    const { sessionId } = await window.sandstorm.tickets.specCheckAsync(cleanTicketId, projectDir);
    setCurrentRefinementSessionId(sessionId);
  }, [cleanTicketId, projectDir, setCurrentRefinementSessionId]);

  const handleSubmitAnswers = useCallback(async () => {
    if (!session || !projectDir) return;
    const combined = (gate?.questions ?? [])
      .map((q, i) => `Q${i + 1}: ${q}\nA: ${answers[i]?.trim() || '(no answer)'}`)
      .join('\n\n');
    setLocalError(null);
    // Update session optimistically to 'running' while we wait
    upsertRefinementSession({ ...session, status: 'running', phase: 'refine' });
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
      await refreshStacks();
      // Clean up session after stack created
      removeRefinementSession(session.id);
      await window.sandstorm.tickets.cancelRefinement(session.id).catch(() => {});
      setShowRefineTicketDialog(false);
    } catch (err) {
      setLocalPhase('input');
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }, [session, stackName, projectDir, refreshStacks, removeRefinementSession, setShowRefineTicketDialog]);

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

  const isRunning = session?.status === 'running' || localPhase === 'starting';
  const isStarting = localPhase === 'starting';
  const noSession = !session;
  const showPassState = session?.status === 'ready' && gate?.passed;
  const showFailState = session?.status === 'ready' && gate && !gate.passed && !gate.error;
  const showErrorState = session?.status === 'errored' || (session?.status === 'ready' && gate?.error);
  const showInterrupted = session?.status === 'interrupted';
  const effectiveError = localError ?? sessionError ?? (gate?.error ?? null);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
      data-testid="refine-ticket-dialog"
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[560px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
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
              Select a project tab first — the spec gate runs against the project's `.sandstorm/spec-quality-gate.md`.
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
          {session && (
            <div className="text-xs text-sandstorm-muted">
              Ticket: <span className="font-mono text-sandstorm-text">#{session.ticketId}</span>
            </div>
          )}

          {isRunning && (
            <div className="text-xs text-sandstorm-muted flex items-center gap-2" data-testid="refine-running">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="48" strokeDashoffset="32"/>
              </svg>
              {isStarting ? 'Starting stack…' : 'Running spec gate…'}
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
                <div className="space-y-2">
                  {gate.questions.map((q, i) => (
                    <div key={i}>
                      <p className="text-xs text-sandstorm-text-secondary mb-1">
                        <span className="text-sandstorm-muted">{i + 1}.</span> {q}
                      </p>
                      <textarea
                        value={answers[i] ?? ''}
                        onChange={(e) => {
                          const next = [...answers];
                          next[i] = e.target.value;
                          setAnswers(next);
                        }}
                        rows={2}
                        placeholder="Your answer…"
                        className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs text-sandstorm-text resize-none outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                        data-testid={`refine-answer-${i}`}
                      />
                    </div>
                  ))}
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
                  disabled={answers.some((a) => !a.trim())}
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
  );
}
