import React, { useEffect, useState, useRef } from 'react';
import { ServiceInfo } from '../store';

export function TaskOutput({
  stackId: _stackId,
  runtime,
  services,
}: {
  stackId: string;
  runtime: string;
  services: ServiceInfo[];
}) {
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(true);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const claudeService = services.find((s) => s.name === 'claude');
    if (!claudeService) {
      setOutput('Claude container not found');
      setLoading(false);
      return;
    }

    setLoading(true);
    window.sandstorm.logs
      .stream(claudeService.containerId, runtime)
      .then((logs) => {
        setOutput(logs || 'No output yet');
        setLoading(false);
      })
      .catch((err) => {
        setOutput(`Error loading output: ${err}`);
        setLoading(false);
      });
  }, [services, runtime]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  useEffect(() => {
    const unsub = window.sandstorm.on('task:output', (data: unknown) => {
      const { data: chunk } = data as { stackId: string; data: string };
      setOutput((prev) => prev + chunk);
    });
    return unsub;
  }, []);

  return (
    <div className="h-full flex flex-col bg-sandstorm-bg">
      <pre
        ref={outputRef}
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
