/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { DiscardStackDialog } from '../../../src/renderer/components/DiscardStackDialog';

describe('DiscardStackDialog', () => {
  it('renders title and warning body', () => {
    render(
      <DiscardStackDialog
        onBackToBacklog={vi.fn()}
        onCloseTicket={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('Discard stack')).toBeDefined();
    expect(screen.getByText(/tear down the local stack/i)).toBeDefined();
  });

  it('renders three action buttons', () => {
    render(
      <DiscardStackDialog
        onBackToBacklog={vi.fn()}
        onCloseTicket={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByTestId('discard-dialog-cancel')).toBeDefined();
    expect(screen.getByTestId('discard-dialog-close-ticket')).toBeDefined();
    expect(screen.getByTestId('discard-dialog-back-to-backlog')).toBeDefined();
  });

  it('calls onBackToBacklog when Back to backlog is clicked', () => {
    const onBackToBacklog = vi.fn();
    render(
      <DiscardStackDialog
        onBackToBacklog={onBackToBacklog}
        onCloseTicket={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('discard-dialog-back-to-backlog'));
    expect(onBackToBacklog).toHaveBeenCalledOnce();
  });

  it('calls onCloseTicket when Close ticket is clicked', () => {
    const onCloseTicket = vi.fn();
    render(
      <DiscardStackDialog
        onBackToBacklog={vi.fn()}
        onCloseTicket={onCloseTicket}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('discard-dialog-close-ticket'));
    expect(onCloseTicket).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(
      <DiscardStackDialog
        onBackToBacklog={vi.fn()}
        onCloseTicket={vi.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByTestId('discard-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when backdrop is clicked', () => {
    const onCancel = vi.fn();
    render(
      <DiscardStackDialog
        onBackToBacklog={vi.fn()}
        onCloseTicket={vi.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByRole('dialog'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('has accessible role=dialog, aria-modal, and aria-label', () => {
    render(
      <DiscardStackDialog
        onBackToBacklog={vi.fn()}
        onCloseTicket={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Discard stack');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('applies custom data-testid', () => {
    render(
      <DiscardStackDialog
        onBackToBacklog={vi.fn()}
        onCloseTicket={vi.fn()}
        onCancel={vi.fn()}
        data-testid="my-discard-dialog"
      />
    );
    expect(screen.getByTestId('my-discard-dialog')).toBeDefined();
  });
});
