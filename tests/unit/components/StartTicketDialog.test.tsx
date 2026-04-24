/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StartTicketDialog } from '../../../src/renderer/components/StartTicketDialog';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('StartTicketDialog', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
      showStartTicketDialog: true,
      stacks: [],
    });
  });

  it('auto-suggests stack name from the ticket id', async () => {
    const user = userEvent.setup();
    render(<StartTicketDialog />);
    await user.type(screen.getByTestId('start-ticket-id'), '310');
    const nameInput = screen.getByTestId('start-ticket-stack-name') as HTMLInputElement;
    expect(nameInput.value).toBe('ticket-310');
  });

  it('disables Launch until both fields have content', () => {
    render(<StartTicketDialog />);
    const launch = screen.getByTestId('start-ticket-launch');
    expect(launch.hasAttribute('disabled')).toBe(true);
  });

  it('fetches the ticket body and dispatches stacks.create with gateApproved + verbatim task', async () => {
    const user = userEvent.setup();
    api.tickets.fetch.mockResolvedValue({
      body: '# Issue: My ticket\n\nlong body text here', url: null,
    });
    api.stacks.create.mockResolvedValue({
      id: 'ticket-310', project: 'proj', status: 'building', services: [],
    });
    render(<StartTicketDialog />);
    await user.type(screen.getByTestId('start-ticket-id'), '310');
    fireEvent.click(screen.getByTestId('start-ticket-launch'));

    await waitFor(() => {
      expect(api.tickets.fetch).toHaveBeenCalledWith('310', '/proj');
    });
    await waitFor(() => {
      expect(api.stacks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ticket-310',
          projectDir: '/proj',
          ticket: '310',
          task: '# Issue: My ticket\n\nlong body text here',
          gateApproved: true,
        }),
      );
    });
    expect(useAppStore.getState().showStartTicketDialog).toBe(false);
  });

  it('strips a leading # from the ticket id before fetching', async () => {
    const user = userEvent.setup();
    api.tickets.fetch.mockResolvedValue({ body: 'b', url: null });
    api.stacks.create.mockResolvedValue({ id: 'x', project: 'p', status: 'building', services: [] });
    render(<StartTicketDialog />);
    await user.type(screen.getByTestId('start-ticket-id'), '#310');
    fireEvent.click(screen.getByTestId('start-ticket-launch'));
    await waitFor(() => {
      expect(api.tickets.fetch).toHaveBeenCalledWith('310', '/proj');
    });
  });

  it('surfaces an error from tickets.fetch and stays open', async () => {
    const user = userEvent.setup();
    api.tickets.fetch.mockRejectedValue(new Error('gh issue not found'));
    render(<StartTicketDialog />);
    await user.type(screen.getByTestId('start-ticket-id'), '999');
    fireEvent.click(screen.getByTestId('start-ticket-launch'));
    await waitFor(() => {
      expect(screen.getByTestId('start-ticket-error').textContent).toMatch(/gh issue not found/);
    });
    expect(useAppStore.getState().showStartTicketDialog).toBe(true);
  });
});
