import React, { useEffect, useState, useRef, useCallback } from 'react';

export const TaskOutput = React.memo(function TaskOutput({
  stackId,
  runtime,
  claudeContainerId,
}: {
  stackId: string;
  runtime: string;
  claudeContainerId: string | null;
}) {
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(true);
  const outputRef = useRef<HTMLPreElement>(null);
  const userScrolledUp = useRef(false);
  const fetchedContainerId = useRef<string | null>(null);

  useEffect(() => {
    if (!claudeContainerId) {
      if (!fetchedContainerId.current) {
        setOutput('Claude container not found');
        setLoading(false);
      }
      return;
    }

    // Skip re-fetch if we already loaded logs for this container
    if (fetchedContainerId.current === claudeContainerId) return;

    setLoading(true);
    fetchedContainerId.current = claudeContainerId;

    window.sandstorm.logs
      .stream(claudeContainerId, runtime)
      .then((logs) => {
        setOutput(logs || 'No output yet');
        setLoading(false);
      })
      .catch((err) => {
        setOutput(`Error loading output: ${err}`);
        setLoading(false);
      });
  }, [claudeContainerId, runtime]);

  // Auto-scroll to bottom only if user hasn't scrolled up
  useEffect(() => {
    if (outputRef.current && !userScrolledUp.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleScroll = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUp.current = distanceFromBottom > 50;
  }, []);

  // Listen for live output updates, filtered by stackId
  useEffect(() => {
    const unsub = window.sandstorm.on('task:output', (data: unknown) => {
      const { stackId: eventStackId, data: chunk } = data as {
        stackId: string;
        data: string;
      };
      if (eventStackId === stackId) {
        setOutput((prev) => prev + chunk);
      }
    });
    return unsub;
  }, [stackId]);

  return (
    <div className="h-full flex flex-col bg-sandstorm-bg">
      <pre
        ref={outputRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-4 text-xs font-mono leading-relaxed text-sandstorm-text-secondary whitespace-pre-wrap break-words selection:bg-sandstorm-accent/20"
      >
        {loading ? (
          <span className="text-sandstorm-muted flex items-center gap-2">
            <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25"/>
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75"/>
            </svg>
            Loading output...
          </span>
        ) : (
          output
        )}
      </pre>
    </div>
  );
}
