/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionTokenLimitModal } from '../../../src/renderer/components/SessionTokenLimitModal';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('SessionTokenLimitModal', () => {
  beforeEach(() => {
    mockSandstormApi();
    useAppStore.setState({ sessionTokenLimitModal: null });
  });

  it('renders nothing when sessionTokenLimitModal is null', () => {
    const { container } = render(<SessionTokenLimitModal />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the modal when state is set', () => {
    useAppStore.setState({ sessionTokenLimitModal: { resetAt: null } });
    render(<SessionTokenLimitModal />);
    expect(screen.getByTestId('session-token-limit-modal')).toBeDefined();
    expect(screen.getByText('Token limit not yet refreshed')).toBeDefined();
  });

  it('shows formatted reset time when resetAt is provided', () => {
    useAppStore.setState({
      sessionTokenLimitModal: { resetAt: '2026-05-04T15:30:00.000Z' },
    });
    render(<SessionTokenLimitModal />);
    // The modal renders the time via toLocaleTimeString — just check it's present
    expect(screen.getByTestId('session-token-limit-modal').textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('shows fallback text when resetAt is null', () => {
    useAppStore.setState({ sessionTokenLimitModal: { resetAt: null } });
    render(<SessionTokenLimitModal />);
    expect(screen.getByTestId('session-token-limit-modal').textContent).toContain(
      'Resume will be available once the limit refreshes.'
    );
  });

  it('dismisses modal when OK button is clicked', () => {
    useAppStore.setState({ sessionTokenLimitModal: { resetAt: null } });
    render(<SessionTokenLimitModal />);
    fireEvent.click(screen.getByTestId('session-token-limit-modal-dismiss'));
    expect(useAppStore.getState().sessionTokenLimitModal).toBeNull();
  });
});
