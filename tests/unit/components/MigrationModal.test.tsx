/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MigrationModal } from '../../../src/renderer/components/MigrationModal';
import { mockSandstormApi } from './setup';

describe('MigrationModal', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
  });

  const defaultProps = {
    projectDir: '/test/project',
    missingVerifyScript: true,
    missingServiceLabels: false,
    onComplete: vi.fn(),
    onDismiss: vi.fn(),
  };

  it('renders the modal with correct title', async () => {
    api.projects.autoDetectVerify.mockResolvedValue({
      verifyScript: '#!/bin/bash\nset -e\nnpm test\n',
      serviceDescriptions: {},
    });

    render(<MigrationModal {...defaultProps} />);

    expect(screen.getByText('Project Migration Needed')).toBeDefined();
  });

  it('shows loading state initially', () => {
    api.projects.autoDetectVerify.mockReturnValue(new Promise(() => {})); // never resolves

    render(<MigrationModal {...defaultProps} />);

    expect(screen.getByText('Detecting project configuration...')).toBeDefined();
  });

  it('shows verify script editor after auto-detection', async () => {
    api.projects.autoDetectVerify.mockResolvedValue({
      verifyScript: '#!/bin/bash\nset -e\nnpm test\n',
      serviceDescriptions: {},
    });

    render(<MigrationModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('verify-script-editor')).toBeDefined();
    });

    const textarea = screen.getByTestId('verify-script-editor') as HTMLTextAreaElement;
    expect(textarea.value).toContain('npm test');
  });

  it('shows service description inputs when labels are missing', async () => {
    api.projects.autoDetectVerify.mockResolvedValue({
      verifyScript: '#!/bin/bash\nset -e\n',
      serviceDescriptions: { app: 'Application service', db: 'PostgreSQL database' },
    });

    render(
      <MigrationModal
        {...defaultProps}
        missingServiceLabels={true}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('service-desc-app')).toBeDefined();
      expect(screen.getByTestId('service-desc-db')).toBeDefined();
    });
  });

  it('calls saveMigration and onComplete on save', async () => {
    api.projects.autoDetectVerify.mockResolvedValue({
      verifyScript: '#!/bin/bash\nset -e\nnpm test\n',
      serviceDescriptions: {},
    });
    api.projects.saveMigration.mockResolvedValue({ success: true });

    render(<MigrationModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('migration-save-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('migration-save-btn'));

    await waitFor(() => {
      expect(api.projects.saveMigration).toHaveBeenCalledWith(
        '/test/project',
        expect.stringContaining('npm test'),
        {},
      );
      expect(defaultProps.onComplete).toHaveBeenCalled();
    });
  });

  it('calls onDismiss when Later is clicked', async () => {
    api.projects.autoDetectVerify.mockResolvedValue({
      verifyScript: '#!/bin/bash\nset -e\n',
      serviceDescriptions: {},
    });

    render(<MigrationModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('migration-later-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('migration-later-btn'));

    expect(defaultProps.onDismiss).toHaveBeenCalled();
  });

  it('shows error when saveMigration fails', async () => {
    api.projects.autoDetectVerify.mockResolvedValue({
      verifyScript: '#!/bin/bash\nset -e\n',
      serviceDescriptions: {},
    });
    api.projects.saveMigration.mockResolvedValue({ success: false, error: 'Permission denied' });

    render(<MigrationModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('migration-save-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('migration-save-btn'));

    await waitFor(() => {
      expect(screen.getByText('Permission denied')).toBeDefined();
    });
  });

  it('shows review prompt editor when missingReviewPrompt is true', async () => {
    api.projects.autoDetectVerify.mockResolvedValue({
      verifyScript: '#!/bin/bash\nset -e\n',
      serviceDescriptions: {},
    });
    api.reviewPrompt.getDefault.mockResolvedValue('# Default Review Prompt\n\nReview instructions here.');

    render(
      <MigrationModal
        {...defaultProps}
        missingVerifyScript={false}
        missingReviewPrompt={true}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('review-prompt-editor')).toBeDefined();
    });

    const textarea = screen.getByTestId('review-prompt-editor') as HTMLTextAreaElement;
    expect(textarea.value).toContain('Default Review Prompt');
  });

  it('saves review prompt on save when missingReviewPrompt is true', async () => {
    api.projects.autoDetectVerify.mockResolvedValue({
      verifyScript: '#!/bin/bash\nset -e\n',
      serviceDescriptions: {},
    });
    api.projects.saveMigration.mockResolvedValue({ success: true });
    api.reviewPrompt.getDefault.mockResolvedValue('# Review Prompt Content');
    api.reviewPrompt.save.mockResolvedValue(undefined);

    render(
      <MigrationModal
        {...defaultProps}
        missingVerifyScript={true}
        missingReviewPrompt={true}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('migration-save-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('migration-save-btn'));

    await waitFor(() => {
      expect(api.reviewPrompt.save).toHaveBeenCalledWith(
        '/test/project',
        '# Review Prompt Content',
      );
    });
  });

  it('does not show review prompt editor when missingReviewPrompt is false', async () => {
    api.projects.autoDetectVerify.mockResolvedValue({
      verifyScript: '#!/bin/bash\nset -e\n',
      serviceDescriptions: {},
    });

    render(
      <MigrationModal
        {...defaultProps}
        missingReviewPrompt={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('verify-script-editor')).toBeDefined();
    });

    expect(screen.queryByTestId('review-prompt-editor')).toBeNull();
  });

  it('allows editing the verify script before saving', async () => {
    api.projects.autoDetectVerify.mockResolvedValue({
      verifyScript: '#!/bin/bash\nset -e\n',
      serviceDescriptions: {},
    });
    api.projects.saveMigration.mockResolvedValue({ success: true });

    render(<MigrationModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('verify-script-editor')).toBeDefined();
    });

    const textarea = screen.getByTestId('verify-script-editor') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '#!/bin/bash\nset -e\nnpm run custom-test\n' } });

    fireEvent.click(screen.getByTestId('migration-save-btn'));

    await waitFor(() => {
      expect(api.projects.saveMigration).toHaveBeenCalledWith(
        '/test/project',
        expect.stringContaining('npm run custom-test'),
        {},
      );
    });
  });
});
