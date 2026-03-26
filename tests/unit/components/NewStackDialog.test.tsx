/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewStackDialog } from '../../../src/renderer/components/NewStackDialog';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('NewStackDialog', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      projects: [],
      activeProjectId: null,
      showNewStackDialog: true,
      stacks: [],
    });
  });

  it('renders the dialog with form fields', () => {
    render(<NewStackDialog />);
    expect(screen.getByText('New Stack')).toBeDefined();
    expect(screen.getByTestId('stack-name')).toBeDefined();
    expect(screen.getByText('Launch Stack')).toBeDefined();
    expect(screen.getByText('Cancel')).toBeDefined();
  });

  it('shows project-specific title when a project is active', () => {
    useAppStore.setState({
      projects: [{ id: 1, name: 'myapp', directory: '/myapp', added_at: '' }],
      activeProjectId: 1,
    });

    render(<NewStackDialog />);
    expect(screen.getByText(/New Stack — myapp/)).toBeDefined();
  });

  it('disables Launch button when name is empty', () => {
    render(<NewStackDialog />);
    const launchBtn = screen.getByTestId('launch-btn');
    expect(launchBtn.hasAttribute('disabled')).toBe(true);
  });

  it('closes dialog when Cancel is clicked', () => {
    render(<NewStackDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(useAppStore.getState().showNewStackDialog).toBe(false);
  });

  it('closes dialog when backdrop is clicked', () => {
    const { container } = render(<NewStackDialog />);
    // Click the backdrop (outermost div)
    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(useAppStore.getState().showNewStackDialog).toBe(false);
  });

  it('shows error when name is empty and create is attempted', async () => {
    // With a project active (so projectDir is populated)
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
    });

    render(<NewStackDialog />);
    // The launch button should be disabled when name is empty
    const launchBtn = screen.getByTestId('launch-btn');
    expect(launchBtn.hasAttribute('disabled')).toBe(true);
  });

  it('calls stacks.create with correct opts on submit', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
    });

    api.stacks.create.mockResolvedValue({
      id: 'my-stack', project: 'proj', status: 'building', services: [],
    });
    api.stacks.list.mockResolvedValue([]);

    render(<NewStackDialog />);

    const nameInput = screen.getByTestId('stack-name');
    await user.type(nameInput, 'my-stack');

    const ticketInput = screen.getByTestId('stack-ticket');
    await user.type(ticketInput, 'EXP-42');

    fireEvent.click(screen.getByTestId('launch-btn'));

    await waitFor(() => {
      expect(api.stacks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-stack',
          projectDir: '/proj',
          ticket: 'EXP-42',
          runtime: 'docker',
        })
      );
    });
  });

  it('shows error message when create fails', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
    });

    api.stacks.create.mockRejectedValue(new Error('FK constraint failed'));

    render(<NewStackDialog />);

    await user.type(screen.getByTestId('stack-name'), 'bad-stack');
    fireEvent.click(screen.getByTestId('launch-btn'));

    await waitFor(() => {
      expect(screen.getByText(/FK constraint failed/)).toBeDefined();
    });
  });

  it('shows project directory input when no project is active', () => {
    render(<NewStackDialog />);
    expect(screen.getByPlaceholderText('/home/user/projects/myapp')).toBeDefined();
  });

  it('hides project directory input when a project is active', () => {
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
    });

    render(<NewStackDialog />);
    expect(screen.queryByPlaceholderText('/home/user/projects/myapp')).toBeNull();
  });

  it('renders model selector with Sonnet and Opus options', () => {
    render(<NewStackDialog />);
    expect(screen.getByTestId('model-sonnet')).toBeDefined();
    expect(screen.getByTestId('model-opus')).toBeDefined();
  });

  it('defaults to sonnet model', () => {
    render(<NewStackDialog />);
    const sonnetBtn = screen.getByTestId('model-sonnet');
    expect(sonnetBtn.className).toContain('border-sandstorm-accent');
  });

  it('passes model to stacks.create', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
      activeProjectId: 1,
    });

    api.stacks.create.mockResolvedValue({
      id: 'model-stack', project: 'proj', status: 'building', services: [],
    });
    api.stacks.list.mockResolvedValue([]);

    render(<NewStackDialog />);

    await user.type(screen.getByTestId('stack-name'), 'model-stack');
    fireEvent.click(screen.getByTestId('model-opus'));
    fireEvent.click(screen.getByTestId('launch-btn'));

    await waitFor(() => {
      expect(api.stacks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'model-stack',
          model: 'opus',
        })
      );
    });
  });

  describe('name validation', () => {
    it('shows error for names with spaces', async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
        activeProjectId: 1,
      });

      render(<NewStackDialog />);
      await user.type(screen.getByTestId('stack-name'), 'my stack');

      expect(screen.getByTestId('name-error')).toBeDefined();
      expect(screen.getByTestId('name-error').textContent).toMatch(/spaces/);
    });

    it('shows error for uppercase names', async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
        activeProjectId: 1,
      });

      render(<NewStackDialog />);
      await user.type(screen.getByTestId('stack-name'), 'MyStack');

      expect(screen.getByTestId('name-error')).toBeDefined();
      expect(screen.getByTestId('name-error').textContent).toMatch(/lowercase/i);
    });

    it('shows error for names with special characters', async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
        activeProjectId: 1,
      });

      render(<NewStackDialog />);
      await user.type(screen.getByTestId('stack-name'), 'my@stack!');

      expect(screen.getByTestId('name-error')).toBeDefined();
    });

    it('shows error for names starting with a number', async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
        activeProjectId: 1,
      });

      render(<NewStackDialog />);
      await user.type(screen.getByTestId('stack-name'), '123stack');

      expect(screen.getByTestId('name-error')).toBeDefined();
    });

    it('accepts valid names with hyphens and underscores', async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
        activeProjectId: 1,
      });

      render(<NewStackDialog />);
      await user.type(screen.getByTestId('stack-name'), 'auth-refactor_v2');

      expect(screen.queryByTestId('name-error')).toBeNull();
    });

    it('disables Launch button when name is invalid', async () => {
      const user = userEvent.setup();
      useAppStore.setState({
        projects: [{ id: 1, name: 'proj', directory: '/proj', added_at: '' }],
        activeProjectId: 1,
      });

      render(<NewStackDialog />);
      await user.type(screen.getByTestId('stack-name'), 'My Stack!');

      const launchBtn = screen.getByTestId('launch-btn');
      expect(launchBtn.hasAttribute('disabled')).toBe(true);
    });
  });
});
