/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { ConfirmDialog } from '../../../src/renderer/components/ConfirmDialog';

describe('ConfirmDialog', () => {
  it('renders title and body', () => {
    render(
      <ConfirmDialog
        title="Confirm action"
        body="Are you sure you want to proceed?"
        confirmLabel="Yes, proceed"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('Confirm action')).toBeDefined();
    expect(screen.getByText('Are you sure you want to proceed?')).toBeDefined();
  });

  it('renders confirm and cancel buttons with correct labels', () => {
    render(
      <ConfirmDialog
        title="Title"
        body="Body"
        confirmLabel="Destroy"
        cancelLabel="Go back"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByTestId('confirm-dialog-confirm').textContent).toBe('Destroy');
    expect(screen.getByTestId('confirm-dialog-cancel').textContent).toBe('Go back');
  });

  it('uses "Cancel" as default cancel label', () => {
    render(
      <ConfirmDialog
        title="T"
        body="B"
        confirmLabel="OK"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByTestId('confirm-dialog-cancel').textContent).toBe('Cancel');
  });

  it('calls onConfirm when confirm button is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog title="T" body="B" confirmLabel="OK" onConfirm={onConfirm} onCancel={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="T" body="B" confirmLabel="OK" onConfirm={vi.fn()} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when backdrop is clicked', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="T" body="B" confirmLabel="OK" onConfirm={vi.fn()} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByRole('dialog'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('has accessible role=dialog and aria-label', () => {
    render(
      <ConfirmDialog
        title="Delete stack?"
        body="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Delete stack?');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('applies custom data-testid', () => {
    render(
      <ConfirmDialog
        title="T"
        body="B"
        confirmLabel="OK"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        data-testid="my-confirm"
      />
    );
    expect(screen.getByTestId('my-confirm')).toBeDefined();
  });
});
