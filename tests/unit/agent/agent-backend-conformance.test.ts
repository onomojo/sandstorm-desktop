/**
 * Shared AgentBackend conformance suite.
 *
 * Tests the full AgentBackend contract independent of the implementation.
 * Parameterised so future backends (#478 OpenCodeBackend, etc.) can be wired
 * in with a single call to createConformanceSuite() and validated against the
 * same assertions.
 *
 * Usage (in e.g. opencode-backend.test.ts):
 *   import { createConformanceSuite } from './agent-backend-conformance.test';
 *   createConformanceSuite('OpenCodeBackend', () => new OpenCodeBackend(...));
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  AgentBackend,
  AgentSessionHistory,
  AuthStatus,
  EphemeralSessionHandle,
  EphemeralStreamEvent,
  OuterClaudeSessionTokens,
  StackInfo,
} from '../../../src/main/agent/types';

// ---------------------------------------------------------------------------
// Minimal in-memory fake backend used as the default conformance target.
// It records messages, supports resetSession, and delegates to vi.fn() for
// everything else so assertions can be made on call counts where needed.
// ---------------------------------------------------------------------------

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
  ): Promise<string> {
    return this.runEphemeralAgentMock(prompt, projectDir, timeoutMs, attribution);
  }

  spawnEphemeralAgent(
    prompt: string,
    projectDir: string,
    timeoutMs?: number,
    onChunk?: (event: EphemeralStreamEvent) => void,
    attribution?: { ticketId?: string; stage?: string },
  ): { promise: Promise<string>; cancel: () => void } {
    return this.spawnEphemeralAgentMock(prompt, projectDir, timeoutMs, onChunk, attribution);
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

// ---------------------------------------------------------------------------
// Conformance suite factory
// ---------------------------------------------------------------------------

/**
 * Register a full AgentBackend conformance suite for the given factory.
 * Call this from any backend's test file to validate conformance:
 *
 *   createConformanceSuite('MyBackend', () => new MyBackend());
 */
