import React from 'react';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
}

export function Sparkline({ data, width = 80, height = 32, color = '#d4a854', strokeWidth = 1.5 }: SparklineProps) {
  if (data.length === 0) {
    return <svg width={width} height={height} data-testid="sparkline" />;
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pad = height * 0.08;

  const points = data
    .map((v, i) => {
      const x = data.length === 1 ? width / 2 : (i / (data.length - 1)) * width;
      const y = height - pad - ((v - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} data-testid="sparkline" style={{ overflow: 'visible' }}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
