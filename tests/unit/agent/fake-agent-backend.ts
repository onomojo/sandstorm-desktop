/**
 * Minimal in-memory fake backend used as the conformance baseline and in
 * cross-module tests. Extracted here (not in agent-backend-conformance.test.ts)
 * so consumers can import it without triggering top-level test registrations.
 */

import { vi } from 'vitest';
import type {
  AgentBackend,
  AgentSessionHistory,
  AuthStatus,
  EphemeralSessionHandle,
  EphemeralStreamEvent,
  OuterClaudeSessionTokens,
  StackInfo,
} from '../../../src/main/agent/types';

export class FakeAgentBackend implements AgentBackend {
  readonly name: string;
  private messages = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();
  private processing = new Map<string, boolean>();

  readonly initializeMock = vi.fn().mockResolvedValue(undefined);
  readonly destroyMock = vi.fn();
  readonly setMainWindowMock = vi.fn();
  readonly cancelSessionMock = vi.fn();
  readonly getAuthStatusMock = vi.fn<[], Promise<AuthStatus>>().mockResolvedValue({
    loggedIn: true,
    email: 'test@example.com',
    expired: false,
  });
  readonly loginMock = vi.fn<[unknown?], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({
    success: true,
  });
  readonly syncCredentialsMock = vi.fn<[StackInfo[]], Promise<void>>().mockResolvedValue(undefined);
  readonly runEphemeralAgentMock = vi.fn<[string, string, number?, object?], Promise<string>>().mockResolvedValue('ephemeral-result');
  readonly spawnEphemeralAgentMock = vi.fn().mockImplementation(() => ({
    promise: Promise.resolve('ephemeral-result'),
    cancel: vi.fn(),
  }));
  readonly spawnEphemeralSessionMock = vi.fn().mockImplementation(() => ({
    initialResult: Promise.resolve('session-result'),
    sendFollowUp: vi.fn<[string], Promise<string>>().mockResolvedValue('followup-result'),
    dispose: vi.fn(),
  }));

  constructor(name = 'FakeBackend') {
    this.name = name;
  }

  initialize(): Promise<void> { return this.initializeMock(); }
  destroy(): void { this.destroyMock(); }
  setMainWindow(win: unknown): void { this.setMainWindowMock(win); }

  sendMessage(tabId: string, message: string): void {
    if (!this.messages.has(tabId)) this.messages.set(tabId, []);
    this.messages.get(tabId)!.push({ role: 'user', content: message });
    this.processing.set(tabId, false);
  }

  getHistory(tabId: string): AgentSessionHistory {
    return {
      messages: this.messages.get(tabId) ?? [],
      processing: this.processing.get(tabId) ?? false,
    };
  }

  cancelSession(tabId: string): void { this.cancelSessionMock(tabId); }

  resetSession(tabId: string): void {
    this.messages.delete(tabId);
    this.processing.delete(tabId);
  }

  getSessionTokens(_tabId: string): OuterClaudeSessionTokens {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }

  getEphemeralTimingPath(): string { return '/tmp/fake-ephemeral-timing.jsonl'; }

  runEphemeralAgent(
    prompt: string,
    projectDir: string,
    timeoutMs?: number,
    attribution?: { ticketId?: string; stage?: string },
    model?: string,
  ): Promise<string> {
    return this.runEphemeralAgentMock(prompt, projectDir, timeoutMs, attribution, model);
  }

  spawnEphemeralAgent(
    prompt: string,
    projectDir: string,
    timeoutMs?: number,
    onChunk?: (event: EphemeralStreamEvent) => void,
    attribution?: { ticketId?: string; stage?: string },
    model?: string,
  ): { promise: Promise<string>; cancel: () => void } {
    return this.spawnEphemeralAgentMock(prompt, projectDir, timeoutMs, onChunk, attribution, model);
  }

  spawnEphemeralSession(
    initialPrompt: string,
    projectDir: string,
    timeoutMs?: number,
    onChunk?: (event: EphemeralStreamEvent) => void,
  ): EphemeralSessionHandle {
    return this.spawnEphemeralSessionMock(initialPrompt, projectDir, timeoutMs, onChunk);
  }

  getAuthStatus(): Promise<AuthStatus> { return this.getAuthStatusMock(); }
  login(mainWindow?: unknown): Promise<{ success: boolean; error?: string }> {
    return this.loginMock(mainWindow);
  }
  syncCredentials(stacks: StackInfo[]): Promise<void> { return this.syncCredentialsMock(stacks); }
}
