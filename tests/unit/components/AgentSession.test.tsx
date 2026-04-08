/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { AgentSession } from '../../../src/renderer/components/AgentSession';
import { useAppStore } from '../../../src/renderer/store';
import { _resetForTesting } from '../../../src/renderer/agentStreamService';
import { mockSandstormApi } from './setup';

describe('AgentSession', () => {
  let api: ReturnType<typeof mockSandstormApi>;
  // Track event listeners registered via window.sandstorm.on (keyed by channel)
  let eventHandlers: Record<string, (...args: unknown[]) => void>;

  beforeEach(() => {
    // Reset store agent session state so tests are isolated
    useAppStore.setState({ agentSessions: {} });
    // Reset service registered-tabs tracking so listeners re-register each test
    _resetForTesting();

    api = mockSandstormApi();
    eventHandlers = {};
    api.on.mockImplementation((channel: string, cb: (...args: unknown[]) => void) => {
      eventHandlers[channel] = cb;
      return () => {
        delete eventHandlers[channel];
      };
    });
    api.agent.history.mockResolvedValue({ messages: [], processing: false });
  });

  it('sets isLoading=false immediately on agent:done before history fetch (fixes #28)', async () => {
    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    // Simulate sending a message — the user-message handler sets isLoading=true
    const userMsgHandler = eventHandlers['agent:user-message:test-tab'];
    expect(userMsgHandler).toBeDefined();
    act(() => {
      userMsgHandler('hello');
    });

    // The "Thinking..." indicator should be visible (isLoading=true)
    expect(screen.getByText('Thinking...')).toBeDefined();

    // Now simulate agent:done firing.
    api.agent.history.mockResolvedValue({ messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi there' },
    ], processing: false });

    const doneHandler = eventHandlers['agent:done:test-tab'];
    expect(doneHandler).toBeDefined();
    await act(async () => {
      doneHandler();
      await Promise.resolve();
    });

    // "Thinking..." should be gone
    expect(screen.queryByText('Thinking...')).toBeNull();
  });

  it('re-enables isLoading when backend has queued messages after done (fixes #28)', async () => {
    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    // Simulate a done event where the backend is still processing queued messages
    api.agent.history.mockResolvedValue({ messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'response' },
      { role: 'user', content: 'second' },
    ], processing: true });

    const doneHandler = eventHandlers['agent:done:test-tab'];
    await act(async () => {
      doneHandler();
      await Promise.resolve();
    });

    // isLoading should be re-enabled since backend is processing a queued message
    expect(screen.getByText('Thinking...')).toBeDefined();
  });

  it('renders the New Session button', async () => {
    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    const btn = screen.getByText('New Session');
    expect(btn).toBeDefined();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('calls agent.reset and clears messages when New Session is clicked', async () => {
    // Start with some existing messages
    api.agent.history.mockResolvedValue({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      processing: false,
    });

    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    // Messages should be visible
    expect(screen.getByText('hello')).toBeDefined();
    expect(screen.getByText('hi')).toBeDefined();

    // Click New Session
    const btn = screen.getByText('New Session');
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });

    // agent.reset should have been called
    expect(api.agent.reset).toHaveBeenCalledWith('test-tab');
    // Messages should be cleared
    expect(screen.queryByText('hello')).toBeNull();
    expect(screen.queryByText('hi')).toBeNull();
  });

  it('cancels running process before resetting when New Session is clicked during loading', async () => {
    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    // Set isLoading=true via user-message event
    const userMsgHandler = eventHandlers['agent:user-message:test-tab'];
    act(() => {
      userMsgHandler('hello');
    });
    expect(screen.getByText('Thinking...')).toBeDefined();

    // Click New Session while loading
    const btn = screen.getByText('New Session');
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });

    // Should have cancelled first, then reset
    expect(api.agent.cancel).toHaveBeenCalledWith('test-tab');
    expect(api.agent.reset).toHaveBeenCalledWith('test-tab');
    // Thinking indicator should be gone
    expect(screen.queryByText('Thinking...')).toBeNull();
  });

  it('clears isLoading on agent:error (fixes #28)', async () => {
    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    // Simulate user message to set isLoading=true
    const userMsgHandler = eventHandlers['agent:user-message:test-tab'];
    act(() => {
      userMsgHandler('hello');
    });
    expect(screen.getByText('Thinking...')).toBeDefined();

    // Simulate error
    const errorHandler = eventHandlers['agent:error:test-tab'];
    act(() => {
      errorHandler('spawn failed');
    });

    // isLoading should be false — no "Thinking..." shown
    expect(screen.queryByText('Thinking...')).toBeNull();
    // Error message should be in the chat
    expect(screen.getByText(/spawn failed/)).toBeDefined();
  });

  // --- Tests for tab-switching persistence (issue #211) ---

  it('accumulates streamingContent in store while component is mounted', async () => {
    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    const outputHandler = eventHandlers['agent:output:test-tab'];
    expect(outputHandler).toBeDefined();

    act(() => {
      outputHandler('Hello ');
      outputHandler('world');
    });

    // Streaming content should be visible in the UI
    expect(screen.getByText(/Hello world/)).toBeDefined();

    // And persisted in the store
    const state = useAppStore.getState().agentSessions['test-tab'];
    expect(state?.streamingContent).toBe('Hello world');
  });

  it('preserves streamingContent in store after component unmounts (tab switch)', async () => {
    const { unmount } = await act(async () =>
      render(<AgentSession tabId="test-tab" projectDir="/test" />)
    );

    // Receive some streaming chunks
    const outputHandler = eventHandlers['agent:output:test-tab'];
    act(() => {
      outputHandler('Partial response...');
    });

    // Unmount (simulates switching to another tab)
    unmount();

    // Store should still have the streaming content
    const state = useAppStore.getState().agentSessions['test-tab'];
    expect(state?.streamingContent).toBe('Partial response...');
  });

  it('continues receiving streaming chunks while component is unmounted', async () => {
    const { unmount } = await act(async () =>
      render(<AgentSession tabId="test-tab" projectDir="/test" />)
    );

    const outputHandler = eventHandlers['agent:output:test-tab'];
    act(() => {
      outputHandler('First chunk ');
    });

    // Unmount (tab switch away)
    unmount();

    // More chunks arrive while unmounted
    act(() => {
      outputHandler('second chunk');
    });

    // Store has all accumulated content
    const state = useAppStore.getState().agentSessions['test-tab'];
    expect(state?.streamingContent).toBe('First chunk second chunk');
  });

  it('shows accumulated streamingContent when component remounts after tab switch', async () => {
    // Pre-populate store as if streaming happened while component was unmounted
    useAppStore.getState().updateAgentSession('test-tab', {
      streamingContent: 'Accumulated while away...',
      isLoading: true,
    });

    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    // The partial streaming message should be visible immediately on remount
    expect(screen.getByText(/Accumulated while away/)).toBeDefined();
  });

  it('shows completed message when stream finishes while component is unmounted', async () => {
    const { unmount } = await act(async () =>
      render(<AgentSession tabId="test-tab" projectDir="/test" />)
    );

    const outputHandler = eventHandlers['agent:output:test-tab'];
    act(() => {
      outputHandler('The complete answer');
    });

    // Unmount while still streaming
    unmount();

    // Stream finishes while unmounted
    api.agent.history.mockResolvedValue({
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'The complete answer' },
      ],
      processing: false,
    });

    const doneHandler = eventHandlers['agent:done:test-tab'];
    await act(async () => {
      doneHandler();
      await Promise.resolve();
    });

    // Store should have the completed message and no streaming content
    const state = useAppStore.getState().agentSessions['test-tab'];
    expect(state?.streamingContent).toBe('');
    expect(state?.isLoading).toBe(false);
    expect(state?.messages.some((m) => m.content === 'The complete answer')).toBe(true);

    // Remount — completed message should be visible
    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    expect(screen.getAllByText('The complete answer').length).toBeGreaterThan(0);
  });

  it('captures error state while component is unmounted and shows on remount', async () => {
    const { unmount } = await act(async () =>
      render(<AgentSession tabId="test-tab" projectDir="/test" />)
    );

    const outputHandler = eventHandlers['agent:output:test-tab'];
    act(() => {
      outputHandler('Partial before error');
    });

    // Unmount while streaming
    unmount();

    // Error fires while unmounted
    const errorHandler = eventHandlers['agent:error:test-tab'];
    act(() => {
      errorHandler('connection lost');
    });

    // Store captures the error
    const state = useAppStore.getState().agentSessions['test-tab'];
    expect(state?.streamingContent).toBe('');
    expect(state?.isLoading).toBe(false);
    expect(state?.messages.some((m) => m.content.includes('connection lost'))).toBe(true);
    expect(state?.messages.some((m) => m.content.includes('Partial before error'))).toBe(true);

    // Remount — error message should be visible
    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    expect(screen.getByText(/connection lost/)).toBeDefined();
  });

  it('shows "Thinking..." when isLoading:true is preserved in store after remount', async () => {
    // Pre-populate store as if a message was sent while component was unmounted.
    // Mock history to match — backend is still processing so isLoading stays true.
    useAppStore.getState().updateAgentSession('test-tab', {
      isLoading: true,
      isQueued: false,
    });
    api.agent.history.mockResolvedValue({ messages: [], processing: true });

    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    // Thinking indicator should be shown
    expect(screen.getByText('Thinking...')).toBeDefined();
  });

  it('shows "Message queued..." when isQueued:true is preserved in store after remount', async () => {
    // Pre-populate store as if message was queued while component was unmounted.
    // Mock history to match — backend is still processing.
    useAppStore.getState().updateAgentSession('test-tab', {
      isLoading: true,
      isQueued: true,
    });
    api.agent.history.mockResolvedValue({ messages: [], processing: true });

    await act(async () => {
      render(<AgentSession tabId="test-tab" projectDir="/test" />);
    });

    expect(screen.getByText('Message queued...')).toBeDefined();
  });
});
