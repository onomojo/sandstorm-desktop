/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { Sparkline } from '../../../../src/renderer/components/telemetry/Sparkline';

describe('Sparkline', () => {
  it('renders an SVG element', () => {
    render(<Sparkline data={[1, 2, 3]} />);
    expect(screen.getByTestId('sparkline').tagName.toLowerCase()).toBe('svg');
  });

  it('renders without crash on empty data', () => {
    const { container } = render(<Sparkline data={[]} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    // No polyline for empty data
    expect(container.querySelector('polyline')).toBeNull();
  });

  it('renders a polyline for non-empty data', () => {
    const { container } = render(<Sparkline data={[1, 3, 2]} />);
    expect(container.querySelector('polyline')).toBeTruthy();
  });

  it('renders without crash for single data point', () => {
    const { container } = render(<Sparkline data={[5]} />);
    expect(container.querySelector('polyline')).toBeTruthy();
  });

  it('renders without crash for all-zero data', () => {
    const { container } = render(<Sparkline data={[0, 0, 0]} />);
    expect(container.querySelector('polyline')).toBeTruthy();
  });

  it('respects width and height props', () => {
    render(<Sparkline data={[1, 2]} width={120} height={50} />);
    const svg = screen.getByTestId('sparkline');
    expect(svg.getAttribute('width')).toBe('120');
    expect(svg.getAttribute('height')).toBe('50');
  });
});
