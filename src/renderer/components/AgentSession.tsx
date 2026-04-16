import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore } from '../store';
import { registerAgentStreamListeners } from '../agentStreamService';
import { OuterClaudeTokenCounter } from './OuterClaudeTokenCounter';

interface AgentSessionProps {
  tabId: string;
  projectDir?: string;
}

export function AgentSession({ tabId, projectDir }: AgentSessionProps) {
  const updateAgentSession = useAppStore((s) => s.updateAgentSession);
  const clearAgentSession = useAppStore((s) => s.clearAgentSession);
  const setOuterClaudeTokens = useAppStore((s) => s.setOuterClaudeTokens);
  const clearOuterClaudeTokens = useAppStore((s) => s.clearOuterClaudeTokens);
  const sessionState = useAppStore((s) => s.agentSessions[tabId]);

  // Sync current orchestrator session tokens on mount so the counter reflects
  // the authoritative backend total (not a stale renderer snapshot) after tab
  // switches or app reload. The cancel flag prevents a late-resolving IPC call
  // from writing stale data if the tab is unmounted or the tabId changes.
  useEffect(() => {
    let cancelled = false;
    window.sandstorm.agent.tokenUsage(tabId).then((tokens) => {
      if (!cancelled) setOuterClaudeTokens(tabId, tokens);
    });
    return () => { cancelled = true; };
  }, [tabId, setOuterClaudeTokens]);

  const messages = sessionState?.messages ?? [];
  const streamingContent = sessionState?.streamingContent ?? '';
  const isLoading = sessionState?.isLoading ?? false;
  const isQueued = sessionState?.isQueued ?? false;

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Register persistent IPC listeners (once per tabId, survive unmount) and sync
  // history from the backend on every mount so state is always up to date.
  useEffect(() => {
    registerAgentStreamListeners(tabId);

    window.sandstorm.agent.history(tabId).then((result) => {
      const typed = result.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
      const currentState = useAppStore.getState().agentSessions[tabId];
      const currentStreamingContent = currentState?.streamingContent ?? '';
      // Merge: use history for messages it knows about, but preserve any trailing
      // locally-generated messages (e.g. error messages not persisted in the backend).
      const currentMessages = currentState?.messages ?? [];
      const mergedMessages =
        typed.length >= currentMessages.length
          ? typed
          : [...typed, ...currentMessages.slice(typed.length)];
      updateAgentSession(tabId, {
        messages: mergedMessages,
        // Keep isLoading true if backend is processing OR if we have active streaming content
        isLoading: result.processing || currentStreamingContent !== '',
      });
    });
  }, [tabId]);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (messagesEndRef.current && typeof messagesEndRef.current.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent]);

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Optimistic add — the agent:user-message handler deduplicates
    updateAgentSession(tabId, {
      messages: [...messages, { role: 'user', content: trimmed }],
      isLoading: true,
    });
    setInput('');
    window.sandstorm.agent.send(tabId, trimmed, projectDir);
  }, [input, tabId, projectDir, messages, updateAgentSession]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-full bg-sandstorm-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 border-b border-sandstorm-border shrink-0 h-10">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-gradient-to-br from-orange-500 to-amber-400 flex items-center justify-center">
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              className="text-white"
            >
              <path
                d="M13 3L4 14h7l-2 7 9-11h-7l2-7z"
                fill="currentColor"
              />
            </svg>
          </div>
          <span className="text-xs font-semibold text-sandstorm-muted uppercase tracking-wide">
            Agent
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isLoading && (
            <button
              onClick={() => window.sandstorm.agent.cancel(tabId)}
              className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              Cancel
            </button>
          )}
          <OuterClaudeTokenCounter tabId={tabId} />
          <button
            onClick={async () => {
              if (isLoading) {
                window.sandstorm.agent.cancel(tabId);
              }
              await window.sandstorm.agent.reset(tabId);
              clearAgentSession(tabId);
              clearOuterClaudeTokens(tabId);
            }}
            title="Start a new session (clears conversation history to reduce token usage)"
            className="text-[10px] px-2 py-0.5 rounded bg-sandstorm-surface text-sandstorm-muted hover:text-sandstorm-text hover:bg-sandstorm-border transition-colors border border-sandstorm-border"
          >
            New Session
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        {messages.length === 0 && !streamingContent && !isLoading && (
          <div className="flex items-center justify-center h-full text-sandstorm-muted text-xs">
            Ask the agent to orchestrate your stacks...
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-sandstorm-accent/90 text-white'
                  : 'bg-sandstorm-surface text-sandstorm-text border border-sandstorm-border'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {streamingContent && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-sandstorm-surface text-sandstorm-text border border-sandstorm-border whitespace-pre-wrap">
              {streamingContent}
              <span className="inline-block w-1 h-3.5 bg-sandstorm-accent ml-0.5 animate-pulse align-middle" />
            </div>
          </div>
        )}
        {isLoading && !streamingContent && (
          <div className="flex justify-start">
            <div className="rounded-lg px-3 py-2 text-sm bg-sandstorm-surface text-sandstorm-muted border border-sandstorm-border">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-sandstorm-accent animate-pulse" />
                {isQueued ? 'Message queued...' : 'Thinking...'}
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input — never disabled */}
      <div className="p-2 border-t border-sandstorm-border shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message the agent..."
            rows={1}
            className="flex-1 bg-sandstorm-surface border border-sandstorm-border rounded-lg px-3 py-2 text-sm text-sandstorm-text placeholder-sandstorm-muted resize-none focus:outline-none focus:ring-1 focus:ring-sandstorm-accent"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim()}
            className="px-3 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover disabled:opacity-50 disabled:hover:bg-sandstorm-accent text-white rounded-lg transition-all text-sm"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
