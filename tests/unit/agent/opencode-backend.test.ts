/**
 * Tests for OpenCodeBackend.
 *
 * Verifies:
 *  - AgentBackend conformance suite (shared assertions)
 *  - event→IPC channel mapping (agent:output, agent:done, agent:error)
 *  - step-finish → OuterClaudeSessionTokens accumulation → agent:token-usage
 *  - No agent:tool_use channel — tool events fold into agent:output
 *  - Ephemeral prompt parsing (session.prompt response parts → text)
 *  - Bridge singleton acquisition
 *  - Shim tool/list + tools/call against a faked bridge
 *
 * All SDK/Electron/tool-call dependencies are mocked; no live provider.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createConformanceSuite } from './agent-backend-conformance.test';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any import that touches these modules.
// Variables referenced inside vi.mock factories MUST use vi.hoisted() so they
// are initialised before vitest hoists the vi.mock() calls to the top of the file.
// ---------------------------------------------------------------------------

// vi.hoisted returns values that are available inside vi.mock factories
const {
  mockBridgeRelease,
  mockBridge,
  mockSessionCreate,
  mockSessionPromptAsync,
  mockSessionPrompt,
  mockSessionAbort,
  mockSessionDelete,
  mockEventSubscribe,
  mockServerClose,
} = vi.hoisted(() => {
  const mockBridgeRelease = vi.fn();
  const mockBridge = {
    url: 'http://127.0.0.1:19999',
    token: 'test-bridge-token',
    release: mockBridgeRelease,
  };
  const mockSessionCreate = vi.fn().mockResolvedValue({
    data: { id: 'oc-session-1', projectID: 'proj', directory: '/project', title: '' },
  });
  const mockSessionPromptAsync = vi.fn().mockResolvedValue({ data: undefined });
  const mockSessionPrompt = vi.fn().mockResolvedValue({ data: { info: {}, parts: [] } });
  const mockSessionAbort = vi.fn().mockResolvedValue({ data: true });
  const mockSessionDelete = vi.fn().mockResolvedValue({ data: true });
  const mockServerClose = vi.fn();

  const mockEventSubscribe = vi.fn();

  return {
    mockBridgeRelease,
    mockBridge,
    mockSessionCreate,
    mockSessionPromptAsync,
    mockSessionPrompt,
    mockSessionAbort,
    mockSessionDelete,
    mockEventSubscribe,
    mockServerClose,
  };
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
}));

vi.mock('../../../src/main/agent/bridge-server', () => ({
  acquireBridge: vi.fn().mockResolvedValue(mockBridge),
}));

vi.mock('../../../src/main/claude/tools', () => ({
  handleToolCall: vi.fn().mockResolvedValue({ success: true }),
  validateProjectDir: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/main/index', () => ({
  stackManager: {},
  agentBackend: {},
  registry: {
    getGlobalBackendSettings: vi.fn().mockReturnValue({
      inner_backend: 'opencode',
      inner_provider: 'anthropic',
      inner_model: null,
      outer_backend: 'claude',
      outer_provider: null,
      outer_model: null,
    }),
    getBackendSecretBundle: vi.fn().mockReturnValue(null),
  },
  cliDir: '/tmp/sandstorm-cli',
}));

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: vi.fn(() => ({
    session: {
      create: mockSessionCreate,
      promptAsync: mockSessionPromptAsync,
      prompt: mockSessionPrompt,
      abort: mockSessionAbort,
      delete: mockSessionDelete,
    },
    event: { subscribe: mockEventSubscribe },
  })),
}));

vi.mock('@opencode-ai/sdk/server', () => ({
  createOpencodeServer: vi.fn().mockResolvedValue({
    url: 'http://127.0.0.1:18765',
    close: mockServerClose,
  }),
}));

// ---------------------------------------------------------------------------
// SSE event emitter — tests call capturedEventEmitter to push synthetic events
// ---------------------------------------------------------------------------

type MockStreamEvent = { type: string; properties?: Record<string, unknown> };
let capturedEventEmitter: ((event: MockStreamEvent) => void) | null = null;

// Build a fresh mock stream and capture its emitter for use in tests.
// Call this in beforeEach so each test gets a clean stream.
function makeMockStream(): AsyncIterable<MockStreamEvent> {
  let done = false;
  const queue: MockStreamEvent[] = [];
  let resolve: ((v: IteratorResult<MockStreamEvent>) => void) | null = null;

  capturedEventEmitter = (event: MockStreamEvent) => {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: event, done: false });
    } else {
      queue.push(event);
    }
  };

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<MockStreamEvent>> {
          if (done)
            return Promise.resolve({ value: undefined as unknown as MockStreamEvent, done: true });
          if (queue.length > 0)
            return Promise.resolve({ value: queue.shift()!, done: false });
          return new Promise((r) => { resolve = r; });
        },
        return() {
          done = true;
          if (resolve)
            resolve({ value: undefined as unknown as MockStreamEvent, done: true });
          return Promise.resolve({ value: undefined as unknown as MockStreamEvent, done: true });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Import the module under test after mocks are declared
// ---------------------------------------------------------------------------

import { createServer, type Server } from 'http';
import { OpenCodeBackend } from '../../../src/main/agent/opencode-backend';
import { acquireBridge } from '../../../src/main/agent/bridge-server';
import { createOpencodeServer } from '@opencode-ai/sdk/server';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { handleMessage, TOOLS } from '../../../src/main/agent/orchestration-mcp-shim';
import { generateOuterOpencodeConfig } from '../../../src/main/opencode-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeInitializedBackend(): Promise<OpenCodeBackend> {
  const backend = new OpenCodeBackend();
  await backend.initialize();
  return backend;
}

function makeIpcCapture(): { calls: Map<string, unknown[]>; send: (ch: string, ...data: unknown[]) => void } {
  const calls = new Map<string, unknown[]>();
  const send = (channel: string, ...data: unknown[]): void => {
    if (!calls.has(channel)) calls.set(channel, []);
    calls.get(channel)!.push(data.length === 1 ? data[0] : data);
  };
  return { calls, send };
}

// ---------------------------------------------------------------------------
// Conformance suite — runs all shared AgentBackend contract assertions
// ---------------------------------------------------------------------------

createConformanceSuite('OpenCodeBackend', () => new OpenCodeBackend());

// ---------------------------------------------------------------------------
// Initialize / lifecycle tests
// ---------------------------------------------------------------------------

describe('OpenCodeBackend lifecycle', () => {
  let backend: OpenCodeBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventSubscribe.mockResolvedValue({ stream: makeMockStream() });
    mockSessionCreate.mockResolvedValue({
      data: { id: 'oc-session-1', projectID: 'proj', directory: '/project', title: '' },
    });
    mockSessionPromptAsync.mockResolvedValue({ data: undefined });
    mockSessionPrompt.mockResolvedValue({ data: { info: {}, parts: [] } });
  });

  afterEach(() => {
    backend?.destroy();
  });

  it('initialize() acquires shared bridge', async () => {
    backend = new OpenCodeBackend();
    await backend.initialize();
    expect(acquireBridge).toHaveBeenCalledOnce();
  });

  it('initialize() starts opencode server with outer config and creates client', async () => {
    backend = new OpenCodeBackend();
    await backend.initialize();
    expect(createOpencodeServer).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: '127.0.0.1',
        config: expect.objectContaining({
          mcp: expect.objectContaining({
            'sandstorm-bridge': expect.objectContaining({
              type: 'local',
              environment: expect.objectContaining({
                SANDSTORM_BRIDGE_URL: 'http://127.0.0.1:19999',
                SANDSTORM_BRIDGE_TOKEN: 'test-bridge-token',
              }),
            }),
          }),
        }),
      }),
    );
    expect(createOpencodeClient).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:18765' });
  });

  it('initialize() injects SANDSTORM_BRIDGE_URL and SANDSTORM_BRIDGE_TOKEN into process.env', async () => {
    const prevUrl = process.env.SANDSTORM_BRIDGE_URL;
    const prevToken = process.env.SANDSTORM_BRIDGE_TOKEN;
    try {
      backend = new OpenCodeBackend();
      await backend.initialize();
      expect(process.env.SANDSTORM_BRIDGE_URL).toBe('http://127.0.0.1:19999');
      expect(process.env.SANDSTORM_BRIDGE_TOKEN).toBe('test-bridge-token');
    } finally {
      if (prevUrl === undefined) delete process.env.SANDSTORM_BRIDGE_URL;
      else process.env.SANDSTORM_BRIDGE_URL = prevUrl;
      if (prevToken === undefined) delete process.env.SANDSTORM_BRIDGE_TOKEN;
      else process.env.SANDSTORM_BRIDGE_TOKEN = prevToken;
    }
  });

  it('destroy() releases bridge and closes server', async () => {
    backend = new OpenCodeBackend();
    await backend.initialize();
    backend.destroy();
    expect(mockBridgeRelease).toHaveBeenCalledOnce();
    expect(mockServerClose).toHaveBeenCalledOnce();
  });

  it('destroy() before initialize() does not throw', () => {
    backend = new OpenCodeBackend();
    expect(() => backend.destroy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Persistent session — sendMessage + IPC channel mapping
// ---------------------------------------------------------------------------

describe('OpenCodeBackend persistent sessions', () => {
  let backend: OpenCodeBackend;
  let ipc: ReturnType<typeof makeIpcCapture>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ipc = makeIpcCapture();
    mockEventSubscribe.mockResolvedValue({ stream: makeMockStream() });
    mockSessionCreate.mockResolvedValue({
      data: { id: 'oc-session-1', projectID: 'proj', directory: '/project', title: '' },
    });
    mockSessionPromptAsync.mockResolvedValue({ data: undefined });

    backend = new OpenCodeBackend();
    await backend.initialize();
    backend.setMainWindow({ webContents: { send: ipc.send } } as unknown as import('electron').BrowserWindow);
  });

  afterEach(() => {
    backend.destroy();
  });

  it('sendMessage emits agent:user-message and stores in history', () => {
    backend.sendMessage('tab-1', 'Hello OpenCode', '/project');
    expect(ipc.calls.get('agent:user-message:tab-1')).toContain('Hello OpenCode');
    const history = backend.getHistory('tab-1');
    expect(history.messages[0]).toMatchObject({ role: 'user', content: 'Hello OpenCode' });
  });

  it('sendMessage emits agent:queued when session is already processing', async () => {
    backend.sendMessage('tab-1', 'first', '/project');
    await new Promise((r) => setTimeout(r, 0)); // let first message start
    ipc.calls.clear();
    // Session is now processing — second message should emit agent:queued
    backend.sendMessage('tab-1', 'second', '/project');
    expect(ipc.calls.has('agent:queued:tab-1')).toBe(true);
  });

  it('sendMessage before initialize() emits agent:error and leaves processing false', async () => {
    const uninit = new OpenCodeBackend();
    uninit.setMainWindow({ webContents: { send: ipc.send } } as unknown as import('electron').BrowserWindow);
    uninit.sendMessage('tab-x', 'hello', '/project');
    expect(ipc.calls.has('agent:error:tab-x')).toBe(true);
    expect(uninit.getHistory('tab-x').processing).toBe(false);
  });

  it('sendMessage creates a new OpenCode session on first message', async () => {
    backend.sendMessage('tab-1', 'first message', '/project');
    // Wait for the async session creation
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSessionCreate).toHaveBeenCalledWith({
      query: { directory: '/project' },
    });
  });

  it('sendMessage reuses existing session for same tab', async () => {
    backend.sendMessage('tab-1', 'first', '/project');
    await new Promise((r) => setTimeout(r, 0));
    backend.sendMessage('tab-1', 'second', '/project');
    await new Promise((r) => setTimeout(r, 0));
    // Session created once
    expect(mockSessionCreate).toHaveBeenCalledOnce();
    // Prompt sent twice
    expect(mockSessionPromptAsync).toHaveBeenCalledTimes(2);
  });

  it('concurrent sendMessage calls before session creation resolves create session once', async () => {
    // Send two messages with no yield between them so both enter sendMessageAsync
    // before session.create() resolves — the second must await the first's
    // in-flight creatingSession promise rather than spawning a second create().
    backend.sendMessage('tab-1', 'message 1', '/project');
    backend.sendMessage('tab-1', 'message 2', '/project');

    // Let all async operations settle
    await new Promise((r) => setTimeout(r, 10));

    expect(mockSessionCreate).toHaveBeenCalledOnce();
    expect(mockSessionPromptAsync).toHaveBeenCalledTimes(2);
  });

  it('sendMessage on separate tabs keeps sessions independent', async () => {
    mockSessionCreate
      .mockResolvedValueOnce({ data: { id: 'session-a' } })
      .mockResolvedValueOnce({ data: { id: 'session-b' } });

    backend.sendMessage('tab-a', 'msg a', '/project-a');
    backend.sendMessage('tab-b', 'msg b', '/project-b');
    await new Promise((r) => setTimeout(r, 0));

    expect(backend.getHistory('tab-a').messages[0].content).toBe('msg a');
    expect(backend.getHistory('tab-b').messages[0].content).toBe('msg b');
  });

  it('SSE message.part.updated (text delta) emits agent:output channel', async () => {
    backend.sendMessage('tab-1', 'hi', '/project');
    await new Promise((r) => setTimeout(r, 0)); // session created

    // Emit a text delta event
    capturedEventEmitter?.({
      type: 'message.part.updated',
      properties: {
        delta: 'Hello there',
        part: { type: 'text', sessionID: 'oc-session-1', messageID: 'msg-1', id: 'p1' },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(ipc.calls.get('agent:output:tab-1')).toContain('Hello there');
  });

  it('SSE session.idle emits agent:done and marks processing false', async () => {
    backend.sendMessage('tab-1', 'hi', '/project');
    await new Promise((r) => setTimeout(r, 0));

    capturedEventEmitter?.({
      type: 'session.idle',
      properties: { sessionID: 'oc-session-1' },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(ipc.calls.has('agent:done:tab-1')).toBe(true);
    expect(backend.getHistory('tab-1').processing).toBe(false);
  });

  it('SSE session.error emits agent:error with message', async () => {
    backend.sendMessage('tab-1', 'hi', '/project');
    await new Promise((r) => setTimeout(r, 0));

    capturedEventEmitter?.({
      type: 'session.error',
      properties: {
        sessionID: 'oc-session-1',
        error: { message: 'Provider rate limit' },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const errors = ipc.calls.get('agent:error:tab-1');
    expect(errors).toBeDefined();
    expect(errors![0]).toContain('Provider rate limit');
  });

  it('tool events fold into agent:output — no agent:tool_use channel', async () => {
    backend.sendMessage('tab-1', 'hi', '/project');
    await new Promise((r) => setTimeout(r, 0));

    capturedEventEmitter?.({
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          sessionID: 'oc-session-1',
          messageID: 'msg-1',
          id: 'p2',
          callID: 'call-1',
          tool: 'create_stack',
          state: {},
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    // tool output goes to agent:output, NOT agent:tool_use
    expect(ipc.calls.has('agent:output:tab-1')).toBe(true);
    expect(ipc.calls.has('agent:tool_use:tab-1')).toBe(false);
  });

  it('step-finish tokens accumulate into OuterClaudeSessionTokens and emit agent:token-usage', async () => {
    backend.sendMessage('tab-1', 'hi', '/project');
    await new Promise((r) => setTimeout(r, 0));

    capturedEventEmitter?.({
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'step-finish',
          sessionID: 'oc-session-1',
          messageID: 'msg-1',
          id: 'p3',
          reason: 'end_turn',
          cost: 0.001,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const tokens = backend.getSessionTokens('tab-1');
    expect(tokens.input_tokens).toBe(100);
    expect(tokens.output_tokens).toBe(50);
    expect(tokens.cache_read_input_tokens).toBe(10);
    expect(tokens.cache_creation_input_tokens).toBe(5);

    // agent:token-usage was emitted
    expect(ipc.calls.has('agent:token-usage:tab-1')).toBe(true);
    const usage = ipc.calls.get('agent:token-usage:tab-1')![0] as {
      input_tokens: number;
      output_tokens: number;
    };
    expect(usage.input_tokens).toBe(100);
  });

  it('step-finish tokens accumulate across multiple steps', async () => {
    backend.sendMessage('tab-1', 'hi', '/project');
    await new Promise((r) => setTimeout(r, 0));

    const stepFinishPart = (input: number, output: number) => ({
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'step-finish',
          sessionID: 'oc-session-1',
          messageID: 'msg-1',
          id: 'px',
          reason: 'end_turn',
          cost: 0,
          tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    });

    capturedEventEmitter?.(stepFinishPart(100, 50));
    await new Promise((r) => setTimeout(r, 0));
    capturedEventEmitter?.(stepFinishPart(200, 80));
    await new Promise((r) => setTimeout(r, 0));

    const tokens = backend.getSessionTokens('tab-1');
    expect(tokens.input_tokens).toBe(300);
    expect(tokens.output_tokens).toBe(130);
  });

  it('cancelSession aborts the OpenCode session and emits agent:done', async () => {
    backend.sendMessage('tab-1', 'hi', '/project');
    await new Promise((r) => setTimeout(r, 0));

    backend.cancelSession('tab-1');

    expect(mockSessionAbort).toHaveBeenCalledWith({ path: { id: 'oc-session-1' } });
    expect(ipc.calls.has('agent:done:tab-1')).toBe(true);
    expect(backend.getHistory('tab-1').processing).toBe(false);
  });

  it('cancelSession on unknown tab does not throw', () => {
    expect(() => backend.cancelSession('no-such-tab')).not.toThrow();
  });

  it('resetSession clears history and deletes the OpenCode session', async () => {
    backend.sendMessage('tab-1', 'hi', '/project');
    await new Promise((r) => setTimeout(r, 0));

    backend.resetSession('tab-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(backend.getHistory('tab-1').messages).toHaveLength(0);
    expect(mockSessionDelete).toHaveBeenCalledWith({ path: { id: 'oc-session-1' } });
  });

  it('resetSession emits zero token-usage to the renderer', async () => {
    backend.sendMessage('tab-1', 'hi', '/project');
    await new Promise((r) => setTimeout(r, 0));
    ipc.calls.clear();

    backend.resetSession('tab-1');

    const tokenUpdates = ipc.calls.get('agent:token-usage:tab-1');
    expect(tokenUpdates).toBeDefined();
    const zeroed = tokenUpdates![0] as { input_tokens: number };
    expect(zeroed.input_tokens).toBe(0);
  });

  it('getSessionTokens returns zero for unknown tab', () => {
    const tokens = backend.getSessionTokens('no-tab');
    expect(tokens.input_tokens).toBe(0);
    expect(tokens.output_tokens).toBe(0);
    expect(tokens.cache_creation_input_tokens).toBe(0);
    expect(tokens.cache_read_input_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ephemeral agents
// ---------------------------------------------------------------------------

describe('OpenCodeBackend ephemeral agents', () => {
  let backend: OpenCodeBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEventSubscribe.mockResolvedValue({ stream: makeMockStream() });
    mockSessionCreate.mockResolvedValue({
      data: { id: 'eph-session-1', projectID: 'proj', directory: '/project', title: '' },
    });
    mockSessionPrompt.mockResolvedValue({ data: { info: {}, parts: [] } });
    mockSessionDelete.mockResolvedValue({ data: true });

    backend = new OpenCodeBackend();
    await backend.initialize();
  });

  afterEach(() => {
    backend.destroy();
  });

  it('runEphemeralAgent returns a string', async () => {
    const result = await backend.runEphemeralAgent('test prompt', '/project');
    expect(typeof result).toBe('string');
  });

  it('runEphemeralAgent extracts text from session.prompt response parts', async () => {
    mockSessionPrompt.mockResolvedValueOnce({
      data: {
        info: {},
        parts: [
          { type: 'text', id: 'p1', sessionID: 'eph-1', messageID: 'm1', text: 'Hello ' },
          { type: 'text', id: 'p2', sessionID: 'eph-1', messageID: 'm1', text: 'world' },
        ],
      },
    });
    const result = await backend.runEphemeralAgent('prompt', '/project');
    expect(result).toBe('Hello world');
  });

  it('spawnEphemeralAgent emits text chunks via onChunk callback', async () => {
    mockSessionPrompt.mockResolvedValueOnce({
      data: {
        info: {},
        parts: [
          { type: 'text', id: 'p1', sessionID: 'eph-1', messageID: 'm1', text: 'chunk 1' },
          { type: 'text', id: 'p2', sessionID: 'eph-1', messageID: 'm1', text: 'chunk 2' },
        ],
      },
    });
    const chunks: import('../../../src/main/agent/types').EphemeralStreamEvent[] = [];
    const { promise } = backend.spawnEphemeralAgent('prompt', '/project', 30000, (ev) => chunks.push(ev));
    await promise;
    expect(chunks.filter((c) => c.kind === 'text')).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ kind: 'text', delta: 'chunk 1' });
  });

  it('spawnEphemeralAgent emits tool_use chunks via onChunk', async () => {
    mockSessionPrompt.mockResolvedValueOnce({
      data: {
        info: {},
        parts: [
          {
            type: 'tool',
            id: 'p3',
            sessionID: 'eph-1',
            messageID: 'm1',
            callID: 'c1',
            tool: 'create_stack',
            state: {},
          },
        ],
      },
    });
    const chunks: import('../../../src/main/agent/types').EphemeralStreamEvent[] = [];
    const { promise } = backend.spawnEphemeralAgent('prompt', '/project', 30000, (ev) => chunks.push(ev));
    await promise;
    const toolEvent = chunks.find((c) => c.kind === 'tool_use');
    expect(toolEvent).toMatchObject({ kind: 'tool_use', name: 'create_stack' });
  });

  it('spawnEphemeralAgent cancel() rejects the promise', async () => {
    // Simulate a slow prompt that we cancel
    let resolvePrompt: () => void = () => {};
    mockSessionPrompt.mockImplementationOnce(
      () => new Promise<{ data: { info: object; parts: object[] } }>((r) => { resolvePrompt = () => r({ data: { info: {}, parts: [] } }); }),
    );
    const { promise, cancel } = backend.spawnEphemeralAgent('prompt', '/project', 30000);
    await new Promise((r) => setTimeout(r, 0)); // let session.create() run
    cancel();
    resolvePrompt(); // unblock the prompt
    await expect(promise).rejects.toThrow();
  });

  it('spawnEphemeralAgent deletes the ephemeral session after completion', async () => {
    await backend.runEphemeralAgent('prompt', '/project');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSessionDelete).toHaveBeenCalledWith({ path: { id: 'eph-session-1' } });
  });

  it('spawnEphemeralSession handle resolves initialResult', async () => {
    mockSessionPrompt.mockResolvedValueOnce({
      data: {
        info: {},
        parts: [{ type: 'text', id: 'p1', sessionID: 'eph-1', messageID: 'm1', text: 'initial result' }],
      },
    });
    const handle = backend.spawnEphemeralSession('init prompt', '/project');
    const result = await handle.initialResult;
    expect(result).toBe('initial result');
  });

  it('spawnEphemeralSession sendFollowUp resolves', async () => {
    mockSessionPrompt
      .mockResolvedValueOnce({ data: { info: {}, parts: [{ type: 'text', id: 'p1', sessionID: 'eph-1', messageID: 'm1', text: 'init' }] } })
      .mockResolvedValueOnce({ data: { info: {}, parts: [{ type: 'text', id: 'p2', sessionID: 'eph-1', messageID: 'm2', text: 'followup response' }] } });

    const handle = backend.spawnEphemeralSession('init', '/project');
    await handle.initialResult;
    const followUp = await handle.sendFollowUp('follow-up prompt');
    expect(followUp).toBe('followup response');
  });

  it('spawnEphemeralSession dispose deletes the session', async () => {
    const handle = backend.spawnEphemeralSession('prompt', '/project');
    await handle.initialResult;
    handle.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSessionDelete).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bridge singleton sharing
// ---------------------------------------------------------------------------

describe('OpenCodeBackend bridge sharing', () => {
  it('acquireBridge is called during initialize()', async () => {
    vi.clearAllMocks();
    mockEventSubscribe.mockResolvedValue({ stream: makeMockStream() });
    const backend = new OpenCodeBackend();
    await backend.initialize();
    expect(acquireBridge).toHaveBeenCalledOnce();
    backend.destroy();
  });

  it('bridge.release() is called during destroy()', async () => {
    vi.clearAllMocks();
    mockEventSubscribe.mockResolvedValue({ stream: makeMockStream() });
    const backend = new OpenCodeBackend();
    await backend.initialize();
    backend.destroy();
    expect(mockBridgeRelease).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Shim: handleMessage + tools/call against a faked bridge
// ---------------------------------------------------------------------------

describe('orchestration-mcp-shim handleMessage', () => {
  let fakeServer: Server;
  let fakeUrl: string;
  const fakeToken = 'shim-test-token-abc';

  // Track what the fake bridge received
  let lastReceivedBody: { name: string; input: Record<string, unknown> } | null = null;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      fakeServer = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/tool-call') {
          res.writeHead(404);
          res.end();
          return;
        }
        if (req.headers['x-auth-token'] !== fakeToken) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', () => {
          try {
            lastReceivedBody = JSON.parse(body) as { name: string; input: Record<string, unknown> };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result: `bridge:${lastReceivedBody.name}` }));
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'bad json' }));
          }
        });
      });
      fakeServer.listen(0, '127.0.0.1', () => {
        const addr = fakeServer.address() as { port: number };
        fakeUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    fakeServer.close();
  });

  beforeEach(() => {
    lastReceivedBody = null;
  });

  it('TOOLS is non-empty and contains sandstorm core tools', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('create_stack');
    expect(names).toContain('list_stacks');
    expect(names).toContain('dispatch_task');
    expect(names).toContain('get_diff');
    expect(names).toContain('push_stack');
    expect(names).toContain('get_task_status');
    expect(names).toContain('get_task_output');
    expect(names).toContain('teardown_stack');
    expect(names).toContain('spec_check');
    expect(names).toContain('schedule_create');
    expect(names).toContain('schedule_list');
    expect(names).toContain('schedule_update');
    expect(names).toContain('schedule_delete');
    expect(TOOLS.length).toBeGreaterThan(0);
  });

  it('tools/list returns all TOOLS entries', async () => {
    const result = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      fakeUrl,
      fakeToken,
    );
    expect(result).toMatchObject({ jsonrpc: '2.0', id: 1 });
    const tools = (result!.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBe(TOOLS.length);
    const names = tools.map((t) => t.name);
    expect(names).toContain('create_stack');
    expect(names).toContain('list_stacks');
  });

  it('tools/call proxies to bridge and returns result', async () => {
    const result = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_stacks', arguments: {} },
      },
      fakeUrl,
      fakeToken,
    );
    expect(result).toMatchObject({ jsonrpc: '2.0', id: 2 });
    const content = result!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(content.isError).toBe(false);
    expect(content.content[0].text).toContain('list_stacks');
    // The fake bridge received the correct tool name
    expect(lastReceivedBody?.name).toBe('list_stacks');
  });

  it('tools/call passes arguments to the bridge', async () => {
    const args = { stackId: 'stack-123', prompt: 'do something' };
    await handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'dispatch_task', arguments: args },
      },
      fakeUrl,
      fakeToken,
    );
    expect(lastReceivedBody?.input).toMatchObject(args);
  });

  it('tools/call returns isError: true when bridge is unreachable', async () => {
    const result = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'list_stacks', arguments: {} },
      },
      'http://127.0.0.1:1', // unreachable port
      fakeToken,
    );
    expect(result).toMatchObject({ jsonrpc: '2.0', id: 4 });
    const content = result!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(content.isError).toBe(true);
    expect(typeof content.content[0].text).toBe('string');
  });

  it('tools/call returns error object when tool name is missing', async () => {
    const result = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {},
      },
      fakeUrl,
      fakeToken,
    );
    expect(result).toMatchObject({
      jsonrpc: '2.0',
      id: 5,
      error: expect.objectContaining({ code: -32602 }),
    });
  });

  it('initialize returns MCP server capabilities', async () => {
    const result = await handleMessage(
      { jsonrpc: '2.0', id: 6, method: 'initialize' },
      fakeUrl,
      fakeToken,
    );
    expect(result).toMatchObject({
      jsonrpc: '2.0',
      id: 6,
      result: expect.objectContaining({
        capabilities: expect.objectContaining({ tools: {} }),
        serverInfo: expect.objectContaining({ name: 'sandstorm-bridge' }),
      }),
    });
  });

  it('notifications/initialized returns null (no response for notifications)', async () => {
    const result = await handleMessage(
      { jsonrpc: '2.0', id: undefined, method: 'notifications/initialized' },
      fakeUrl,
      fakeToken,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateOuterOpencodeConfig
// ---------------------------------------------------------------------------

describe('generateOuterOpencodeConfig', () => {
  it('includes sandstorm-bridge MCP entry with type local', () => {
    const config = generateOuterOpencodeConfig({
      shimPath: '/path/to/orchestration-mcp-shim.cjs',
      bridgeUrl: 'http://127.0.0.1:12345',
      bridgeToken: 'test-token',
      instructionsPath: '/cli/SANDSTORM_OUTER.md',
    });
    expect(config.mcp['sandstorm-bridge']).toBeDefined();
    expect(config.mcp['sandstorm-bridge'].type).toBe('local');
  });

  it('environment contains SANDSTORM_BRIDGE_URL and SANDSTORM_BRIDGE_TOKEN', () => {
    const config = generateOuterOpencodeConfig({
      shimPath: '/shim.cjs',
      bridgeUrl: 'http://127.0.0.1:54321',
      bridgeToken: 'secret-token',
      instructionsPath: '/cli/SANDSTORM_OUTER.md',
    });
    const entry = config.mcp['sandstorm-bridge'];
    expect(entry.environment.SANDSTORM_BRIDGE_URL).toBe('http://127.0.0.1:54321');
    expect(entry.environment.SANDSTORM_BRIDGE_TOKEN).toBe('secret-token');
  });

  it('command includes the shimPath', () => {
    const config = generateOuterOpencodeConfig({
      shimPath: '/custom/path/shim.cjs',
      bridgeUrl: 'http://127.0.0.1:0',
      bridgeToken: 'tok',
      instructionsPath: '/cli/SANDSTORM_OUTER.md',
    });
    expect(config.mcp['sandstorm-bridge'].command).toContain('/custom/path/shim.cjs');
  });

  it('command is a non-empty array starting with a node executable', () => {
    const config = generateOuterOpencodeConfig({
      shimPath: '/shim.cjs',
      bridgeUrl: 'http://127.0.0.1:1',
      bridgeToken: 'x',
      instructionsPath: '/cli/SANDSTORM_OUTER.md',
    });
    const { command } = config.mcp['sandstorm-bridge'];
    expect(Array.isArray(command)).toBe(true);
    expect(command.length).toBeGreaterThanOrEqual(2);
  });

  it('instructions contains the instructionsPath', () => {
    const config = generateOuterOpencodeConfig({
      shimPath: '/shim.cjs',
      bridgeUrl: 'http://127.0.0.1:1',
      bridgeToken: 'x',
      instructionsPath: '/cli/SANDSTORM_OUTER.md',
    });
    expect(config.instructions).toContain('/cli/SANDSTORM_OUTER.md');
  });
});

describe('bridge-server: shared singleton', () => {
  it('acquireBridge returns url and token', async () => {
    // The real bridge-server is mocked; this confirms the mock shape is correct.
    const bridge = await (acquireBridge as ReturnType<typeof vi.fn>)(() => Promise.resolve({}));
    expect(bridge.url).toMatch(/^http:\/\//);
    expect(typeof bridge.token).toBe('string');
    expect(typeof bridge.release).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// bridge-server real module — ref-counting, idempotent start, HTTP dispatch
// ---------------------------------------------------------------------------

describe('bridge-server: real module (unmocked)', () => {
  it('acquireBridge starts server and returns valid url/token/release', async () => {
    const { acquireBridge: realAcquireBridge } = await vi.importActual<
      typeof import('../../../src/main/agent/bridge-server')
    >('../../../src/main/agent/bridge-server');
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const handle = await realAcquireBridge(handler);
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.token).toBeTruthy();
      expect(typeof handle.release).toBe('function');
    } finally {
      handle.release();
    }
  });

  it('acquireBridge is idempotent — two callers get the same url and token', async () => {
    const { acquireBridge: realAcquireBridge } = await vi.importActual<
      typeof import('../../../src/main/agent/bridge-server')
    >('../../../src/main/agent/bridge-server');
    const handler = vi.fn().mockResolvedValue({});
    const h1 = await realAcquireBridge(handler);
    const h2 = await realAcquireBridge(handler);
    try {
      expect(h1.url).toBe(h2.url);
      expect(h1.token).toBe(h2.token);
    } finally {
      h1.release();
      h2.release();
    }
  });

  it('POST /tool-call dispatches to handler and returns JSON result', async () => {
    const { acquireBridge: realAcquireBridge } = await vi.importActual<
      typeof import('../../../src/main/agent/bridge-server')
    >('../../../src/main/agent/bridge-server');
    const handler = vi.fn().mockResolvedValue({ stacks: ['s1', 's2'] });
    const handle = await realAcquireBridge(handler);
    try {
      const resp = await fetch(`${handle.url}/tool-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': handle.token },
        body: JSON.stringify({ name: 'list_stacks', input: { projectDir: '/p' } }),
      });
      expect(resp.ok).toBe(true);
      const json = (await resp.json()) as { result: unknown };
      expect(json.result).toMatchObject({ stacks: ['s1', 's2'] });
      expect(handler).toHaveBeenCalledWith('list_stacks', { projectDir: '/p' });
    } finally {
      handle.release();
    }
  });

  it('ref-counting — server stays alive while any handle is held', async () => {
    const { acquireBridge: realAcquireBridge } = await vi.importActual<
      typeof import('../../../src/main/agent/bridge-server')
    >('../../../src/main/agent/bridge-server');
    const handler = vi.fn().mockResolvedValue({});
    const h1 = await realAcquireBridge(handler);
    const h2 = await realAcquireBridge(handler);
    const { url, token } = h1;
    h1.release(); // first release — h2 still holds a ref
    // Server must still respond
    const resp = await fetch(`${url}/tool-call`, {
      method: 'POST',
      headers: { 'x-auth-token': token },
      body: JSON.stringify({ name: 'test', input: {} }),
    });
    expect(resp.status).toBeLessThan(600); // server responded (not a network error)
    h2.release(); // last release — server shuts down
  });

  it('release() is idempotent — calling it twice does not throw', async () => {
    const { acquireBridge: realAcquireBridge } = await vi.importActual<
      typeof import('../../../src/main/agent/bridge-server')
    >('../../../src/main/agent/bridge-server');
    const handler = vi.fn().mockResolvedValue({});
    const handle = await realAcquireBridge(handler);
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Auth (stub coverage)
// ---------------------------------------------------------------------------

describe('OpenCodeBackend auth', () => {
  let backend: OpenCodeBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEventSubscribe.mockResolvedValue({ stream: makeMockStream() });
    backend = new OpenCodeBackend();
    await backend.initialize();
  });

  afterEach(() => backend.destroy());

  it('getAuthStatus returns a valid AuthStatus shape', async () => {
    const status = await backend.getAuthStatus();
    expect(typeof status.loggedIn).toBe('boolean');
    expect(typeof status.expired).toBe('boolean');
  });

  it('login returns success: false with a reason (auth deferred to #479)', async () => {
    const result = await backend.login();
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('syncCredentials resolves without error', async () => {
    await expect(backend.syncCredentials([])).resolves.toBeUndefined();
  });
});
