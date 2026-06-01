/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditTicketDialog } from '../../../src/renderer/components/EditTicketDialog';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

const PROJECT_DIR = '/proj';
const TICKET_ID = '42';

describe('EditTicketDialog', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      showEditTicketDialog: true,
      editTicketTarget: { ticketId: TICKET_ID, projectDir: PROJECT_DIR },
      projects: [{ id: 1, name: 'proj', directory: PROJECT_DIR, added_at: '' }],
      activeProjectId: 1,
    } as any);
  });

  it('renders loading spinner initially then pre-fills textarea with raw body', async () => {
    api.tickets.fetchRaw.mockResolvedValue('Raw ticket body content');
    render(<EditTicketDialog />);

    expect(screen.getByTestId('edit-ticket-loading')).toBeDefined();

    await waitFor(() => {
      const textarea = screen.getByTestId('edit-ticket-body') as HTMLTextAreaElement;
      expect(textarea.value).toBe('Raw ticket body content');
    });
  });

  it('pre-fill body does NOT contain # Issue:/State: wrapper (round-trip guard)', async () => {
    api.tickets.fetchRaw.mockResolvedValue('Just the raw description without wrapper');
    render(<EditTicketDialog />);

    await waitFor(() => {
      const textarea = screen.getByTestId('edit-ticket-body') as HTMLTextAreaElement;
      expect(textarea.value).not.toMatch(/^# Issue:/);
      expect(textarea.value).not.toMatch(/^State:/m);
    });
  });

  it('Save button disabled when body is empty', async () => {
    api.tickets.fetchRaw.mockResolvedValue('');
    render(<EditTicketDialog />);

    await waitFor(() => {
      expect(screen.getByTestId('edit-ticket-body')).toBeDefined();
    });

    const submit = screen.getByTestId('edit-ticket-submit');
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('Save button disabled when body is only whitespace', async () => {
    api.tickets.fetchRaw.mockResolvedValue('   ');
    render(<EditTicketDialog />);

    await waitFor(() => {
      const textarea = screen.getByTestId('edit-ticket-body') as HTMLTextAreaElement;
      expect(textarea.value).toBe('   ');
    });

    const submit = screen.getByTestId('edit-ticket-submit');
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('Save button enabled when body has content', async () => {
    api.tickets.fetchRaw.mockResolvedValue('Some description');
    render(<EditTicketDialog />);

    await waitFor(() => {
      expect(screen.getByTestId('edit-ticket-submit').hasAttribute('disabled')).toBe(false);
    });
  });

  it('calls tickets.update with raw edited body (no wrapper) on save', async () => {
    const user = userEvent.setup();
    api.tickets.fetchRaw.mockResolvedValue('Original raw body');
    api.tickets.update.mockResolvedValue(undefined);
    render(<EditTicketDialog />);

    await waitFor(() => {
      expect(screen.getByTestId('edit-ticket-body')).toBeDefined();
    });

    const textarea = screen.getByTestId('edit-ticket-body');
    await user.clear(textarea);
    await user.type(textarea, 'Updated raw body');

    fireEvent.click(screen.getByTestId('edit-ticket-submit'));

    await waitFor(() => {
      expect(api.tickets.update).toHaveBeenCalledWith(PROJECT_DIR, TICKET_ID, 'Updated raw body');
    });

    // Assert no # Issue:/State: wrapper sent to update
    const [, , sentBody] = api.tickets.update.mock.calls[0];
    expect(sentBody).not.toMatch(/^# Issue:/);
    expect(sentBody).not.toMatch(/^State:/m);
  });

  it('closes and calls refreshBoardTickets on successful save', async () => {
    api.tickets.fetchRaw.mockResolvedValue('Some body');
    api.tickets.update.mockResolvedValue(undefined);
    const refreshBoardTickets = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ refreshBoardTickets } as any);

    render(<EditTicketDialog />);

    await waitFor(() => {
      expect(screen.getByTestId('edit-ticket-submit').hasAttribute('disabled')).toBe(false);
    });

    fireEvent.click(screen.getByTestId('edit-ticket-submit'));

    await waitFor(() => {
      expect(useAppStore.getState().showEditTicketDialog).toBe(false);
    });
    expect(refreshBoardTickets).toHaveBeenCalledWith(PROJECT_DIR);
  });

  it('keeps dialog open and shows error when tickets.update rejects', async () => {
    api.tickets.fetchRaw.mockResolvedValue('Some body');
    api.tickets.update.mockRejectedValue(new Error('gh auth required'));
    render(<EditTicketDialog />);

    await waitFor(() => {
      expect(screen.getByTestId('edit-ticket-submit').hasAttribute('disabled')).toBe(false);
    });

    fireEvent.click(screen.getByTestId('edit-ticket-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('edit-ticket-error').textContent).toMatch(/gh auth required/);
    });

    expect(useAppStore.getState().showEditTicketDialog).toBe(true);
    expect(screen.getByTestId('edit-ticket-dialog')).toBeDefined();
  });

  it('shows error when fetchRaw fails but still renders textarea', async () => {
    api.tickets.fetchRaw.mockRejectedValue(new Error('network error'));
    render(<EditTicketDialog />);

    await waitFor(() => {
      expect(screen.getByTestId('edit-ticket-error').textContent).toMatch(/network error/);
    });

    expect(screen.getByTestId('edit-ticket-body')).toBeDefined();
  });

  it('closes dialog when Cancel is clicked', async () => {
    api.tickets.fetchRaw.mockResolvedValue('body');
    render(<EditTicketDialog />);

    await waitFor(() => {
      expect(screen.getByTestId('edit-ticket-body')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Cancel'));
    expect(useAppStore.getState().showEditTicketDialog).toBe(false);
  });

  it('shows ticket id in dialog header', async () => {
    api.tickets.fetchRaw.mockResolvedValue('body');
    render(<EditTicketDialog />);

    expect(screen.getByText(/Edit Ticket #42/)).toBeDefined();
  });
});
