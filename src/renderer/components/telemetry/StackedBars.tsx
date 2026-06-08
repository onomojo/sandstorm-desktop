import React from 'react';
import type { DailyEntry } from '@main/telemetry/types';
import { formatTokensCompact } from '../../utils/format';

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

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDate(dateStr: string): string {
  const parts = dateStr.split('-');
  const month = MONTHS[parseInt(parts[1], 10) - 1];
  const day = parseInt(parts[2], 10);
  return `${month} ${day}`;
}

const Y_AXIS_W = 38;
const X_AXIS_H = 16;

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

  const plotW = width - Y_AXIS_W;
  const plotH = height - X_AXIS_H;

  const barCount = data.length;
  const barWidth = Math.max(Math.floor((plotW / barCount) * 0.7), 2);
  const barGap = Math.max((plotW - barWidth * barCount) / (barCount + 1), 1);

  const step = data.length > 12 ? Math.ceil(data.length / 12) : 1;

  const rects: React.ReactElement[] = [];
  const xLabels: React.ReactElement[] = [];

  data.forEach((day, i) => {
    const barX = Y_AXIS_W + barGap + i * (barWidth + barGap);
    let y = plotH;

    CLASS_ORDER.filter((c) => activeClasses.has(c)).forEach((cls) => {
      const val = day.tokens[cls] ?? 0;
      const barH = Math.max((val / yMax) * plotH, 0);
      y -= barH;
      if (barH > 0) {
        rects.push(
          <rect
            key={`${i}-${cls}`}
            x={barX}
            y={y}
            width={barWidth}
            height={barH}
            fill={TOKEN_COLORS[cls]}
          />,
        );
      }
    });

    if (i % step === 0) {
      xLabels.push(
        <text
          key={`label-${i}`}
          x={barX + barWidth / 2}
          y={plotH + X_AXIS_H - 3}
          textAnchor="middle"
          fontSize={9}
          className="fill-current text-sandstorm-muted"
        >
          {formatDate(day.date)}
        </text>,
      );
    }
  });

  return (
    <svg
      width={width}
      height={height}
      data-testid="stacked-bars"
      data-ymax={yMax}
    >
      <text
        x={Y_AXIS_W - 4}
        y={10}
        textAnchor="end"
        fontSize={10}
        className="fill-current text-sandstorm-muted"
      >
        {formatTokensCompact(yMax)}
      </text>
      <text
        x={Y_AXIS_W - 4}
        y={plotH}
        textAnchor="end"
        fontSize={10}
        className="fill-current text-sandstorm-muted"
      >
        0
      </text>
      {rects}
      {xLabels}
    </svg>
  );
}
