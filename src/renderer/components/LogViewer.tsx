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
    <div className="h-full flex flex-col bg-sandstorm-bg">
      {/* Service selector */}
      {services.length > 1 && (
        <div className="px-4 py-2 border-b border-sandstorm-border flex gap-1 overflow-x-auto shrink-0">
          {services.map((svc) => (
            <button
              key={svc.containerId}
              onClick={() => setActiveContainer(svc.containerId)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md transition-all whitespace-nowrap ${
                activeContainer === svc.containerId
                  ? 'bg-sandstorm-accent/10 text-sandstorm-accent border border-sandstorm-accent/20'
                  : 'text-sandstorm-muted hover:text-sandstorm-text-secondary hover:bg-sandstorm-surface-hover border border-transparent'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  svc.status === 'running'
                    ? 'bg-emerald-400'
                    : svc.status === 'exited'
                      ? 'bg-red-400'
                      : 'bg-amber-400'
                }`}
              />
              {svc.name}
            </button>
          ))}
        </div>
      )}

      {/* Log output */}
      <pre
        ref={logRef}
        className="flex-1 overflow-auto p-4 text-xs font-mono leading-relaxed text-sandstorm-text-secondary whitespace-pre-wrap break-words selection:bg-sandstorm-accent/20"
      >
        {loading ? (
          <span className="text-sandstorm-muted flex items-center gap-2">
            <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25"/>
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75"/>
            </svg>
            Loading logs...
          </span>
        ) : (
          logs
        )}
      </pre>
    </div>
  );
}
