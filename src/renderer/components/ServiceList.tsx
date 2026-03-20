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
      <div className="px-6 py-3 text-sm text-sandstorm-muted border-b border-sandstorm-border">
        No services found
      </div>
    );
  }

  return (
    <div className="px-6 py-3 border-b border-sandstorm-border">
      <div className="text-xs font-medium text-sandstorm-muted uppercase tracking-wider mb-2">
        Services
      </div>
      <div className="bg-sandstorm-bg rounded-lg border border-sandstorm-border divide-y divide-sandstorm-border">
        {services.map((svc) => (
          <div
            key={svc.containerId}
            className="flex items-center justify-between px-3 py-2 text-sm"
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  svc.status === 'running'
                    ? 'bg-green-500'
                    : svc.status === 'exited'
                      ? 'bg-red-500'
                      : svc.status === 'restarting'
                        ? 'bg-yellow-500 animate-pulse'
                        : 'bg-gray-500'
                }`}
              />
              <span className="font-medium">{svc.name}</span>
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
                  className="text-xs text-sandstorm-accent hover:text-indigo-400 transition-colors"
                >
                  localhost:{svc.hostPort}
                </button>
              )}
              <button
                onClick={() => onViewLogs(svc.containerId)}
                className="text-xs px-2 py-0.5 rounded border border-sandstorm-border text-sandstorm-muted hover:text-sandstorm-text hover:bg-sandstorm-border/50 transition-colors"
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
