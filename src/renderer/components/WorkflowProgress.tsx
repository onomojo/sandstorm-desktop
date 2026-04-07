import React from 'react';
import { WorkflowProgress as WorkflowProgressType, WorkflowPhaseState } from '../store';
import { formatTokenCount } from '../utils/format';

function PhaseBox({ phase, label }: { phase: WorkflowPhaseState; label: string }) {
  const isRunning = phase.status === 'running';
  const isPassed = phase.status === 'passed';
  const isFailed = phase.status === 'failed';

  let borderColor = 'border-sandstorm-border';
  let bgColor = 'bg-sandstorm-surface';
  let textColor = 'text-sandstorm-muted';
  let statusIcon = '';

  if (isRunning) {
    borderColor = 'border-blue-500/50';
    bgColor = 'bg-blue-500/10';
    textColor = 'text-blue-400';
  } else if (isPassed) {
    borderColor = 'border-emerald-500/50';
    bgColor = 'bg-emerald-500/10';
    textColor = 'text-emerald-400';
    statusIcon = '\u2713';
  } else if (isFailed) {
    borderColor = 'border-red-500/50';
    bgColor = 'bg-red-500/10';
    textColor = 'text-red-400';
    statusIcon = '\u2717';
  }

  return (
    <div
      className={`flex flex-col items-center justify-center px-3 py-2 rounded-lg border ${borderColor} ${bgColor} min-w-[80px]`}
      data-testid={`phase-${phase.phase}`}
    >
      <span className={`text-xs font-medium ${textColor}`}>{label}</span>
      <span className={`text-[10px] mt-0.5 ${textColor}`}>
        {isRunning && (
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            running
          </span>
        )}
        {isPassed && statusIcon}
        {isFailed && statusIcon}
        {phase.status === 'pending' && '\u2014'}
      </span>
    </div>
  );
}

function Arrow() {
  return (
    <svg width="20" height="12" viewBox="0 0 20 12" className="text-sandstorm-muted shrink-0 mx-0.5">
      <path d="M0 6h16M12 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DownArrow() {
  return (
    <svg width="12" height="20" viewBox="0 0 12 20" className="text-sandstorm-muted shrink-0 my-0.5">
      <path d="M6 0v16M2 12l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WorkflowProgressPanel({ progress }: { progress: WorkflowProgressType }) {
  const { outerIteration, innerIteration, phases, steps, taskPrompt, startedAt, model } = progress;

  const executionPhase = phases.find((p) => p.phase === 'execution') ?? { phase: 'execution' as const, status: 'pending' as const };
  const reviewPhase = phases.find((p) => p.phase === 'review') ?? { phase: 'review' as const, status: 'pending' as const };
  const verifyPhase = phases.find((p) => p.phase === 'verify') ?? { phase: 'verify' as const, status: 'pending' as const };

  // Calculate elapsed time
  const elapsed = startedAt ? Math.floor((Date.now() - new Date(startedAt + (startedAt.endsWith('Z') ? '' : 'Z')).getTime()) / 1000) : 0;
  const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;

  // Calculate totals
  const totalInput = steps.reduce((sum, s) => sum + s.input_tokens, 0);
  const totalOutput = steps.reduce((sum, s) => sum + s.output_tokens, 0);

  return (
    <div className="flex flex-col h-full overflow-y-auto" data-testid="workflow-progress-panel">
      {/* Loop counters */}
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-sandstorm-muted mb-2">Workflow Progress</h3>
        <div className="flex gap-3 text-xs">
          <div className="flex items-center gap-1.5 bg-sandstorm-bg px-2 py-1 rounded-md border border-sandstorm-border">
            <span className="text-sandstorm-muted">Outer Loop:</span>
            <span className="text-sandstorm-text font-medium tabular-nums" data-testid="outer-loop-counter">{outerIteration} of 5</span>
          </div>
          <div className="flex items-center gap-1.5 bg-sandstorm-bg px-2 py-1 rounded-md border border-sandstorm-border">
            <span className="text-sandstorm-muted">Inner Loop:</span>
            <span className="text-sandstorm-text font-medium tabular-nums" data-testid="inner-loop-counter">{innerIteration} of 5</span>
          </div>
        </div>
      </div>

      {/* Visual stepper */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-center">
          <PhaseBox phase={executionPhase} label="Execution" />
          <Arrow />
          <PhaseBox phase={reviewPhase} label="Review" />
        </div>
        <div className="flex justify-end pr-[40px] -mt-0.5">
          <DownArrow />
        </div>
        <div className="flex justify-end pr-0">
          <div className="mr-[0px] flex justify-center" style={{ width: '80px', marginRight: 'calc(50% - 82px)' }}>
            <PhaseBox phase={verifyPhase} label="Verify" />
          </div>
        </div>
      </div>

      {/* Separator */}
      <div className="mx-4 border-t border-sandstorm-border" />

      {/* Step token usage table */}
      <div className="px-4 pt-3 pb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-sandstorm-muted mb-2">Step Token Usage</h3>
        <div className="text-[10px] font-mono tabular-nums" data-testid="step-token-table">
          {/* Header */}
          <div className="flex text-sandstorm-muted font-medium mb-1 border-b border-sandstorm-border pb-1">
            <span className="flex-1">Phase</span>
            <span className="w-16 text-right">Input</span>
            <span className="w-16 text-right">Output</span>
          </div>
          {/* Rows */}
          {steps.map((step, i) => (
            <div
              key={`${step.phase}-${step.iteration}-${i}`}
              className={`flex py-0.5 ${step.live ? 'text-blue-400' : 'text-sandstorm-text-secondary'}`}
            >
              <span className="flex-1 capitalize">
                {step.phase} {step.iteration}
              </span>
              <span className="w-16 text-right">
                {formatTokenCount(step.input_tokens)}{step.live ? '\u25B2' : ''}
              </span>
              <span className="w-16 text-right">
                {formatTokenCount(step.output_tokens)}{step.live ? '\u25B2' : ''}
              </span>
            </div>
          ))}
          {/* Total row */}
          {steps.length > 0 && (
            <div className="flex pt-1 mt-1 border-t border-sandstorm-border text-sandstorm-text font-medium">
              <span className="flex-1">Total</span>
              <span className="w-16 text-right">{formatTokenCount(totalInput)}</span>
              <span className="w-16 text-right">{formatTokenCount(totalOutput)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Bottom info bar */}
      <div className="mt-auto mx-4 mb-3 pt-2 border-t border-sandstorm-border">
        {taskPrompt && (
          <p className="text-[10px] text-sandstorm-text-secondary truncate mb-1" title={taskPrompt}>
            Task: &ldquo;{taskPrompt}&rdquo;
          </p>
        )}
        <div className="flex items-center gap-2 text-[10px] text-sandstorm-muted tabular-nums">
          {startedAt && <span>Started: {new Date(startedAt + (startedAt.endsWith('Z') ? '' : 'Z')).toLocaleTimeString()}</span>}
          {startedAt && <span className="text-sandstorm-border">|</span>}
          <span>Elapsed: {elapsedStr}</span>
          {model && <span className="text-sandstorm-border">|</span>}
          {model && <span>Model: {model}</span>}
        </div>
      </div>
    </div>
  );
}
