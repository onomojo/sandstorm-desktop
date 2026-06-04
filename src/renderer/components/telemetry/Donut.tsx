import React from 'react';

export interface DonutSegment {
  value: number;
  color: string;
  label: string;
}

interface DonutProps {
  segments: DonutSegment[];
  size?: number;
  centerLabel?: string;
}

export function Donut({ segments, size = 120, centerLabel }: DonutProps) {
  const cx = size / 2;
  const cy = size / 2;
  const ringW = Math.max(size * 0.13, 8);
  const r = size / 2 - ringW / 2 - 2;
  const circumference = 2 * Math.PI * r;
  const total = segments.reduce((s, seg) => s + seg.value, 0);

  let startPct = 0;

  return (
    <svg width={size} height={size} data-testid="donut">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#2a2536" strokeWidth={ringW} />
      {total > 0 &&
        segments.map((seg, i) => {
          const pct = seg.value / total;
          const segLen = pct * circumference;
          const rotDeg = -90 + startPct * 360;
          startPct += pct;
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={ringW}
              strokeDasharray={`${segLen} ${circumference - segLen + 1}`}
              transform={`rotate(${rotDeg} ${cx} ${cy})`}
              data-testid={`donut-segment-${i}`}
            />
          );
        })}
      {centerLabel && (
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#e8e4f0"
          fontSize={size * 0.11}
          fontFamily="JetBrains Mono, monospace"
          data-testid="donut-center-label"
        >
          {centerLabel}
        </text>
      )}
    </svg>
  );
}
