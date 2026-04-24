import React, { useState, useMemo } from 'react';
import { useAppStore, SpecGateResult } from '../store';

type Phase = 'input' | 'running' | 'pass' | 'fail' | 'starting';

function suggestStackName(ticketId: string): string {
  const id = ticketId.replace(/^#/, '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return id ? `ticket-${id}` : '';
}

export function RefineTicketDialog() {
  const { setShowRefineTicketDialog, refreshStacks, activeProject } = useAppStore();
  const project = activeProject();

  const [ticketId, setTicketId] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [gate, setGate] = useState<SpecGateResult | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stackName, setStackName] = useState('');

  const close = () => {
    setShowRefineTicketDialog(false);
  };

  const cleanTicketId = useMemo(() => ticketId.trim().replace(/^#/, ''), [ticketId]);
  const projectDir = project?.directory ?? '';

  const handleRunGate = async () => {
    if (!cleanTicketId || !projectDir) {
      setError('Ticket ID and an active project are both required');
      return;
    }
    setError(null);
    setPhase('running');
    try {
      const result = await window.sandstorm.tickets.specCheck(cleanTicketId, projectDir);
      setGate(result);
      if (result.error) {
        setPhase('fail');
        setError(result.error);
      } else if (result.passed) {
        setPhase('pass');
        setStackName((s) => s || suggestStackName(cleanTicketId));
      } else {
        setAnswers(result.questions.map(() => ''));
        setPhase('fail');
      }
    } catch (err) {
      setPhase('fail');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSubmitAnswers = async () => {
    if (!cleanTicketId || !projectDir) return;
    const combined = (gate?.questions ?? [])
      .map((q, i) => `Q${i + 1}: ${q}\nA: ${answers[i]?.trim() || '(no answer)'}`)
      .join('\n\n');
    setError(null);
    setPhase('running');
    try {
      const result = await window.sandstorm.tickets.specRefine(cleanTicketId, projectDir, combined);
      setGate(result);
      if (result.error) {
        setPhase('fail');
        setError(result.error);
      } else if (result.passed) {
        setPhase('pass');
        setStackName((s) => s || suggestStackName(cleanTicketId));
      } else {
        setAnswers(result.questions.map(() => ''));
        setPhase('fail');
      }
    } catch (err) {
      setPhase('fail');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStartStack = async () => {
    if (!cleanTicketId || !projectDir) return;
    const name = stackName.trim();
    if (!name) {
      setError('Stack name is required');
      return;
    }
    setError(null);
    setPhase('starting');
    try {
      const fetched = await window.sandstorm.tickets.fetch(cleanTicketId, projectDir);
      await window.sandstorm.stacks.create({
        name,
        projectDir,
        ticket: cleanTicketId,
        branch: `feat/${cleanTicketId}-${name}`,
        description: fetched.body.split('\n').find((l) => l.trim())?.replace(/^#\s*/, '').slice(0, 120) ?? null,
        runtime: 'docker',
        task: fetched.body,
        gateApproved: true,
      });
      await refreshStacks();
      close();
    } catch (err) {
      setPhase('pass');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
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
            onClick={close}
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

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5" data-testid="refine-error">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
              Ticket ID <span className="text-sandstorm-accent">*</span>
            </label>
            <input
              type="text"
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
              placeholder="310"
              disabled={phase === 'running' || phase === 'starting'}
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[13px] font-mono text-sandstorm-text placeholder-sandstorm-muted/50 outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
              data-testid="refine-ticket-id"
              autoFocus
            />
          </div>

          {phase === 'running' && (
            <div className="text-xs text-sandstorm-muted flex items-center gap-2" data-testid="refine-running">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="48" strokeDashoffset="32"/>
              </svg>
              Running spec gate…
            </div>
          )}

          {phase === 'starting' && (
            <div className="text-xs text-sandstorm-muted flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="48" strokeDashoffset="32"/>
              </svg>
              Starting stack…
            </div>
          )}

          {gate && phase === 'pass' && (
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
                  className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[13px] font-mono text-sandstorm-text outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                  data-testid="refine-stack-name"
                />
              </div>
            </div>
          )}

          {gate && phase === 'fail' && !gate.error && (
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
        </div>

        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={close}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
          >
            Cancel
          </button>
          {(phase === 'input' || (phase === 'fail' && (gate?.questions.length ?? 0) === 0)) && (
            <button
              onClick={handleRunGate}
              disabled={!cleanTicketId || !projectDir}
              className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
              data-testid="refine-run-gate"
            >
              Run Gate
            </button>
          )}
          {phase === 'fail' && gate && gate.questions.length > 0 && (
            <button
              onClick={handleSubmitAnswers}
              disabled={answers.some((a) => !a.trim())}
              className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
              data-testid="refine-submit-answers"
            >
              Submit Answers
            </button>
          )}
          {phase === 'pass' && (
            <button
              onClick={handleStartStack}
              disabled={!stackName.trim()}
              className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
              data-testid="refine-start-stack"
            >
              Start Stack
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
