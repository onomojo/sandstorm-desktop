import React from 'react';
import type { DailyEntry } from '@main/telemetry/types';

export type TokenClass = 'input' | 'output' | 'cacheCreate' | 'cacheRead';

export const TOKEN_COLORS: Record<TokenClass, string> = {
  input: '#4a7fb5',
  output: '#7b5ea7',
  cacheCreate: '#4a8c6e',
  cacheRead: '#c9a227',
};

export const TOKEN_LABELS: Record<TokenClass, string> = {
  input: 'Input',
  output: 'Output',
  cacheCreate: 'Cache Create',
  cacheRead: 'Cache Read',
};

const CLASS_ORDER: TokenClass[] = ['cacheRead', 'cacheCreate', 'output', 'input'];

interface StackedBarsProps {
  data: DailyEntry[];
  activeClasses: Set<TokenClass>;
  width?: number;
  height?: number;
}

export function StackedBars({ data, activeClasses, width = 400, height = 120 }: StackedBarsProps) {
  if (activeClasses.size === 0) {
    return (
      <div
        style={{ width, height }}
        className="flex items-center justify-center text-sandstorm-muted text-xs"
        data-testid="stacked-bars"
        data-ymax={0}
      >
        No classes selected
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div
        style={{ width, height }}
        className="flex items-center justify-center text-sandstorm-muted text-xs"
        data-testid="stacked-bars"
        data-ymax={0}
      >
        No data
      </div>
    );
  }

  const yMax =
    data.reduce((max, day) => {
      const sum = [...activeClasses].reduce((s, cls) => s + (day.tokens[cls] ?? 0), 0);
      return Math.max(max, sum);
    }, 0) || 1;

  const barCount = data.length;
  const barWidth = Math.max(Math.floor((width / barCount) * 0.7), 2);
  const barGap = Math.max((width - barWidth * barCount) / (barCount + 1), 1);

  const rects: React.ReactElement[] = [];
  data.forEach((day, i) => {
    const x = barGap + i * (barWidth + barGap);
    let y = height;
    CLASS_ORDER.filter((c) => activeClasses.has(c)).forEach((cls) => {
      const val = day.tokens[cls] ?? 0;
      const barH = Math.max((val / yMax) * height, 0);
      y -= barH;
      if (barH > 0) {
        rects.push(
          <rect
            key={`${i}-${cls}`}
            x={x}
            y={y}
            width={barWidth}
            height={barH}
            fill={TOKEN_COLORS[cls]}
          />,
        );
      }
    });
  });

  return (
    <svg
      width={width}
      height={height}
      data-testid="stacked-bars"
      data-ymax={yMax}
    >
      {rects}
    </svg>
  );
}
