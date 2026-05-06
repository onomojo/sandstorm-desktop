/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DockerUnavailableModal } from '../../../src/renderer/components/DockerUnavailableModal';
import { mockSandstormApi } from './setup';

describe('DockerUnavailableModal', () => {
  beforeEach(() => {
    mockSandstormApi();
  });

  it('renders with the expected data-testid', () => {
    render(<DockerUnavailableModal onDismiss={vi.fn()} />);
    expect(screen.getByTestId('docker-unavailable-modal')).toBeDefined();
  });

  it('shows "Docker is not running" heading', () => {
    render(<DockerUnavailableModal onDismiss={vi.fn()} />);
    expect(screen.getByText('Docker is not running')).toBeDefined();
  });

  it('explains that stack status could not be reconciled', () => {
    render(<DockerUnavailableModal onDismiss={vi.fn()} />);
    expect(screen.getByText('Stack status could not be reconciled')).toBeDefined();
  });

  it('renders the dismiss button', () => {
    render(<DockerUnavailableModal onDismiss={vi.fn()} />);
    expect(screen.getByTestId('docker-unavailable-dismiss')).toBeDefined();
  });

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<DockerUnavailableModal onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('docker-unavailable-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('shows the "Continue anyway" button label', () => {
    render(<DockerUnavailableModal onDismiss={vi.fn()} />);
    expect(screen.getByText('Continue anyway')).toBeDefined();
  });
});
