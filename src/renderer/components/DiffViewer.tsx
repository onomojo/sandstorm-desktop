import React from 'react';

export function DiffViewer({ diff }: { diff: string }) {
  if (!diff) {
    return (
      <div className="h-full flex items-center justify-center text-sandstorm-muted text-sm">
        No changes detected
      </div>
    );
  }

  const lines = diff.split('\n');

  return (
    <div className="h-full overflow-auto">
      <pre className="p-4 text-sm font-mono leading-relaxed">
        {lines.map((line, i) => {
          let className = 'text-sandstorm-text/80';
          if (line.startsWith('+') && !line.startsWith('+++')) {
            className = 'text-green-400 bg-green-900/20';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            className = 'text-red-400 bg-red-900/20';
          } else if (line.startsWith('@@')) {
            className = 'text-sandstorm-accent';
          } else if (line.startsWith('diff ') || line.startsWith('index ')) {
            className = 'text-sandstorm-muted font-semibold';
          }

          return (
            <div key={i} className={`${className} px-2`}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
