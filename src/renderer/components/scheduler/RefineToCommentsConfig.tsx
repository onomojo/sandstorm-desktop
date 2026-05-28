import React from 'react';

interface RefineToCommentsConfigProps {
  ticketLabel?: string;
  onChange?: (ticketLabel: string) => void;
}

export function RefineToCommentsConfig({ ticketLabel, onChange }: RefineToCommentsConfigProps) {
  const value = ticketLabel ?? 'needs-spec';

  return (
    <div className="space-y-2" data-testid="refine-to-comments-config">
      <div>
        <label className="block text-[10px] text-sandstorm-muted mb-1">
          Ticket label to process
        </label>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder="needs-spec"
          className="w-full bg-sandstorm-surface border border-sandstorm-border rounded px-2 py-1 text-xs text-sandstorm-text-primary focus:outline-none focus:border-sandstorm-accent"
          data-testid="refine-to-comments-label-input"
        />
      </div>
      <p className="text-[10px] text-sandstorm-muted">
        On each fire, open tickets with this label authored by you are checked against the spec
        quality gate. Questions are posted as comments; once answered and the gate passes, the label
        swaps to{' '}
        <span className="font-mono text-sandstorm-text-secondary">spec-ready</span>.
      </p>
    </div>
  );
}
