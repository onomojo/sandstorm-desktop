/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { Donut } from '../../../../src/renderer/components/telemetry/Donut';

const segments = [
  { value: 60, color: '#d4a854', label: 'sonnet' },
  { value: 40, color: '#7b5ea7', label: 'opus' },
];

describe('Donut', () => {
  it('renders an SVG element', () => {
    render(<Donut segments={segments} />);
    expect(screen.getByTestId('donut').tagName.toLowerCase()).toBe('svg');
  });

  it('renders one segment circle per non-zero segment', () => {
    render(<Donut segments={segments} />);
    expect(screen.getByTestId('donut-segment-0')).toBeDefined();
    expect(screen.getByTestId('donut-segment-1')).toBeDefined();
  });

  it('renders center label when provided', () => {
    render(<Donut segments={segments} centerLabel="$10.50" />);
    expect(screen.getByTestId('donut-center-label').textContent).toBe('$10.50');
  });

  it('renders without crash for empty segments', () => {
    const { container } = render(<Donut segments={[]} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders without crash for all-zero values', () => {
    const { container } = render(<Donut segments={[{ value: 0, color: '#000', label: 'a' }]} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('segments use the correct colors', () => {
    render(<Donut segments={segments} />);
    const seg0 = screen.getByTestId('donut-segment-0');
    expect(seg0.getAttribute('stroke')).toBe('#d4a854');
    const seg1 = screen.getByTestId('donut-segment-1');
    expect(seg1.getAttribute('stroke')).toBe('#7b5ea7');
  });
});
