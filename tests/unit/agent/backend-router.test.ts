/**
 * Unit tests for BackendRouter.
 *
 * Uses two FakeAgentBackend instances (wired as 'claude' and 'opencode') to
 * verify routing logic without any Electron or Docker dependencies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BackendRouter } from '../../../src/main/agent/backend-router';
import { FakeAgentBackend } from './agent-backend-conformance.test';
import type { AgentBackend } from '../../../src/main/agent/types';
import type { BackendType } from '../../../src/main/control-plane/backend-resolution';
import type { TouchpointId } from '../../../src/main/control-plane/routing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRouter(
  claudeBackend: AgentBackend,
  opencodeBackend: AgentBackend,
  selector: (projectDir: string) => BackendType = (dir) =>
    dir.includes('opencode') ? 'opencode' : 'claude',
): BackendRouter {
  return new BackendRouter(
    {
      claude: () => claudeBackend,
      opencode: () => opencodeBackend,
    },
    selector,
  );
}

type TestDescriptor = { backend: BackendType; provider: string; model: string; credentials: Record<string, string> | null };

function makeRouterWithDescriptor(
  claudeBackend: AgentBackend,
  opencodeBackend: AgentBackend,
  descriptorSelector: (projectDir: string, touchpoint: TouchpointId) => TestDescriptor,
): BackendRouter {
  return new BackendRouter(
    { claude: () => claudeBackend, opencode: () => opencodeBackend },
    () => 'claude', // outer selector always says claude (all-claude project)
    descriptorSelector,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackendRouter', () => {
  let claudeFake: FakeAgentBackend;
  let opencodeFake: FakeAgentBackend;
  let router: BackendRouter;

  beforeEach(() => {
    claudeFake = new FakeAgentBackend('Claude');
    opencodeFake = new FakeAgentBackend('OpenCode');
    router = makeRouter(claudeFake, opencodeFake);
  });

  // --- Identity ---

  it('has name "BackendRouter"', () => {
    expect(router.name).toBe('BackendRouter');
  });

  // --- Lifecycle fan-out ---

  it('initialize() calls initialize() on the claude backend eagerly', async () => {
    await router.initialize();
    expect(claudeFake.initializeMock).toHaveBeenCalledOnce();
    // opencode not yet instantiated — not called
    expect(opencodeFake.initializeMock).not.toHaveBeenCalled();
  });

  it('initialize() fans out to all instantiated backends', async () => {
    // Force both backends to be instantiated before initialize
    router.sendMessage('tab-claude', 'hello', '/claude-project');
    router.sendMessage('tab-opencode', 'hello', '/opencode-project');
    await router.initialize();
    expect(claudeFake.initializeMock).toHaveBeenCalledOnce();
    expect(opencodeFake.initializeMock).toHaveBeenCalledOnce();
  });

  it('lazily-created backend gets initialize() called when router is already initialized', async () => {
    await router.initialize();
    // opencode was not instantiated during initialize() — first use creates it
    router.sendMessage('tab-opencode', 'hi', '/opencode-project');
    expect(opencodeFake.initializeMock).toHaveBeenCalledOnce();
  });

  it('destroy() fans out to all instantiated backends', async () => {
    await router.initialize();
    router.sendMessage('tab-opencode', 'hi', '/opencode-project');
    router.destroy();
    expect(claudeFake.destroyMock).toHaveBeenCalledOnce();
    expect(opencodeFake.destroyMock).toHaveBeenCalledOnce();
  });

  it('destroy() does not throw when no backends have been instantiated (except claude)', () => {
    expect(() => router.destroy()).not.toThrow();
  });

  it('setMainWindow fans out to all instantiated backends', async () => {
    await router.initialize();
    router.sendMessage('tab-opencode', 'hi', '/opencode-project');
    const fakeWin = {} as never;
    router.setMainWindow(fakeWin);
    expect(claudeFake.setMainWindowMock).toHaveBeenCalledWith(fakeWin);
    expect(opencodeFake.setMainWindowMock).toHaveBeenCalledWith(fakeWin);
  });

  it('setMainWindow(null) fans out to all instantiated backends', async () => {
    await router.initialize();
    router.setMainWindow(null);
    expect(claudeFake.setMainWindowMock).toHaveBeenCalledWith(null);
  });

  it('newly instantiated backend receives current mainWindow at creation time', async () => {
    await router.initialize();
    const fakeWin = {} as never;
    router.setMainWindow(fakeWin);
    // opencode not yet instantiated; first sendMessage creates it
    router.sendMessage('tab-opencode', 'hi', '/opencode-project');
    expect(opencodeFake.setMainWindowMock).toHaveBeenCalledWith(fakeWin);
  });

  // --- Per-tab routing ---

  it('routes sendMessage to claude backend for claude project', () => {
    router.sendMessage('tab-1', 'hello', '/my-claude-project');
    expect(claudeFake.getHistory('tab-1').messages).toHaveLength(1);
    expect(opencodeFake.getHistory('tab-1').messages).toHaveLength(0);
  });

  it('routes sendMessage to opencode backend for opencode project', () => {
    router.sendMessage('tab-2', 'hello', '/my-opencode-project');
    expect(opencodeFake.getHistory('tab-2').messages).toHaveLength(1);
    expect(claudeFake.getHistory('tab-2').messages).toHaveLength(0);
  });

  it('routes different tabs to different backends independently', () => {
    router.sendMessage('tab-c', 'for claude', '/claude-project');
    router.sendMessage('tab-o', 'for opencode', '/opencode-project');
    expect(claudeFake.getHistory('tab-c').messages[0].content).toBe('for claude');
    expect(opencodeFake.getHistory('tab-o').messages[0].content).toBe('for opencode');
  });

  // --- Sticky ownership ---

  it('subsequent sendMessage without projectDir uses established ownership', () => {
    router.sendMessage('tab-sticky', 'first', '/opencode-project');
    router.sendMessage('tab-sticky', 'second'); // no projectDir
    expect(opencodeFake.getHistory('tab-sticky').messages).toHaveLength(2);
    expect(claudeFake.getHistory('tab-sticky').messages).toHaveLength(0);
  });

  it('ownership persists across multiple messages without projectDir', () => {
    router.sendMessage('tab-persist', 'msg1', '/opencode-project');
    for (let i = 0; i < 5; i++) {
      router.sendMessage('tab-persist', `msg${i + 2}`);
    }
    expect(opencodeFake.getHistory('tab-persist').messages).toHaveLength(6);
  });

  // --- resetSession clears ownership ---

  it('resetSession clears tab ownership so next sendMessage can re-establish it', () => {
    router.sendMessage('tab-flip', 'first', '/claude-project');
    expect(claudeFake.getHistory('tab-flip').messages).toHaveLength(1);

    router.resetSession('tab-flip');

    router.sendMessage('tab-flip', 'second', '/opencode-project');
    expect(opencodeFake.getHistory('tab-flip').messages).toHaveLength(1);
    // claude backend's resetSession was called
    expect(claudeFake.cancelSessionMock).not.toHaveBeenCalled(); // not cancel
  });

  it('resetSession delegates to the owning backend', () => {
    router.sendMessage('tab-reset', 'hi', '/opencode-project');
    router.resetSession('tab-reset');
    // After reset, history on the opencode backend is cleared
    expect(opencodeFake.getHistory('tab-reset').messages).toHaveLength(0);
  });

  // --- Unknown tab defaults to claude ---

  it('getHistory for unknown tab defaults to claude backend', () => {
    const history = router.getHistory('never-sent-to');
    // Claude fake returns empty history for unknown tabs
    expect(history).toMatchObject({ messages: [], processing: false });
    // Opencode was not instantiated for this call
    expect(opencodeFake.getHistory('never-sent-to').messages).toHaveLength(0);
  });

  it('cancelSession for unknown tab defaults to claude backend', () => {
    router.cancelSession('unknown-tab');
    expect(claudeFake.cancelSessionMock).toHaveBeenCalledWith('unknown-tab');
    expect(opencodeFake.cancelSessionMock).not.toHaveBeenCalled();
  });

  it('getSessionTokens for unknown tab defaults to claude backend', () => {
    const tokens = router.getSessionTokens('unknown-tab');
    expect(tokens).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('sendMessage without projectDir and no prior ownership defaults to claude', () => {
    router.sendMessage('fresh-tab', 'no project dir given');
    expect(claudeFake.getHistory('fresh-tab').messages).toHaveLength(1);
    expect(opencodeFake.getHistory('fresh-tab').messages).toHaveLength(0);
  });

  // --- Ephemeral routing by projectDir ---

  it('runEphemeralAgent routes to claude for non-opencode project', async () => {
    await router.runEphemeralAgent('prompt', '/claude-project');
    expect(claudeFake.runEphemeralAgentMock).toHaveBeenCalledOnce();
    expect(opencodeFake.runEphemeralAgentMock).not.toHaveBeenCalled();
  });

  it('runEphemeralAgent routes to opencode for opencode project', async () => {
    await router.runEphemeralAgent('prompt', '/opencode-project');
    expect(opencodeFake.runEphemeralAgentMock).toHaveBeenCalledOnce();
    expect(claudeFake.runEphemeralAgentMock).not.toHaveBeenCalled();
  });

  it('spawnEphemeralAgent routes by projectDir', async () => {
    const { promise } = router.spawnEphemeralAgent('prompt', '/opencode-project');
    await promise;
    expect(opencodeFake.spawnEphemeralAgentMock).toHaveBeenCalledOnce();
    expect(claudeFake.spawnEphemeralAgentMock).not.toHaveBeenCalled();
  });

  it('spawnEphemeralSession routes by projectDir', async () => {
    const handle = router.spawnEphemeralSession('prompt', '/opencode-project');
    await handle.initialResult;
    expect(opencodeFake.spawnEphemeralSessionMock).toHaveBeenCalledOnce();
    expect(claudeFake.spawnEphemeralSessionMock).not.toHaveBeenCalled();
  });

  it('ephemeral calls pass through all arguments', async () => {
    const onChunk = vi.fn();
    const attribution = { ticketId: 'T-1', stage: 'spec' };
    const model = 'claude-opus-4-5';
    router.spawnEphemeralAgent('p', '/claude-project', 5000, onChunk, attribution, model);
    expect(claudeFake.spawnEphemeralAgentMock).toHaveBeenCalledWith(
      'p', '/claude-project', 5000, onChunk, attribution, model,
    );
  });

  // --- getEphemeralTimingPath always delegates to claude ---

  it('getEphemeralTimingPath delegates to claude regardless of last backend', async () => {
    // Use opencode as last backend
    await router.runEphemeralAgent('prompt', '/opencode-project');
    const path = router.getEphemeralTimingPath();
    expect(typeof path).toBe('string');
    // The path comes from the claude fake
    expect(path).toBe(claudeFake.getEphemeralTimingPath());
  });

  it('getEphemeralTimingPath instantiates claude if not yet created (no initialize)', () => {
    const routerFresh = makeRouter(claudeFake, opencodeFake);
    // No initialize() called, no sendMessage — claude not yet instantiated
    const path = routerFresh.getEphemeralTimingPath();
    expect(typeof path).toBe('string');
    // Claude backend was constructed to answer this call
    expect(path).toBe(claudeFake.getEphemeralTimingPath());
  });

  // --- Auth routing ---

  it('getAuthStatus defaults to claude before any backend is used', async () => {
    await router.getAuthStatus();
    expect(claudeFake.getAuthStatusMock).toHaveBeenCalledOnce();
    expect(opencodeFake.getAuthStatusMock).not.toHaveBeenCalled();
  });

  it('getAuthStatus routes to last backend resolved by sendMessage', async () => {
    router.sendMessage('tab-x', 'hi', '/opencode-project');
    await router.getAuthStatus();
    expect(opencodeFake.getAuthStatusMock).toHaveBeenCalledOnce();
    expect(claudeFake.getAuthStatusMock).not.toHaveBeenCalled();
  });

  it('login routes to last backend resolved by ephemeral call', async () => {
    await router.runEphemeralAgent('p', '/opencode-project');
    await router.login();
    expect(opencodeFake.loginMock).toHaveBeenCalledOnce();
    expect(claudeFake.loginMock).not.toHaveBeenCalled();
  });

  it('auth reverts to claude if last call was claude', async () => {
    router.sendMessage('tab-oc', 'a', '/opencode-project');
    router.sendMessage('tab-cl', 'b', '/claude-project');
    await router.getAuthStatus();
    expect(claudeFake.getAuthStatusMock).toHaveBeenCalledOnce();
    expect(opencodeFake.getAuthStatusMock).not.toHaveBeenCalled();
  });

  // --- syncCredentials fan-out ---

  it('syncCredentials fans out to all instantiated backends', async () => {
    await router.initialize();
    router.sendMessage('tab-oc', 'hi', '/opencode-project'); // instantiate opencode
    const stacks = [{ status: 'running' }];
    await router.syncCredentials(stacks);
    expect(claudeFake.syncCredentialsMock).toHaveBeenCalledWith(stacks);
    expect(opencodeFake.syncCredentialsMock).toHaveBeenCalledWith(stacks);
  });

  it('syncCredentials only calls instantiated backends (not all factories)', async () => {
    // Only claude is instantiated after initialize()
    await router.initialize();
    await router.syncCredentials([]);
    expect(claudeFake.syncCredentialsMock).toHaveBeenCalledOnce();
    expect(opencodeFake.syncCredentialsMock).not.toHaveBeenCalled();
  });

  // --- Factory errors ---

  it('throws if selector returns a backend type with no registered factory', () => {
    const routerNoOpencode = new BackendRouter(
      { claude: () => claudeFake },
      () => 'opencode',
    );
    expect(() => routerNoOpencode.sendMessage('t', 'msg', '/project')).toThrow(
      /no factory registered for backend type 'opencode'/,
    );
  });

  // --- Claude-only zero-behavior-change ---

  it('with claude-only factories behaves as if directly using the claude backend', async () => {
    const claudeOnly = new BackendRouter(
      { claude: () => claudeFake },
      () => 'claude',
    );
    await claudeOnly.initialize();
    claudeOnly.sendMessage('tab-z', 'test message', '/any-project');
    expect(claudeFake.getHistory('tab-z').messages[0].content).toBe('test message');
    claudeOnly.resetSession('tab-z');
    expect(claudeFake.getHistory('tab-z').messages).toHaveLength(0);
  });

  // --- Touchpoint-aware ephemeral routing via descriptorSelector ---

  describe('touchpoint-aware ephemeral routing', () => {
    let claudeFakeTp: FakeAgentBackend;
    let opencodeFakeTp: FakeAgentBackend;

    beforeEach(() => {
      claudeFakeTp = new FakeAgentBackend('Claude-tp');
      opencodeFakeTp = new FakeAgentBackend('OpenCode-tp');
    });

    it('routes runEphemeralAgent to opencode when pr_description descriptor says opencode', async () => {
      const descriptor: TestDescriptor = {
        backend: 'opencode', provider: 'openai', model: 'gpt-4o', credentials: {},
      };
      const router = makeRouterWithDescriptor(claudeFakeTp, opencodeFakeTp, () => descriptor);

      await router.runEphemeralAgent('draft PR', '/project', undefined, undefined, undefined, 'pr_description');

      expect(opencodeFakeTp.runEphemeralAgentMock).toHaveBeenCalledOnce();
      expect(claudeFakeTp.runEphemeralAgentMock).not.toHaveBeenCalled();
      // model is encoded as "providerID/modelID" for OpenCode
      expect(opencodeFakeTp.runEphemeralAgentMock).toHaveBeenCalledWith(
        'draft PR', '/project', undefined, undefined, 'openai/gpt-4o',
      );
    });

    it('routes spawnEphemeralAgent to opencode with providerID/modelID encoding', async () => {
      const descriptor: TestDescriptor = {
        backend: 'opencode', provider: 'anthropic', model: 'claude-3-5-sonnet', credentials: {},
      };
      const router = makeRouterWithDescriptor(claudeFakeTp, opencodeFakeTp, () => descriptor);

      const { promise } = router.spawnEphemeralAgent(
        'resolve conflict', '/project', undefined, undefined, undefined, undefined, 'merge_conflict',
      );
      await promise;

      expect(opencodeFakeTp.spawnEphemeralAgentMock).toHaveBeenCalledOnce();
      expect(opencodeFakeTp.spawnEphemeralAgentMock).toHaveBeenCalledWith(
        'resolve conflict', '/project', undefined, undefined, undefined, 'anthropic/claude-3-5-sonnet',
      );
    });

    it('routes to claude and passes descriptor.model when touchpoint descriptor says claude', async () => {
      const descriptor: TestDescriptor = {
        backend: 'claude', provider: 'anthropic', model: 'haiku', credentials: {},
      };
      const router = makeRouterWithDescriptor(claudeFakeTp, opencodeFakeTp, () => descriptor);

      await router.runEphemeralAgent('refine spec', '/project', undefined, undefined, undefined, 'refine');

      expect(claudeFakeTp.runEphemeralAgentMock).toHaveBeenCalledOnce();
      expect(opencodeFakeTp.runEphemeralAgentMock).not.toHaveBeenCalled();
      expect(claudeFakeTp.runEphemeralAgentMock).toHaveBeenCalledWith(
        'refine spec', '/project', undefined, undefined, 'haiku',
      );
    });

    it('falls back to outer selector when no touchpoint is provided (all-claude regression)', async () => {
      // Descriptor says opencode, but no touchpoint passed → selector() rules
      const descriptor: TestDescriptor = {
        backend: 'opencode', provider: 'openai', model: 'gpt-4o', credentials: {},
      };
      const router = makeRouterWithDescriptor(claudeFakeTp, opencodeFakeTp, () => descriptor);

      await router.runEphemeralAgent('prompt', '/project'); // no touchpoint arg

      expect(claudeFakeTp.runEphemeralAgentMock).toHaveBeenCalledOnce();
      expect(opencodeFakeTp.runEphemeralAgentMock).not.toHaveBeenCalled();
    });

    it('passes correct projectDir and touchpoint to the descriptorSelector', async () => {
      const descriptorSpy = vi.fn<[string, TouchpointId], TestDescriptor>().mockReturnValue({
        backend: 'claude', provider: 'anthropic', model: 'sonnet', credentials: {},
      });
      const router = makeRouterWithDescriptor(claudeFakeTp, opencodeFakeTp, descriptorSpy);

      await router.runEphemeralAgent('prompt', '/myproject', undefined, undefined, undefined, 'pr_description');

      expect(descriptorSpy).toHaveBeenCalledWith('/myproject', 'pr_description');
    });
  });
});
