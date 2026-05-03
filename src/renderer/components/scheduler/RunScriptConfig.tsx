import React from 'react';

interface RunScriptConfigProps {
  scriptName: string;
}

export function RunScriptConfig({ scriptName }: RunScriptConfigProps) {
  return (
    <div className="text-[10px] text-sandstorm-muted" data-testid="run-script-config">
      Will run{' '}
      <span className="font-mono text-sandstorm-text-secondary">
        .sandstorm/scripts/scheduled/{scriptName}
      </span>{' '}
      when the schedule fires. The script must be executable.
    </div>
  );
}
