/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ComposeSetupModal } from '../../../src/renderer/components/ComposeSetupModal';
import { mockSandstormApi } from './setup';

describe('ComposeSetupModal', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
  });

  const defaultProps = {
    projectDir: '/test/project',
    onComplete: vi.fn(),
    onDismiss: vi.fn(),
  };

  it('renders the modal with correct title', async () => {
    api.projects.generateCompose.mockResolvedValue({
      success: true,
      yaml: 'services:\n  claude:\n    image: test\n',
      composeFile: 'docker-compose.yml',
      services: [],
    });

    render(<ComposeSetupModal {...defaultProps} />);

    expect(screen.getByText('Sandstorm Compose Setup')).toBeDefined();
  });

  it('shows loading state initially', () => {
    api.projects.generateCompose.mockReturnValue(new Promise(() => {}));

    render(<ComposeSetupModal {...defaultProps} />);

    expect(screen.getByTestId('compose-loading')).toBeDefined();
  });

  it('shows generated YAML in editor after loading', async () => {
    const yaml = 'services:\n  app:\n    image: test\n  claude:\n    image: claude\n';
    api.projects.generateCompose.mockResolvedValue({
      success: true,
      yaml,
      composeFile: 'docker-compose.yml',
      services: [{ name: 'app', description: 'Application service', ports: [] }],
    });

    render(<ComposeSetupModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('compose-yaml-editor')).toBeDefined();
    });

    const textarea = screen.getByTestId('compose-yaml-editor') as HTMLTextAreaElement;
    expect(textarea.value).toBe(yaml);
  });

  it('shows source compose file name', async () => {
    api.projects.generateCompose.mockResolvedValue({
      success: true,
      yaml: 'services:\n  claude:\n    image: test\n',
      composeFile: 'docker-compose.yml',
      services: [],
    });

    render(<ComposeSetupModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('docker-compose.yml')).toBeDefined();
    });
  });

  it('shows error when no project compose file exists', async () => {
    api.projects.generateCompose.mockResolvedValue({
      success: false,
      error: 'This project requires a docker-compose.yml file. Sandstorm cannot manage stacks without one.',
      noProjectCompose: true,
    });

    render(<ComposeSetupModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('compose-no-project-error')).toBeDefined();
    });

    expect(screen.getByText('Missing Docker Compose File')).toBeDefined();
    // Save button should not be present
    expect(screen.queryByTestId('compose-save-btn')).toBeNull();
  });

  it('calls saveComposeSetup and onComplete on save', async () => {
    const yaml = 'services:\n  claude:\n    image: test\n';
    api.projects.generateCompose.mockResolvedValue({
      success: true,
      yaml,
      composeFile: 'docker-compose.yml',
      services: [],
    });
    api.projects.saveComposeSetup.mockResolvedValue({ success: true });

    render(<ComposeSetupModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('compose-save-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('compose-save-btn'));

    await waitFor(() => {
      expect(api.projects.saveComposeSetup).toHaveBeenCalledWith(
        '/test/project',
        yaml,
        'docker-compose.yml',
      );
      expect(defaultProps.onComplete).toHaveBeenCalled();
    });
  });

  it('calls onDismiss when Later is clicked', async () => {
    api.projects.generateCompose.mockResolvedValue({
      success: true,
      yaml: 'services:\n  claude:\n    image: test\n',
      composeFile: 'docker-compose.yml',
      services: [],
    });

    render(<ComposeSetupModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('compose-later-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('compose-later-btn'));
    expect(defaultProps.onDismiss).toHaveBeenCalled();
  });

  it('shows Close button instead of Later when no project compose', async () => {
    api.projects.generateCompose.mockResolvedValue({
      success: false,
      error: 'Missing compose file',
      noProjectCompose: true,
    });

    render(<ComposeSetupModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('compose-later-btn')).toBeDefined();
    });

    expect(screen.getByTestId('compose-later-btn').textContent).toBe('Close');
  });

  it('shows error when saveComposeSetup fails', async () => {
    api.projects.generateCompose.mockResolvedValue({
      success: true,
      yaml: 'services:\n  claude:\n    image: test\n',
      composeFile: 'docker-compose.yml',
      services: [],
    });
    api.projects.saveComposeSetup.mockResolvedValue({ success: false, error: 'YAML validation failed' });

    render(<ComposeSetupModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('compose-save-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('compose-save-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('compose-save-error')).toBeDefined();
      expect(screen.getByText('YAML validation failed')).toBeDefined();
    });
  });

  it('allows editing the YAML before saving', async () => {
    api.projects.generateCompose.mockResolvedValue({
      success: true,
      yaml: 'services:\n  claude:\n    image: test\n',
      composeFile: 'docker-compose.yml',
      services: [],
    });
    api.projects.saveComposeSetup.mockResolvedValue({ success: true });

    render(<ComposeSetupModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('compose-yaml-editor')).toBeDefined();
    });

    const edited = 'services:\n  claude:\n    image: custom-image\n';
    fireEvent.change(screen.getByTestId('compose-yaml-editor'), { target: { value: edited } });

    fireEvent.click(screen.getByTestId('compose-save-btn'));

    await waitFor(() => {
      expect(api.projects.saveComposeSetup).toHaveBeenCalledWith(
        '/test/project',
        edited,
        'docker-compose.yml',
      );
    });
  });
});
