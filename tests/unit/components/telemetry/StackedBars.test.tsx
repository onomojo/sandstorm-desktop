/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { StackedBars } from '../../../../src/renderer/components/telemetry/StackedBars';
import type { TokenClass } from '../../../../src/renderer/components/telemetry/StackedBars';
import type { DailyEntry } from '../../../../src/main/telemetry/types';

const daily: DailyEntry[] = [
  {
    date: '2026-06-01',
    cost: 2.0,
    tokens: { input: 10_000, output: 5_000, cacheCreate: 500, cacheRead: 2_000 },
    byModel: {},
  },
  {
    date: '2026-06-02',
    cost: 3.0,
    tokens: { input: 20_000, output: 8_000, cacheCreate: 1_000, cacheRead: 4_000 },
    byModel: {},
  },
];

describe('StackedBars', () => {
  it('renders SVG for non-empty data', () => {
    render(
      <StackedBars
        data={daily}
        activeClasses={new Set<TokenClass>(['input', 'output', 'cacheCreate', 'cacheRead'])}
      />,
    );
    expect(screen.getByTestId('stacked-bars').tagName.toLowerCase()).toBe('svg');
  });

  it('renders without crash for empty data', () => {
    render(<StackedBars data={[]} activeClasses={new Set<TokenClass>(['input'])} />);
    expect(screen.getByTestId('stacked-bars')).toBeDefined();
  });

  it('shows "No classes selected" hint when all toggled off', () => {
    render(<StackedBars data={daily} activeClasses={new Set<TokenClass>()} />);
    expect(screen.getByTestId('stacked-bars').textContent).toContain('No classes selected');
  });

  it('data-ymax changes when a class is removed', () => {
    const allClasses = new Set<TokenClass>(['input', 'output', 'cacheCreate', 'cacheRead']);
    const { rerender } = render(<StackedBars data={daily} activeClasses={allClasses} />);
    const ymaxBefore = screen.getByTestId('stacked-bars').getAttribute('data-ymax');

    // Remove 'output' (large contributor)
    const withoutOutput = new Set<TokenClass>(['input', 'cacheCreate', 'cacheRead']);
    rerender(<StackedBars data={daily} activeClasses={withoutOutput} />);
    const ymaxAfter = screen.getByTestId('stacked-bars').getAttribute('data-ymax');

    expect(Number(ymaxAfter)).toBeLessThan(Number(ymaxBefore));
  });

  it('ymax is correctly computed from active classes only', () => {
    // Only input active: max sum across days is max(10000, 20000) = 20000
    const { container } = render(
      <StackedBars
        data={daily}
        activeClasses={new Set<TokenClass>(['input'])}
      />,
    );
    const svg = container.querySelector('[data-testid="stacked-bars"]');
    expect(svg?.getAttribute('data-ymax')).toBe('20000');
  });

  it('renders a date label for each entry when N <= 12', () => {
    render(
      <StackedBars
        data={daily}
        activeClasses={new Set<TokenClass>(['input', 'output', 'cacheCreate', 'cacheRead'])}
      />,
    );
    expect(screen.getByText('Jun 1')).toBeDefined();
    expect(screen.getByText('Jun 2')).toBeDefined();
  });

  it('renders at most 12 date labels for 30 entries and always includes the first', () => {
    const thirtyDays: DailyEntry[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      cost: 1.0,
      tokens: { input: 1000, output: 500, cacheCreate: 100, cacheRead: 200 },
      byModel: {},
    }));
    const { container } = render(
      <StackedBars data={thirtyDays} activeClasses={new Set<TokenClass>(['input'])} />,
    );
    const svg = container.querySelector('[data-testid="stacked-bars"]')!;
    const allTexts = Array.from(svg.querySelectorAll('text'));
    const dateTexts = allTexts.filter((t) => /^[A-Z][a-z]+ \d+$/.test(t.textContent ?? ''));
    expect(dateTexts.length).toBeLessThanOrEqual(12);
    expect(dateTexts.some((t) => t.textContent === 'Jun 1')).toBe(true);
  });

  it('renders y-axis compact top tick and baseline 0 tick', () => {
    // yMax for daily fixture (all classes): day 2 sum = 20000+8000+1000+4000 = 33000 => "33K"
    render(
      <StackedBars
        data={daily}
        activeClasses={new Set<TokenClass>(['input', 'output', 'cacheCreate', 'cacheRead'])}
      />,
    );
    expect(screen.getByText('33K')).toBeDefined();
    expect(screen.getByText('0')).toBeDefined();
  });
});
