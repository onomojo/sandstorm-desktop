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
});
