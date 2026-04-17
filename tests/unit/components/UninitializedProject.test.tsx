/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UninitializedProject } from '../../../src/renderer/components/UninitializedProject';
import { mockSandstormApi } from './setup';

const project = { id: 1, name: 'myproject', directory: '/my/project', added_at: '' };

describe('UninitializedProject', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
  });

  it('renders the initialize button initially', () => {
    render(<UninitializedProject project={project} />);
    expect(screen.getByText('Initialize Sandstorm')).toBeDefined();
  });

  it('shows success state after successful initialization with no skipped files', async () => {
    api.projects.initialize.mockResolvedValue({ success: true });
    render(<UninitializedProject project={project} />);

    fireEvent.click(screen.getByText('Initialize Sandstorm'));

    await waitFor(() => {
      expect(screen.getByText('Sandstorm initialized!')).toBeDefined();
    });
    expect(screen.queryByText(/already existed/)).toBeNull();
  });

  it('shows skipped files notice when initialization skips pre-existing files', async () => {
    api.projects.initialize.mockResolvedValue({
      success: true,
      skippedFiles: ['verify.sh', 'docker-compose.yml'],
    });
    render(<UninitializedProject project={project} />);

    fireEvent.click(screen.getByText('Initialize Sandstorm'));

    await waitFor(() => {
      expect(screen.getByText('Sandstorm initialized!')).toBeDefined();
    });
    expect(screen.getByText(/already existed and were not overwritten/)).toBeDefined();
    expect(screen.getByText('verify.sh')).toBeDefined();
    expect(screen.getByText('docker-compose.yml')).toBeDefined();
  });

  it('does not show skipped files notice when skippedFiles is empty', async () => {
    api.projects.initialize.mockResolvedValue({ success: true, skippedFiles: [] });
    render(<UninitializedProject project={project} />);

    fireEvent.click(screen.getByText('Initialize Sandstorm'));

    await waitFor(() => {
      expect(screen.getByText('Sandstorm initialized!')).toBeDefined();
    });
    expect(screen.queryByText(/already existed/)).toBeNull();
  });

  it('shows error message when initialization fails', async () => {
    api.projects.initialize.mockResolvedValue({ success: false, error: 'Permission denied' });
    render(<UninitializedProject project={project} />);

    fireEvent.click(screen.getByText('Initialize Sandstorm'));

    await waitFor(() => {
      expect(screen.getByText('Permission denied')).toBeDefined();
    });
  });
});
