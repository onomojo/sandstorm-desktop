/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionWarningModal } from '../../../src/renderer/components/SessionWarningModal';
import { useAppStore, AccountUsage } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeUsage(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    used_tokens: 950_000,
    limit_tokens: 1_000_000,
    percent: 95,
    reset_at: '2026-04-07T20:00:00.000Z',
    reset_in: '2h 30m',
    subscription_type: 'max',
    rate_limit_tier: null,
    ...overrides,
  };
}

describe('SessionWarningModal', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      sessionMonitorState: null,
      sessionWarningLevel: null,
      showSessionWarningModal: false,
    });
  });

  describe('critical threshold (95%)', () => {
    it('renders the critical warning modal', () => {
      const onClose = vi.fn();
      render(<SessionWarningModal level="critical" usage={makeUsage()} onClose={onClose} />);

      expect(screen.getByTestId('session-warning-modal')).toBeDefined();
      expect(screen.getByText('Approaching Session Limit')).toBeDefined();
      expect(screen.getByText(/95% of session tokens used/)).toBeDefined();
    });

    it('shows usage details', () => {
      render(<SessionWarningModal level="critical" usage={makeUsage()} onClose={vi.fn()} />);

      const modal = screen.getByTestId('session-warning-modal');
      expect(modal.textContent).toContain('950.0k');
      expect(modal.textContent).toContain('1.00M');
    });

    it('has Halt All Stacks button that calls sessionHaltAll', async () => {
      const onClose = vi.fn();
      api.session.haltAll.mockResolvedValue(['stack-1']);
      api.stacks.list.mockResolvedValue([]);
      render(<SessionWarningModal level="critical" usage={makeUsage()} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('halt-all-button'));

      await waitFor(() => {
        expect(api.session.haltAll).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
      });
    });

    it('has Continue button that calls sessionAcknowledgeCritical', async () => {
      const onClose = vi.fn();
      render(<SessionWarningModal level="critical" usage={makeUsage()} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('continue-button'));

      await waitFor(() => {
        expect(api.session.acknowledgeCritical).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
      });
    });

    it('has Remind me at 100% button that just closes', () => {
      const onClose = vi.fn();
      render(<SessionWarningModal level="critical" usage={makeUsage()} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('remind-later-button'));
      expect(onClose).toHaveBeenCalled();
    });

    it('shows reset time when available', () => {
      render(<SessionWarningModal level="critical" usage={makeUsage()} onClose={vi.fn()} />);
      const modal = screen.getByTestId('session-warning-modal');
      // Should show formatted reset time
      expect(modal.textContent).toContain('Resets at');
    });
  });

  describe('limit threshold (100%)', () => {
    it('renders the limit reached modal', () => {
      render(<SessionWarningModal level="limit" usage={makeUsage({ percent: 100 })} onClose={vi.fn()} />);

      expect(screen.getByTestId('session-warning-modal')).toBeDefined();
      expect(screen.getByText('Session Token Limit Reached')).toBeDefined();
      expect(screen.getByText('All stacks have been halted')).toBeDefined();
    });

    it('has dismiss button', () => {
      const onClose = vi.fn();
      render(<SessionWarningModal level="limit" usage={makeUsage({ percent: 100 })} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('dismiss-button'));
      expect(onClose).toHaveBeenCalled();
    });

    it('has resume override button that calls sessionResumeAll', async () => {
      const onClose = vi.fn();
      api.session.resumeAll.mockResolvedValue(['stack-1']);
      api.stacks.list.mockResolvedValue([]);
      render(<SessionWarningModal level="limit" usage={makeUsage({ percent: 100 })} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('resume-override-button'));

      await waitFor(() => {
        expect(api.session.resumeAll).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
      });
    });

    it('shows session reset info', () => {
      render(
        <SessionWarningModal
          level="limit"
          usage={makeUsage({ percent: 100, reset_in: '1h 15m' })}
          onClose={vi.fn()}
        />
      );

      const modal = screen.getByTestId('session-warning-modal');
      expect(modal.textContent).toContain('resets');
    });
  });

  describe('over_limit threshold', () => {
    it('renders same as limit modal', () => {
      render(<SessionWarningModal level="over_limit" usage={makeUsage({ percent: 120 })} onClose={vi.fn()} />);

      expect(screen.getByTestId('session-warning-modal')).toBeDefined();
      expect(screen.getByText('Session Token Limit Reached')).toBeDefined();
    });
  });

  describe('other levels', () => {
    it('renders nothing for warning level', () => {
      const { container } = render(
        <SessionWarningModal level="warning" usage={makeUsage({ percent: 80 })} onClose={vi.fn()} />
      );
      expect(container.innerHTML).toBe('');
    });

    it('renders nothing for normal level', () => {
      const { container } = render(
        <SessionWarningModal level="normal" usage={makeUsage({ percent: 50 })} onClose={vi.fn()} />
      );
      expect(container.innerHTML).toBe('');
    });
  });

  describe('null usage', () => {
    it('handles null usage gracefully in critical modal', () => {
      render(<SessionWarningModal level="critical" usage={null} onClose={vi.fn()} />);
      expect(screen.getByTestId('session-warning-modal')).toBeDefined();
    });

    it('handles null usage gracefully in limit modal', () => {
      render(<SessionWarningModal level="limit" usage={null} onClose={vi.fn()} />);
      expect(screen.getByTestId('session-warning-modal')).toBeDefined();
      expect(screen.getByText(/resets/i)).toBeDefined();
    });
  });
});
