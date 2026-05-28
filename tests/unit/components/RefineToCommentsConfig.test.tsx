/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(() => cleanup());
import { RefineToCommentsConfig } from '../../../src/renderer/components/scheduler/RefineToCommentsConfig';

describe('RefineToCommentsConfig', () => {
  it('renders with default label when ticketLabel is not provided', () => {
    render(<RefineToCommentsConfig />);

    const input = screen.getByTestId('refine-to-comments-label-input') as HTMLInputElement;
    expect(input.value).toBe('needs-spec');
  });

  it('renders with a custom label when ticketLabel is provided', () => {
    render(<RefineToCommentsConfig ticketLabel="my-custom-label" />);

    const input = screen.getByTestId('refine-to-comments-label-input') as HTMLInputElement;
    expect(input.value).toBe('my-custom-label');
  });

  it('invokes onChange when the input value changes', () => {
    const onChange = vi.fn();
    render(<RefineToCommentsConfig ticketLabel="needs-spec" onChange={onChange} />);

    const input = screen.getByTestId('refine-to-comments-label-input');
    fireEvent.change(input, { target: { value: 'ready-for-spec' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('ready-for-spec');
  });

  it('does not throw when onChange is not provided and input changes', () => {
    render(<RefineToCommentsConfig ticketLabel="needs-spec" />);

    const input = screen.getByTestId('refine-to-comments-label-input');
    expect(() => fireEvent.change(input, { target: { value: 'new-label' } })).not.toThrow();
  });

  it('renders the container with description text about spec-ready', () => {
    render(<RefineToCommentsConfig />);

    expect(screen.getByTestId('refine-to-comments-config')).toBeTruthy();
    const container = screen.getByTestId('refine-to-comments-config');
    expect(container.textContent).toContain('spec-ready');
  });
});
