/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateTicketDialog } from '../../../src/renderer/components/CreateTicketDialog';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('CreateTicketDialog', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
      showCreateTicketDialog: true,
      showRefineTicketDialog: false,
    });
  });

  it('renders title + body inputs', () => {
    render(<CreateTicketDialog />);
    expect(screen.getByTestId('create-ticket-title')).toBeDefined();
    expect(screen.getByTestId('create-ticket-body')).toBeDefined();
  });

  it('disables File Ticket until both fields have content', async () => {
    render(<CreateTicketDialog />);
    const submit = screen.getByTestId('create-ticket-submit');
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('files the ticket via tickets.create with the project dir + trimmed values', async () => {
    const user = userEvent.setup();
    api.tickets.create.mockResolvedValue({
      url: 'https://github.com/o/r/issues/77', number: 77, ticketId: '77',
    });
    render(<CreateTicketDialog />);

    await user.type(screen.getByTestId('create-ticket-title'), '  My Title  ');
    await user.type(screen.getByTestId('create-ticket-body'), '  My Body  ');
    fireEvent.click(screen.getByTestId('create-ticket-submit'));

    await waitFor(() => {
      expect(api.tickets.create).toHaveBeenCalledWith('/proj', 'My Title', 'My Body');
    });
    await waitFor(() => screen.getByTestId('create-ticket-success'));
    expect(screen.getByText(/Filed issue #77/)).toBeDefined();
  });

  it('shows the Refine button after success and hands off via store', async () => {
    const user = userEvent.setup();
    api.tickets.create.mockResolvedValue({
      url: 'https://github.com/o/r/issues/77', number: 77, ticketId: '77',
    });
    render(<CreateTicketDialog />);
    await user.type(screen.getByTestId('create-ticket-title'), 't');
    await user.type(screen.getByTestId('create-ticket-body'), 'b');
    fireEvent.click(screen.getByTestId('create-ticket-submit'));
    await waitFor(() => screen.getByTestId('create-ticket-refine-now'));

    fireEvent.click(screen.getByTestId('create-ticket-refine-now'));
    expect(useAppStore.getState().showCreateTicketDialog).toBe(false);
    expect(useAppStore.getState().showRefineTicketDialog).toBe(true);
  });

  it('surfaces an error from tickets.create', async () => {
    const user = userEvent.setup();
    api.tickets.create.mockRejectedValue(new Error('gh auth required'));
    render(<CreateTicketDialog />);
    await user.type(screen.getByTestId('create-ticket-title'), 't');
    await user.type(screen.getByTestId('create-ticket-body'), 'b');
    fireEvent.click(screen.getByTestId('create-ticket-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('create-ticket-error').textContent).toMatch(/gh auth required/);
    });
  });

  it('disables Submit when no project is active', () => {
    useAppStore.setState({ activeProjectId: null });
    render(<CreateTicketDialog />);
    const submit = screen.getByTestId('create-ticket-submit');
    expect(submit.hasAttribute('disabled')).toBe(true);
  });
});
