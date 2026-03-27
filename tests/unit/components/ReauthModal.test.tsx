/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReauthModal } from '../../../src/renderer/components/ReauthModal';
import { mockSandstormApi } from './setup';

describe('ReauthModal', () => {
  let api: ReturnType<typeof mockSandstormApi>;
  let onClose: ReturnType<typeof vi.fn>;
  // Track event listeners registered via window.sandstorm.on
  let eventListeners: Record<string, (...args: unknown[]) => void>;

  beforeEach(() => {
    eventListeners = {};
    api = mockSandstormApi();
    // Capture event listeners so we can trigger them in tests
    api.on.mockImplementation((channel: string, callback: (...args: unknown[]) => void) => {
      eventListeners[channel] = callback;
      return () => { delete eventListeners[channel]; };
    });
    onClose = vi.fn();
  });

  it('renders the modal with authentication required message', () => {
    render(<ReauthModal onClose={onClose} />);
    expect(screen.getByText('Authentication Required')).toBeDefined();
    expect(screen.getByText(/session has expired or is unauthorized/)).toBeDefined();
    expect(screen.getByText('Re-authenticate')).toBeDefined();
  });

  it('calls auth.login when Re-authenticate button is clicked', async () => {
    render(<ReauthModal onClose={onClose} />);
    const button = screen.getByText('Re-authenticate');
    fireEvent.click(button);
    await waitFor(() => {
      expect(api.auth.login).toHaveBeenCalledTimes(1);
    });
  });

  it('shows loading state while authenticating', async () => {
    // Make login hang (never resolve)
    api.auth.login.mockReturnValue(new Promise(() => {}));
    render(<ReauthModal onClose={onClose} />);
    fireEvent.click(screen.getByText('Re-authenticate'));
    await waitFor(() => {
      expect(screen.getByText('Opening browser...')).toBeDefined();
    });
  });

  it('shows browser opened message when auth:url-opened fires', async () => {
    api.auth.login.mockReturnValue(new Promise(() => {}));
    render(<ReauthModal onClose={onClose} />);
    fireEvent.click(screen.getByText('Re-authenticate'));

    // Simulate the auth:url-opened event
    await waitFor(() => {
      expect(eventListeners['auth:url-opened']).toBeDefined();
    });
    eventListeners['auth:url-opened']();

    await waitFor(() => {
      expect(screen.getByText(/Complete sign-in there/)).toBeDefined();
      expect(screen.getByText('Waiting for sign-in...')).toBeDefined();
    });
  });

  it('calls onClose when auth:completed fires with success', async () => {
    api.auth.login.mockReturnValue(new Promise(() => {}));
    render(<ReauthModal onClose={onClose} />);
    fireEvent.click(screen.getByText('Re-authenticate'));

    await waitFor(() => {
      expect(eventListeners['auth:completed']).toBeDefined();
    });
    eventListeners['auth:completed'](true);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('shows error when auth:completed fires with failure', async () => {
    api.auth.login.mockReturnValue(new Promise(() => {}));
    render(<ReauthModal onClose={onClose} />);
    fireEvent.click(screen.getByText('Re-authenticate'));

    await waitFor(() => {
      expect(eventListeners['auth:completed']).toBeDefined();
    });
    eventListeners['auth:completed'](false);

    await waitFor(() => {
      expect(screen.getByText('Authentication failed. Please try again.')).toBeDefined();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows error when login returns failure', async () => {
    api.auth.login.mockResolvedValue({ success: false, error: 'Token revoked' });
    render(<ReauthModal onClose={onClose} />);
    fireEvent.click(screen.getByText('Re-authenticate'));

    await waitFor(() => {
      expect(screen.getByText('Token revoked')).toBeDefined();
    });
  });

  it('calls onClose when Dismiss button is clicked', () => {
    render(<ReauthModal onClose={onClose} />);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when clicking the backdrop', () => {
    render(<ReauthModal onClose={onClose} />);
    // The backdrop is the outermost div with the fixed class
    const backdrop = screen.getByText('Authentication Required').closest('.fixed');
    if (backdrop) {
      fireEvent.click(backdrop);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when clicking the X button', () => {
    render(<ReauthModal onClose={onClose} />);
    // The X button is in the header next to the title
    const header = screen.getByText('Authentication Required').closest('div');
    const closeButton = header?.parentElement?.querySelector('button');
    if (closeButton) {
      fireEvent.click(closeButton);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('registers auth:url-opened and auth:completed listeners', () => {
    render(<ReauthModal onClose={onClose} />);
    expect(api.on).toHaveBeenCalledWith('auth:url-opened', expect.any(Function));
    expect(api.on).toHaveBeenCalledWith('auth:completed', expect.any(Function));
  });
});
