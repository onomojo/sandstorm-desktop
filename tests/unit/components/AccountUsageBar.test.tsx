/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AccountUsageBar } from '../../../src/renderer/components/AccountUsageBar';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('AccountUsageBar', () => {
  beforeEach(() => {
    mockSandstormApi();
    localStorage.clear();
    useAppStore.setState({
      globalTokenUsage: null,
      tokenBudget: 0,
    });
  });

  it('renders nothing when no usage data', () => {
    const { container } = render(<AccountUsageBar />);
    expect(container.innerHTML).toBe('');
  });

  it('renders token counter when usage exists but no budget', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 300000,
        total_output_tokens: 200000,
        total_tokens: 500000,
        per_stack: [],
      },
    });
    render(<AccountUsageBar />);
    expect(screen.getByTestId('usage-counter')).toBeDefined();
    expect(screen.getByTestId('usage-counter').textContent).toBe('500.0k');
  });

  it('renders progress bar when budget is set', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 300000,
        total_output_tokens: 200000,
        total_tokens: 500000,
        per_stack: [],
      },
      tokenBudget: 1000000,
    });
    render(<AccountUsageBar />);
    expect(screen.getByTestId('usage-progress-fill')).toBeDefined();
    expect(screen.getByTestId('usage-percent').textContent).toBe('50%');
  });

  it('caps progress at 100% when over budget', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 800000,
        total_output_tokens: 700000,
        total_tokens: 1500000,
        per_stack: [],
      },
      tokenBudget: 1000000,
    });
    render(<AccountUsageBar />);
    expect(screen.getByTestId('usage-percent').textContent).toBe('100%');
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.style.width).toBe('100%');
  });

  it('opens budget popover on click', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_tokens: 0,
        per_stack: [],
      },
    });
    render(<AccountUsageBar />);
    expect(screen.queryByTestId('budget-popover')).toBeNull();
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    expect(screen.getByTestId('budget-popover')).toBeDefined();
  });

  it('sets budget from preset button', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 100000,
        total_output_tokens: 50000,
        total_tokens: 150000,
        per_stack: [],
      },
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    fireEvent.click(screen.getByTestId('budget-preset-1000000'));

    // Popover should close
    expect(screen.queryByTestId('budget-popover')).toBeNull();
    // Budget should be set
    expect(useAppStore.getState().tokenBudget).toBe(1000000);
    // Should now show progress bar
    expect(screen.getByTestId('usage-progress-fill')).toBeDefined();
    expect(screen.getByTestId('usage-percent').textContent).toBe('15%');
  });

  it('sets custom budget with shorthand notation', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_tokens: 0,
        per_stack: [],
      },
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));

    const input = screen.getByTestId('custom-budget-input');
    fireEvent.change(input, { target: { value: '2M' } });
    fireEvent.submit(input.closest('form')!);

    expect(useAppStore.getState().tokenBudget).toBe(2000000);
  });

  it('clears budget when clear button is clicked', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 100000,
        total_output_tokens: 50000,
        total_tokens: 150000,
        per_stack: [],
      },
      tokenBudget: 1000000,
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    fireEvent.click(screen.getByTestId('clear-budget'));

    expect(useAppStore.getState().tokenBudget).toBe(0);
    // Should switch back to counter mode
    expect(screen.getByTestId('usage-counter')).toBeDefined();
  });

  it('persists budget to localStorage', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_tokens: 0,
        per_stack: [],
      },
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));
    fireEvent.click(screen.getByTestId('budget-preset-5000000'));

    expect(localStorage.getItem('sandstorm-token-budget')).toBe('5000000');
  });

  it('shows correct color for high usage (red at 90%+)', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 500000,
        total_output_tokens: 450000,
        total_tokens: 950000,
        per_stack: [],
      },
      tokenBudget: 1000000,
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-red-500');
    const percent = screen.getByTestId('usage-percent');
    expect(percent.className).toContain('text-red-400');
  });

  it('shows correct color for medium usage (yellow at 50-74%)', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 300000,
        total_output_tokens: 300000,
        total_tokens: 600000,
        per_stack: [],
      },
      tokenBudget: 1000000,
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-yellow-500');
  });

  it('shows correct color for low usage (green at <50%)', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 100000,
        total_output_tokens: 100000,
        total_tokens: 200000,
        per_stack: [],
      },
      tokenBudget: 1000000,
    });
    render(<AccountUsageBar />);
    const fill = screen.getByTestId('usage-progress-fill');
    expect(fill.className).toContain('bg-emerald-500');
  });

  it('displays usage breakdown in popover', () => {
    useAppStore.setState({
      globalTokenUsage: {
        total_input_tokens: 300000,
        total_output_tokens: 200000,
        total_tokens: 500000,
        per_stack: [],
      },
      tokenBudget: 1000000,
    });
    render(<AccountUsageBar />);
    fireEvent.click(screen.getByTestId('usage-bar-button'));

    const popover = screen.getByTestId('budget-popover');
    expect(popover.textContent).toContain('500.0k');
    expect(popover.textContent).toContain('300.0k');
    expect(popover.textContent).toContain('200.0k');
    expect(popover.textContent).toContain('1.00M'); // budget
  });
});
