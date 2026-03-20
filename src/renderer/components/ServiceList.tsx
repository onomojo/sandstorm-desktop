import React from 'react';
import { ServiceInfo } from '../store';

export function ServiceList({
  services,
  runtime: _runtime,
  onViewLogs,
}: {
  services: ServiceInfo[];
  runtime: string;
  onViewLogs: (containerId: string) => void;
}) {
  if (services.length === 0) {
    return (
      <div className="px-5 py-3 text-xs text-sandstorm-muted border-b border-sandstorm-border">
        No services found
      </div>
    );
  }

  return (
    <div className="px-5 py-3 border-b border-sandstorm-border shrink-0">
      <div className="text-[10px] font-semibold text-sandstorm-muted uppercase tracking-widest mb-2">
        Services
      </div>
      <div className="bg-sandstorm-bg rounded-lg border border-sandstorm-border overflow-hidden">
        {services.map((svc, i) => (
          <div
            key={svc.containerId}
            className={`flex items-center justify-between px-3 py-2 text-xs hover:bg-sandstorm-surface/50 transition-colors ${
              i > 0 ? 'border-t border-sandstorm-border' : ''
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  svc.status === 'running'
                    ? 'bg-emerald-400'
                    : svc.status === 'exited'
                      ? 'bg-red-400'
                      : svc.status === 'restarting'
                        ? 'bg-amber-400 animate-pulse'
                        : 'bg-gray-500'
                }`}
              />
              <span className="font-medium text-sandstorm-text">{svc.name}</span>
              <span className="text-sandstorm-muted capitalize">
                {svc.status}
                {svc.status === 'exited' && svc.exitCode !== undefined && (
                  <span className="text-red-400"> ({svc.exitCode})</span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {svc.hostPort && (
                <button
                  onClick={() =>
                    window.open(`http://localhost:${svc.hostPort}`, '_blank')
                  }
                  className="text-[11px] text-sandstorm-accent hover:text-sandstorm-accent-hover transition-colors font-mono"
                >
                  :{svc.hostPort}
                </button>
              )}
              <button
                onClick={() => onViewLogs(svc.containerId)}
                className="text-[11px] px-2 py-0.5 rounded-md text-sandstorm-muted hover:text-sandstorm-text-secondary hover:bg-sandstorm-surface-hover transition-colors"
              >
                Logs
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
