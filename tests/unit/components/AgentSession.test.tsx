/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { AgentSession } from '../../../src/renderer/components/AgentSession';
import { mockSandstormApi } from './setup';

describe('AgentSession', () => {
  let api: ReturnType<typeof mockSandstormApi>;
  // Track event listeners registered via window.sandstorm.on
  let eventHandlers: Record<string, (...args: unknown[]) => void>;

  beforeEach(() => {
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
});