export function createConformanceSuite(
  suiteName: string,
  factory: () => AgentBackend,
): void {
  describe(`AgentBackend conformance: ${suiteName}`, () => {
    let backend: AgentBackend;

    beforeEach(() => {
      backend = factory();
    });

    // --- Identity ---

    it('exposes a non-empty name string', () => {
      expect(typeof backend.name).toBe('string');
      expect(backend.name.length).toBeGreaterThan(0);
    });

    // --- Lifecycle ---

    it('initialize() returns a Promise', async () => {
      const result = backend.initialize();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('destroy() is callable without error', () => {
      expect(() => backend.destroy()).not.toThrow();
    });

    it('setMainWindow(null) is callable without error', () => {
      expect(() => backend.setMainWindow(null)).not.toThrow();
    });

    // --- Session management ---

    it('getHistory returns empty history for unknown tab', () => {
      const history = backend.getHistory('unknown-tab');
      expect(history).toMatchObject({ messages: [], processing: false });
    });

    it('sendMessage stores the message in history', () => {
      backend.sendMessage('tab-1', 'hello world', '/project');
      const history = backend.getHistory('tab-1');
      expect(history.messages).toHaveLength(1);
      expect(history.messages[0]).toMatchObject({ role: 'user', content: 'hello world' });
    });

    it('sendMessage on separate tabs keeps histories independent', () => {
      backend.sendMessage('tab-a', 'message for a', '/project-a');
      backend.sendMessage('tab-b', 'message for b', '/project-b');
      expect(backend.getHistory('tab-a').messages).toHaveLength(1);
      expect(backend.getHistory('tab-b').messages).toHaveLength(1);
      expect(backend.getHistory('tab-a').messages[0].content).toBe('message for a');
      expect(backend.getHistory('tab-b').messages[0].content).toBe('message for b');
    });

    it('resetSession clears the tab history', () => {
      backend.sendMessage('tab-reset', 'before reset', '/project');
      expect(backend.getHistory('tab-reset').messages).toHaveLength(1);
      backend.resetSession('tab-reset');
      expect(backend.getHistory('tab-reset').messages).toHaveLength(0);
    });

    it('resetSession on unknown tab does not throw', () => {
      expect(() => backend.resetSession('never-existed')).not.toThrow();
    });

    it('cancelSession is callable without error', () => {
      backend.sendMessage('tab-cancel', 'msg', '/project');
      expect(() => backend.cancelSession('tab-cancel')).not.toThrow();
    });

    it('cancelSession on unknown tab does not throw', () => {
      expect(() => backend.cancelSession('unknown-cancel')).not.toThrow();
    });

    it('getSessionTokens returns a token object with numeric fields', () => {
      const tokens = backend.getSessionTokens('any-tab');
      expect(typeof tokens.input_tokens).toBe('number');
      expect(typeof tokens.output_tokens).toBe('number');
      expect(typeof tokens.cache_creation_input_tokens).toBe('number');
      expect(typeof tokens.cache_read_input_tokens).toBe('number');
    });

    it('getSessionTokens for unknown tab returns zero-value object', () => {
      const tokens = backend.getSessionTokens('nonexistent-tab');
      expect(tokens.input_tokens).toBe(0);
      expect(tokens.output_tokens).toBe(0);
      expect(tokens.cache_creation_input_tokens).toBe(0);
      expect(tokens.cache_read_input_tokens).toBe(0);
    });

    // --- Ephemeral agents ---

    it('getEphemeralTimingPath returns a non-empty string', () => {
      const p = backend.getEphemeralTimingPath();
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    });

    it('runEphemeralAgent returns a Promise resolving to a string', async () => {
      const result = backend.runEphemeralAgent('prompt', '/project');
      expect(result).toBeInstanceOf(Promise);
      const text = await result;
      expect(typeof text).toBe('string');
    });

    it('spawnEphemeralAgent returns { promise, cancel }', async () => {
      const { promise, cancel } = backend.spawnEphemeralAgent('prompt', '/project');
      expect(promise).toBeInstanceOf(Promise);
      expect(typeof cancel).toBe('function');
      await promise;
    });

    it('spawnEphemeralAgent cancel is callable without error', () => {
      const { cancel } = backend.spawnEphemeralAgent('prompt', '/project');
      expect(() => cancel()).not.toThrow();
    });

    it('spawnEphemeralSession returns a handle with initialResult, sendFollowUp, dispose', async () => {
      const handle = backend.spawnEphemeralSession('initial prompt', '/project');
      expect(handle.initialResult).toBeInstanceOf(Promise);
      expect(typeof handle.sendFollowUp).toBe('function');
      expect(typeof handle.dispose).toBe('function');
      await handle.initialResult;
    });

    it('spawnEphemeralSession dispose is callable without error', () => {
      const handle = backend.spawnEphemeralSession('prompt', '/project');
      expect(() => handle.dispose()).not.toThrow();
    });

    // --- Authentication ---

    it('getAuthStatus returns a Promise with loggedIn and expired fields', async () => {
      const status = await backend.getAuthStatus();
      expect(typeof status.loggedIn).toBe('boolean');
      expect(typeof status.expired).toBe('boolean');
    });

    it('login returns a Promise with a success boolean', async () => {
      const result = await backend.login();
      expect(typeof result.success).toBe('boolean');
    });

    it('syncCredentials returns a Promise', async () => {
      const result = backend.syncCredentials([]);
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });
}

// ---------------------------------------------------------------------------
// Run the conformance suite against FakeAgentBackend as a baseline check.
// #478 will call createConformanceSuite('OpenCodeBackend', ...) here too.
// ---------------------------------------------------------------------------

createConformanceSuite('FakeAgentBackend', () => new FakeAgentBackend());
