/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { StackedHBar } from '../../../../src/renderer/components/telemetry/StackedHBar';
import type { HBarSegment } from '../../../../src/renderer/components/telemetry/StackedHBar';

const segments: HBarSegment[] = [
  { value: 60, color: '#d4a854', label: 'refine' },
  { value: 30, color: '#7b5ea7', label: 'exec' },
  { value: 10, color: '#4a8c6e', label: 'pr' },
];

describe('StackedHBar', () => {
  it('renders the container element', () => {
    render(<StackedHBar segments={segments} />);
    expect(screen.getByTestId('stacked-hbar')).toBeDefined();
  });

  it('renders one child per non-zero segment', () => {
    render(<StackedHBar segments={segments} />);
    expect(screen.getByTestId('hbar-segment-0')).toBeDefined();
    expect(screen.getByTestId('hbar-segment-1')).toBeDefined();
    expect(screen.getByTestId('hbar-segment-2')).toBeDefined();
  });

  it('renders empty bar for zero total', () => {
    render(<StackedHBar segments={[{ value: 0, color: '#fff', label: 'x' }]} />);
    const el = screen.getByTestId('stacked-hbar');
    // No segment children when total is 0
    expect(el.querySelector('[data-testid]')).toBeNull();
  });

  it('segment widths sum to 100%', () => {
    render(<StackedHBar segments={segments} total={100} />);
    const s0 = screen.getByTestId('hbar-segment-0') as HTMLElement;
    const s1 = screen.getByTestId('hbar-segment-1') as HTMLElement;
    const s2 = screen.getByTestId('hbar-segment-2') as HTMLElement;
    const w0 = parseFloat(s0.style.width);
    const w1 = parseFloat(s1.style.width);
    const w2 = parseFloat(s2.style.width);
    expect(w0 + w1 + w2).toBeCloseTo(100, 0);
  });

  it('supports dimmed prop', () => {
    render(<StackedHBar segments={[{ value: 50, color: '#d4a854', label: 'a', dimmed: true }]} />);
    const seg = screen.getByTestId('hbar-segment-0') as HTMLElement;
    expect(parseFloat(seg.style.opacity)).toBeCloseTo(0.3);
  });
});
