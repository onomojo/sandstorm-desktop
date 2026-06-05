import React from 'react';

export interface HBarSegment {
  value: number;
  color: string;
  label: string;
  dimmed?: boolean;
}

interface StackedHBarProps {
  segments: HBarSegment[];
  total?: number;
  height?: number;
}

export function StackedHBar({ segments, total, height = 8 }: StackedHBarProps) {
  const t = total ?? segments.reduce((s, seg) => s + seg.value, 0);

  if (t === 0) {
    return (
      <div
        className="w-full rounded overflow-hidden bg-sandstorm-border"
        style={{ height }}
        data-testid="stacked-hbar"
      />
    );
  }

  return (
    <div
      className="flex w-full rounded overflow-hidden"
      style={{ height }}
      data-testid="stacked-hbar"
    >
      {segments
        .filter((seg) => seg.value > 0)
        .map((seg, i) => (
          <div
            key={i}
            style={{
              width: `${(seg.value / t) * 100}%`,
              backgroundColor: seg.color,
              opacity: seg.dimmed ? 0.3 : 1,
              transition: 'opacity 0.15s',
            }}
            title={`${seg.label}: ${((seg.value / t) * 100).toFixed(1)}%`}
            data-testid={`hbar-segment-${i}`}
          />
        ))}
    </div>
  );
}
