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
    // Auto-scroll to bottom
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // Listen for live output updates
  useEffect(() => {
    const unsub = window.sandstorm.on('task:output', (data: unknown) => {
      const { data: chunk } = data as { stackId: string; data: string };
      setOutput((prev) => prev + chunk);
    });
    return unsub;
  }, []);

  return (
    <div className="h-full flex flex-col">
      <pre
        ref={outputRef}
        className="flex-1 overflow-auto p-4 text-sm font-mono text-sandstorm-text/90 bg-sandstorm-bg whitespace-pre-wrap break-words"
      >
        {loading ? (
          <span className="text-sandstorm-muted">Loading output...</span>
        ) : (
          output
        )}
      </pre>
    </div>
  );
}
