/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionWarningModal } from '../../../src/renderer/components/SessionWarningModal';
import { useAppStore } from '../../../src/renderer/store';
import type { UsageSnapshot } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    session: { percent: 95, resetsAt: '6pm (America/New_York)' },
    weekAll: null,
    weekSonnet: null,
    extraUsage: { enabled: false },
    capturedAt: new Date().toISOString(),
    status: 'ok',
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

  describe('critical threshold (90%)', () => {
    it('renders the critical warning modal', () => {
      const onClose = vi.fn();
      render(<SessionWarningModal level="critical" usage={makeSnapshot()} onClose={onClose} />);

      expect(screen.getByTestId('session-warning-modal')).toBeDefined();
      expect(screen.getByText('Approaching Session Limit')).toBeDefined();
      expect(screen.getByText(/95% of session tokens used/)).toBeDefined();
    });

    it('shows reset time', () => {
      render(<SessionWarningModal level="critical" usage={makeSnapshot()} onClose={vi.fn()} />);

      const modal = screen.getByTestId('session-warning-modal');
      expect(modal.textContent).toContain('Resets 6pm (America/New_York)');
    });

    it('has Halt All Stacks button that calls sessionHaltAll', async () => {
      const onClose = vi.fn();
      api.session.haltAll.mockResolvedValue(['stack-1']);
      api.stacks.list.mockResolvedValue([]);
      render(<SessionWarningModal level="critical" usage={makeSnapshot()} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('halt-all-button'));

      await waitFor(() => {
        expect(api.session.haltAll).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
      });
    });

    it('has Continue button that calls sessionAcknowledgeCritical', async () => {
      const onClose = vi.fn();
      render(<SessionWarningModal level="critical" usage={makeSnapshot()} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('continue-button'));

      await waitFor(() => {
        expect(api.session.acknowledgeCritical).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
      });
    });

    it('has Remind me at 100% button that just closes', () => {
      const onClose = vi.fn();
      render(<SessionWarningModal level="critical" usage={makeSnapshot()} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('remind-later-button'));
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('limit threshold (95%+)', () => {
    it('renders the limit reached modal', () => {
      render(
        <SessionWarningModal
          level="limit"
          usage={makeSnapshot({ session: { percent: 100, resetsAt: '8pm (America/New_York)' } })}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByTestId('session-warning-modal')).toBeDefined();
      expect(screen.getByText('Session Token Limit Reached')).toBeDefined();
      expect(screen.getByText('All stacks have been halted')).toBeDefined();
    });

    it('has dismiss button', () => {
      const onClose = vi.fn();
      render(
        <SessionWarningModal level="limit" usage={makeSnapshot()} onClose={onClose} />
      );

      fireEvent.click(screen.getByTestId('dismiss-button'));
      expect(onClose).toHaveBeenCalled();
    });

    it('has resume override button that calls sessionResumeAll', async () => {
      const onClose = vi.fn();
      api.session.resumeAll.mockResolvedValue(['stack-1']);
      api.stacks.list.mockResolvedValue([]);
      render(<SessionWarningModal level="limit" usage={makeSnapshot()} onClose={onClose} />);

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
          usage={makeSnapshot({ session: { percent: 95, resetsAt: '8pm (America/New_York)' } })}
          onClose={vi.fn()}
        />
      );

      const modal = screen.getByTestId('session-warning-modal');
      expect(modal.textContent).toContain('resets 8pm (America/New_York)');
    });
  });

  describe('over_limit threshold', () => {
    it('renders same as limit modal', () => {
      render(
        <SessionWarningModal level="over_limit" usage={makeSnapshot()} onClose={vi.fn()} />
      );

      expect(screen.getByTestId('session-warning-modal')).toBeDefined();
      expect(screen.getByText('Session Token Limit Reached')).toBeDefined();
    });
  });

  describe('other levels', () => {
    it('renders nothing for warning level', () => {
      const { container } = render(
        <SessionWarningModal level="warning" usage={makeSnapshot()} onClose={vi.fn()} />
      );
      expect(container.innerHTML).toBe('');
    });

    it('renders nothing for normal level', () => {
      const { container } = render(
        <SessionWarningModal level="normal" usage={makeSnapshot()} onClose={vi.fn()} />
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
      expect(screen.getByText(/reset time unknown/i)).toBeDefined();
    });
  });
});
