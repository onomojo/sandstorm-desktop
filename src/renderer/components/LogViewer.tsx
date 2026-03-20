import React, { useEffect, useState, useRef } from 'react';
import { ServiceInfo } from '../store';

export function LogViewer({
  services,
  runtime,
  selectedContainerId,
}: {
  services: ServiceInfo[];
  runtime: string;
  selectedContainerId: string | null;
}) {
  const [activeContainer, setActiveContainer] = useState(
    selectedContainerId ?? services[0]?.containerId ?? null
  );
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (selectedContainerId) {
      setActiveContainer(selectedContainerId);
    }
  }, [selectedContainerId]);

  useEffect(() => {
    if (!activeContainer) return;

    setLoading(true);
    window.sandstorm.logs
      .stream(activeContainer, runtime)
      .then((content) => {
        setLogs(content || 'No logs available');
        setLoading(false);
      })
      .catch((err) => {
        setLogs(`Error loading logs: ${err}`);
        setLoading(false);
      });
  }, [activeContainer, runtime]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="h-full flex flex-col">
      {/* Service selector */}
      <div className="px-4 py-2 border-b border-sandstorm-border flex gap-1 overflow-x-auto">
        {services.map((svc) => (
          <button
            key={svc.containerId}
            onClick={() => setActiveContainer(svc.containerId)}
            className={`px-3 py-1 text-xs rounded transition-colors whitespace-nowrap ${
              activeContainer === svc.containerId
                ? 'bg-sandstorm-accent text-white'
                : 'bg-sandstorm-bg text-sandstorm-muted hover:text-sandstorm-text border border-sandstorm-border'
            }`}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
                svc.status === 'running'
                  ? 'bg-green-500'
                  : svc.status === 'exited'
                    ? 'bg-red-500'
                    : 'bg-yellow-500'
              }`}
            />
            {svc.name}
          </button>
        ))}
      </div>

      {/* Log output */}
      <pre
        ref={logRef}
        className="flex-1 overflow-auto p-4 text-sm font-mono text-sandstorm-text/80 bg-sandstorm-bg whitespace-pre-wrap break-words"
      >
        {loading ? (
          <span className="text-sandstorm-muted">Loading logs...</span>
        ) : (
          logs
        )}
      </pre>
    </div>
  );
}
