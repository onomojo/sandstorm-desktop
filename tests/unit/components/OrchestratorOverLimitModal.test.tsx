/**
 * @vitest-environment jsdom
 *
 * Verifies the orchestrator over-limit modal required by issue #238.
 * Copy is VERBATIM-locked — the test imports the exported constant and the
 * rendered element must contain that exact string.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  OrchestratorOverLimitModal,
  ORCHESTRATOR_OVER_LIMIT_MESSAGE,
} from '../../../src/renderer/components/OrchestratorOverLimitModal';

afterEach(() => {
  cleanup();
});

describe('OrchestratorOverLimitModal', () => {
  it('exports the verbatim copy required by issue #238', () => {
    expect(ORCHESTRATOR_OVER_LIMIT_MESSAGE).toBe(
      'Your orchestrator session is too large. Wrap up the current session and start a new one. New stack creation is blocked until you start a new orchestrator session.'
    );
  });

  it('renders the verbatim message text', () => {
    render(<OrchestratorOverLimitModal onDismiss={() => {}} />);
    const modal = screen.getByTestId('orchestrator-over-limit-modal');
    expect(modal.textContent).toContain(ORCHESTRATOR_OVER_LIMIT_MESSAGE);
  });

  it('calls onDismiss when the Dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<OrchestratorOverLimitModal onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('orchestrator-over-limit-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when the backdrop is clicked', () => {
    const onDismiss = vi.fn();
    render(<OrchestratorOverLimitModal onDismiss={onDismiss} />);
    // Click the outer backdrop (the element carrying the testid)
    fireEvent.click(screen.getByTestId('orchestrator-over-limit-modal'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not call onDismiss when the modal content is clicked', () => {
    const onDismiss = vi.fn();
    render(<OrchestratorOverLimitModal onDismiss={onDismiss} />);
    // Click the message text, which is inside the stopPropagation container.
    const heading = screen.getByText('Orchestrator session too large');
    fireEvent.click(heading);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('uses role=dialog with aria-modal for accessibility', () => {
    render(<OrchestratorOverLimitModal onDismiss={() => {}} />);
    const modal = screen.getByRole('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
  });
});
