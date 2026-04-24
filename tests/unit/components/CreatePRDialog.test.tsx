/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreatePRDialog } from '../../../src/renderer/components/CreatePRDialog';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('CreatePRDialog', () => {
  let api: ReturnType<typeof mockSandstormApi>;
  let originalOpen: typeof window.open;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      showCreatePRDialog: { stackId: 'foo' },
      stacks: [],
    });
    originalOpen = window.open;
    window.open = vi.fn() as unknown as typeof window.open;
  });

  it('shows the drafting state while the title/body are loading', async () => {
    let resolve!: (v: { title: string; body: string }) => void;
    api.pr.draftBody.mockReturnValue(new Promise<{ title: string; body: string }>((r) => { resolve = r; }));
    render(<CreatePRDialog stackId="foo" />);
    expect(screen.getByTestId('pr-drafting')).toBeDefined();
    resolve({ title: 'feat: x', body: '## Summary\n- y' });
    await waitFor(() => screen.getByTestId('pr-title'));
  });

  it('renders the drafted title and body for editing', async () => {
    api.pr.draftBody.mockResolvedValue({
      title: 'feat: drafted title',
      body: '## Summary\n- drafted bullet\n\n## Test plan\n- [ ] thing',
    });
    render(<CreatePRDialog stackId="foo" />);
    await waitFor(() => {
      const titleInput = screen.getByTestId('pr-title') as HTMLInputElement;
      expect(titleInput.value).toBe('feat: drafted title');
    });
    const bodyInput = screen.getByTestId('pr-body') as HTMLTextAreaElement;
    expect(bodyInput.value).toContain('drafted bullet');
  });

  it('calls draftBody with the stack id on mount', () => {
    render(<CreatePRDialog stackId="my-stack" />);
    expect(api.pr.draftBody).toHaveBeenCalledWith('my-stack');
  });

  it('disables Create until both title and body have content', async () => {
    api.pr.draftBody.mockResolvedValue({ title: '', body: '' });
    render(<CreatePRDialog stackId="foo" />);
    await waitFor(() => screen.getByTestId('pr-title'));
    const create = screen.getByTestId('pr-create');
    expect(create.hasAttribute('disabled')).toBe(true);
  });

  it('calls pr.create with the edited title/body and closes on success', async () => {
    const user = userEvent.setup();
    api.pr.draftBody.mockResolvedValue({ title: 'orig', body: 'orig body' });
    api.pr.create.mockResolvedValue({ url: 'https://github.com/o/r/pull/9', number: 9 });
    render(<CreatePRDialog stackId="foo" />);
    await waitFor(() => screen.getByTestId('pr-title'));

    const title = screen.getByTestId('pr-title') as HTMLInputElement;
    await user.clear(title);
    await user.type(title, 'edited title');

    fireEvent.click(screen.getByTestId('pr-create'));
    await waitFor(() => {
      expect(api.pr.create).toHaveBeenCalledWith('foo', 'edited title', 'orig body');
    });
    await waitFor(() => {
      expect(useAppStore.getState().showCreatePRDialog).toBeNull();
    });
    expect(window.open).toHaveBeenCalledWith('https://github.com/o/r/pull/9', '_blank');
  });

  it('surfaces an error from draftBody', async () => {
    api.pr.draftBody.mockRejectedValue(new Error('runaway draft'));
    render(<CreatePRDialog stackId="foo" />);
    await waitFor(() => {
      expect(screen.getByTestId('pr-error').textContent).toMatch(/runaway draft/);
    });
  });

  it('surfaces an error from pr.create and stays open', async () => {
    const user = userEvent.setup();
    api.pr.draftBody.mockResolvedValue({ title: 't', body: 'b' });
    api.pr.create.mockRejectedValue(new Error('gh failed'));
    render(<CreatePRDialog stackId="foo" />);
    await waitFor(() => screen.getByTestId('pr-create'));
    fireEvent.click(screen.getByTestId('pr-create'));
    await waitFor(() => {
      expect(screen.getByTestId('pr-error').textContent).toMatch(/gh failed/);
    });
    expect(useAppStore.getState().showCreatePRDialog).not.toBeNull();
  });

  it('warns when the title exceeds 70 characters', async () => {
    const user = userEvent.setup();
    api.pr.draftBody.mockResolvedValue({ title: 't', body: 'b' });
    render(<CreatePRDialog stackId="foo" />);
    await waitFor(() => screen.getByTestId('pr-title'));
    const title = screen.getByTestId('pr-title') as HTMLInputElement;
    await user.clear(title);
    await user.type(title, 'x'.repeat(75));
    expect(screen.getByText(/75\/70/)).toBeDefined();
  });
});
