import React from 'react';
import { AgentSession } from './AgentSession';

const OUTER_CLAUDE_TAB_ID = 'outer-claude';

interface Props {
  onClose: () => void;
  projectDir?: string;
}

export function AskClaudeModal({ onClose, projectDir }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative flex flex-col bg-sandstorm-surface border border-sandstorm-border rounded-xl shadow-dialog"
        style={{ width: '820px', height: '80vh', maxHeight: '680px' }}
        data-testid="ask-claude-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-sandstorm-border shrink-0">
          <div className="flex items-center gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-sandstorm-accent">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="text-sm font-semibold text-sandstorm-text">Ask Claude</span>
            <span className="text-xs text-sandstorm-muted">Outer orchestrator</span>
          </div>
          <button
            onClick={onClose}
            className="text-sandstorm-muted hover:text-sandstorm-text transition-colors p-1 rounded"
            data-testid="ask-claude-modal-close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Agent session */}
        <div className="flex-1 overflow-hidden">
          <AgentSession tabId={OUTER_CLAUDE_TAB_ID} projectDir={projectDir} />
        </div>
      </div>
    </div>
  );
}
