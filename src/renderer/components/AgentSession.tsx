import React, { useState, useRef, useEffect, useCallback } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentSessionProps {
  tabId: string;
  projectDir?: string;
}

export function AgentSession({ tabId, projectDir }: AgentSessionProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isQueued, setIsQueued] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // On mount, fetch full history from the backend
  useEffect(() => {
    window.sandstorm.agent.history(tabId).then((result) => {
      const typed = result.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
      setMessages(typed);
      setIsLoading(result.processing);
    });
  }, [tabId]);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (messagesEndRef.current && typeof messagesEndRef.current.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent]);

  // Listen for agent output/done/error/user-message events scoped to this tab
  useEffect(() => {
    const unsubQueued = window.sandstorm.on(
      `agent:queued:${tabId}`,
      () => {
        setIsQueued(true);
      }
    );

    const unsubOutput = window.sandstorm.on(
      `agent:output:${tabId}`,
      (data: unknown) => {
        setIsQueued(false);
        setStreamingContent((prev) => prev + (data as string));
      }
    );

    const unsubDone = window.sandstorm.on(`agent:done:${tabId}`, () => {
      setIsQueued(false);
      setIsLoading(false);
      setStreamingContent((prev) => {
        if (prev) {
          setMessages((msgs) => [...msgs, { role: 'assistant', content: prev }]);
        }
        return '';
      });
      // Re-fetch history to get authoritative message list
      window.sandstorm.agent.history(tabId).then((result) => {
        const typed = result.messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
        setMessages(typed);
        if (result.processing) {
          setIsLoading(true);
        }
      });
    });

    const unsubError = window.sandstorm.on(
      `agent:error:${tabId}`,
      (error: unknown) => {
        setIsQueued(false);
        setStreamingContent((prev) => {
          const errorMsg = (prev ? prev + '\n\n' : '') + 'Error: ' + (error as string);
          setMessages((msgs) => [
            ...msgs,
            { role: 'assistant', content: errorMsg.trim() },
          ]);
          return '';
        });
        setIsLoading(false);
      }
    );

    // Listen for user messages sent while this component might have been remounting
    const unsubUserMsg = window.sandstorm.on(
      `agent:user-message:${tabId}`,
      (message: unknown) => {
        setMessages((msgs) => {
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'user' && last.content === (message as string)) {
            return msgs;
          }
          return [...msgs, { role: 'user', content: message as string }];
        });
        setIsLoading(true);
      }
    );

    return () => {
      unsubQueued();
      unsubOutput();
      unsubDone();
      unsubError();
      unsubUserMsg();
    };
  }, [tabId]);


  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;

    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setInput('');
    setIsLoading(true);

    window.sandstorm.agent.send(tabId, trimmed, projectDir);
  }, [input, tabId, projectDir]);

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
        {isLoading && (
          <button
            onClick={() => window.sandstorm.agent.cancel(tabId)}
            className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
          >
            Cancel
          </button>
        )}
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
