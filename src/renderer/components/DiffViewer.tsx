import React from 'react';

export function DiffViewer({ diff }: { diff: string }) {
  if (!diff) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-sandstorm-muted">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
        </svg>
        <p className="text-sm font-medium text-sandstorm-text-secondary">No changes detected</p>
        <p className="text-xs text-sandstorm-muted mt-1">Run a task to see diffs here</p>
      </div>
    );
  }

  const lines = diff.split('\n');

  return (
    <div className="h-full overflow-auto bg-sandstorm-bg">
      <pre className="p-4 text-xs font-mono leading-[1.7]">
        {lines.map((line, i) => {
          let className = 'text-sandstorm-text-secondary';
          let bgClass = '';
          if (line.startsWith('+') && !line.startsWith('+++')) {
            className = 'text-emerald-400';
            bgClass = 'bg-emerald-500/[0.07]';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            className = 'text-red-400';
            bgClass = 'bg-red-500/[0.07]';
          } else if (line.startsWith('@@')) {
            className = 'text-sandstorm-accent';
            bgClass = 'bg-sandstorm-accent/[0.05]';
          } else if (line.startsWith('diff ') || line.startsWith('index ')) {
            className = 'text-sandstorm-muted font-semibold';
          } else if (line.startsWith('---') || line.startsWith('+++')) {
            className = 'text-sandstorm-muted';
          }

          return (
            <div key={i} className={`${className} ${bgClass} px-2 -mx-2 rounded-sm`}>
              {line || '\u00A0'}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
