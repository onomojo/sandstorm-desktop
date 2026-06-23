// @ts-nocheck — @opencode-ai/sdk not yet installed; typecheck deferred until package lands
/**
 * OpenCode implementation of AgentBackend.
 *
 * Manages an opencode serve process via @opencode-ai/sdk (pinned at 1.17.7),
 * maps SSE events to the existing renderer IPC channels, and exposes the
 * Sandstorm orchestration tools to OpenCode via the shared bridge shim.
 *
 * SDK types cited from @opencode-ai/sdk@1.17.7:
 *   - Event (EventSubscribeResponses[200]) — types.gen.d.ts
 *   - EventMessagePartUpdated, EventSessionIdle, EventSessionError — types.gen.d.ts
 *   - StepFinishPart, TextPart, ToolPart — types.gen.d.ts
 *   - OpencodeClient, createOpencodeClient — client.d.ts / sdk.gen.d.ts
 *   - createOpencodeServer — server.d.ts
 *   - SessionPromptAsyncData, SessionCreateData — types.gen.d.ts
 */

import path from 'path';
import os from 'os';
import { BrowserWindow } from 'electron';
import { app } from 'electron';
// @opencode-ai/sdk is ESM-only — static require() fails in the CJS bundle.
// All runtime values are imported dynamically inside initialize() so that
// Vite keeps them as real import() calls (same pattern as node-pty).
// Only type-level imports are used here; they are erased by tsc at build time.
import type {
  OpencodeClient,
  Event as OpenCodeEvent,
  EventMessagePartUpdated,
  EventSessionIdle,
  EventSessionError,
  StepFinishPart,
  TextPart,
  ToolPart,
  Part,
  Config as OpenCodeConfig,
} from '@opencode-ai/sdk';
import { handleToolCall } from '../claude/tools';
import { AGENT_DONE, AGENT_ERROR, AGENT_OUTPUT, AGENT_QUEUED, AGENT_TOKEN_USAGE_EVENT, AGENT_USER_MESSAGE } from '../ipc-channels';
import { acquireBridge, type BridgeHandle } from './bridge-server';
import { generateOuterOpencodeConfig } from '../opencode-config';
import { buildProviderEntry } from '../../shared/opencode-providers';
import {
  type AgentBackend,
  type ChatMessage,
  type AuthStatus,
  type AgentSessionHistory,
  type OuterClaudeSessionTokens,
  type StackInfo,
  type EphemeralStreamEvent,
  type EphemeralSessionHandle,
  zeroSessionTokens,
} from './types';
import { appendEphemeralTiming, type EphemeralTimingRecord } from './ephemeral-timing';
import { type ContainerRuntime } from '../runtime/types';
import { cliDir } from '../index';

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface TabSession {
  tabId: string;
  openCodeSessionId: string;
  /** In-flight session creation promise; guards against concurrent create() calls. */
  creatingSession: Promise<string> | null;
  messages: ChatMessage[];
  processing: boolean;
  fullResponse: string;
  projectDir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractEphemeralEvents(parts: Part[]): {
  text: string;
  events: EphemeralStreamEvent[];
} {
  let text = '';
  const events: EphemeralStreamEvent[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      const tp = part as TextPart;
      if (tp.text) {
        text += tp.text;
        events.push({ kind: 'text', delta: tp.text });
      }
    } else if (part.type === 'tool') {
      const tp = part as ToolPart;
      const name = tp.tool;
      const summary = `${name}(...)`;
      events.push({ kind: 'tool_use', name, summary });
    }
  }
  return { text, events };
}

// ---------------------------------------------------------------------------
// Provider routing helper
// ---------------------------------------------------------------------------

/**
 * Derive the { providerID, modelID } pair needed by the SDK session body from
 * an EffectiveBackend.
 *
 * Split rules (mirrors the stored combined-model-string format):
 *   - model contains '/': split on first '/' → providerID = left, modelID = right
 *   - model set but no '/': providerID = effective.provider ?? 'anthropic', modelID = whole string
 *   - model unset: return null → caller omits the `model` field from the body
 */
function splitModel(effective: { provider?: string; model?: string }): { providerID: string; modelID: string } | null {
  if (!effective.model) return null;
  const slashIdx = effective.model.indexOf('/');
  if (slashIdx !== -1) {
    return {
      providerID: effective.model.slice(0, slashIdx),
      modelID: effective.model.slice(slashIdx + 1),
    };
  }
  return {
    providerID: effective.provider ?? 'anthropic',
    modelID: effective.model,
  };
}

// ---------------------------------------------------------------------------
// OpenCodeBackend
// ---------------------------------------------------------------------------

// Minimal interface for the registry methods this class needs. Avoids a
// static import of the full registry module (which would create a circular
// dependency at load time — same reason syncCredentials uses a dynamic import).
interface RegistryRef {
  getGlobalBackendSettings(): { outer_provider: string | null; outer_model: string | null; inner_provider?: string | null; inner_model?: string | null };
  getBackendSecretBundle(key: string, surface: 'inner' | 'outer'): Record<string, string> | null;
  getEffectiveRoutingFor(projectDir: string, touchpoint: string): { backend: string; provider?: string; model?: string };
  getStoredProviderKeys(scope: string): string[];
  getProviderSecretBundle(key: string, provider: string): Record<string, string> | null;
}

export class OpenCodeBackend implements AgentBackend {
  readonly name = 'OpenCode';

  private client: OpencodeClient | null = null;
  private serverUrl: string | null = null;
  private serverClose: (() => void) | null = null;
  private bridge: BridgeHandle | null = null;
  private mainWindow: BrowserWindow | null = null;
  private ephemeralTimingPath: string;
  // Cached registry reference — populated once in initialize() to avoid
  // repeated dynamic imports (and concurrent-import races) in the hot path.
  private registryRef: RegistryRef | null = null;

  // tabId → session state
  private tabSessions = new Map<string, TabSession>();
  // openCodeSessionId → tabId (for persistent sessions)
  private sessionToTab = new Map<string, string>();
  // per-tab cumulative token totals
  private sessionTokens = new Map<string, OuterClaudeSessionTokens>();

  // SSE loop abort controller
  private eventLoopAbort: AbortController | null = null;

  // JSON signature of the provider map last used to start the server.
  // Used to detect when syncCredentials needs to restart the server.
  private serverProviderSignature = '';

  private resolveRuntime?: (stack: StackInfo) => ContainerRuntime;

  constructor(resolveRuntime?: (stack: StackInfo) => ContainerRuntime) {
    this.resolveRuntime = resolveRuntime;
    this.ephemeralTimingPath = this.resolveEphemeralTimingPath();
  }

  private resolveEphemeralTimingPath(): string {
    try {
      const dir = typeof app !== 'undefined' && app.getPath ? app.getPath('userData') : os.tmpdir();
      return path.join(dir, 'sandstorm-desktop-ephemeral-timing.jsonl');
    } catch {
      return path.join(os.tmpdir(), 'sandstorm-desktop-ephemeral-timing.jsonl');
    }
  }

  // --- Lifecycle ---

  async initialize(): Promise<void> {
    // Acquire shared bridge (idempotent, ref-counted with ClaudeBackend)
    this.bridge = await acquireBridge(handleToolCall);

    // Dynamic imports: @opencode-ai/sdk is ESM-only and cannot be require()'d.
    // Vite keeps import() calls as-is in CJS output (same as node-pty pattern),
    // so these resolve correctly at runtime even though the bundle is CJS.
    const { createOpencodeClient } = await import('@opencode-ai/sdk');
    const { createOpencodeServer } = await import('@opencode-ai/sdk/server');

    // Resolve global outer provider/model/bundle from registry.
    // initialize() runs at app startup before any project is selected, so we use
    // global settings. Dynamic import avoids a circular dependency at load time
    // (mirrors the syncCredentials pattern for the inner surface). Cache the
    // reference so hot-path methods (sendMessageAsync etc.) don't re-import.
    const { registry } = await import('../index');
    this.registryRef = registry as RegistryRef;
    const globalSettings = registry.getGlobalBackendSettings();
    const providerId = globalSettings.outer_provider ?? undefined;
    const bundle = registry.getBackendSecretBundle('global', 'outer') ?? undefined;
    const model = globalSettings.outer_model ?? undefined;

    // Shim is compiled alongside this module in dist/main/
    const shimPath = path.join(__dirname, 'orchestration-mcp-shim.cjs');

    // Generate the outer config: registers the bridge shim as an MCP server so
    // OpenCode can call create_stack, dispatch_task, etc. via standard MCP calls.
    const outerConfig = generateOuterOpencodeConfig({
      shimPath,
      bridgeUrl: this.bridge.url,
      bridgeToken: this.bridge.token,
      instructionsPath: path.join(cliDir, 'SANDSTORM_OUTER.md'),
      providerId,
      bundle,
      model,
    });

    // Inject bridge credentials into process env so OpenCode agent bash skill
    // scripts (curl "$SANDSTORM_BRIDGE_URL/tool-call") keep working unchanged.
    process.env.SANDSTORM_BRIDGE_URL = this.bridge.url;
    process.env.SANDSTORM_BRIDGE_TOKEN = this.bridge.token;

    // Build multi-provider config: include every project-scoped provider so the
    // long-lived server can dispatch ephemeral sessions to any configured provider+model
    // without per-call credential injection or server restarts.
    // At initialize() time no project is open yet, so start with empty providers;
    // syncCredentials() will restart the server with the right scopes once stacks load.
    const allProviders = this.buildProviderMapForScopes(registry as RegistryRef, []);
    const sdkConfig: OpenCodeConfig = {
      mcp: outerConfig.mcp as OpenCodeConfig['mcp'],
      // Merge outer provider with all project-scoped providers.
      provider: {
        ...outerConfig.provider as OpenCodeConfig['provider'],
        ...allProviders,
      },
    };
    this.serverProviderSignature = JSON.stringify(allProviders);

    const server = await createOpencodeServer({ hostname: '127.0.0.1', config: sdkConfig });
    this.serverClose = server.close;
    this.serverUrl = server.url;
    this.client = createOpencodeClient({ baseUrl: server.url });

    // Kick off the SSE event loop for persistent-session events
    this.eventLoopAbort = new AbortController();
    void this.startEventLoop(this.eventLoopAbort.signal);
  }

  destroy(): void {
    this.eventLoopAbort?.abort();
    this.eventLoopAbort = null;
    this.serverClose?.();
    this.serverClose = null;
    this.serverUrl = null;
    this.client = null;
    this.bridge?.release();
    this.bridge = null;
    this.registryRef = null;
    this.tabSessions.clear();
    this.sessionToTab.clear();
    this.sessionTokens.clear();
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win;
  }

  /** Returns the URL of the running OpenCode server, or null if not started. */
  getServerUrl(): string | null {
    return this.serverUrl;
  }

  // --- Provider config helpers ---

  /**
   * Build a merged provider map from all project-scoped credentials across
   * the given project scopes. Replaces the old global-scope read so that
   * per-project credentials are properly loaded into the outer server.
   */
  private buildProviderMapForScopes(reg: RegistryRef, projectScopes: string[]): OpenCodeConfig['provider'] {
    const result: OpenCodeConfig['provider'] = {};
    for (const scope of projectScopes) {
      const providerIds = reg.getStoredProviderKeys(scope);
      for (const providerId of providerIds) {
        const bundle = reg.getProviderSecretBundle(scope, providerId) ?? {};
        const { providerKey, config } = buildProviderEntry(providerId, bundle);
        result[providerKey] = config;
      }
    }
    return result;
  }

  // --- SSE event loop (persistent sessions only) ---

  private async startEventLoop(signal: AbortSignal): Promise<void> {
    if (!this.client) return;
    try {
      const { stream } = await this.client.event.subscribe();
      for await (const event of stream) {
        if (signal.aborted) break;
        this.dispatchEvent(event as OpenCodeEvent);
      }
    } catch {
      // Stream closed — server may have shut down
    }
  }

  private dispatchEvent(event: OpenCodeEvent): void {
    switch (event.type) {
      case 'message.part.updated':
        this.handlePartUpdated(event as EventMessagePartUpdated);
        break;
      case 'session.idle':
        this.handleSessionIdle(event as EventSessionIdle);
        break;
      case 'session.error':
        this.handleSessionError(event as EventSessionError);
        break;
      default:
        break;
    }
  }

  private handlePartUpdated(event: EventMessagePartUpdated): void {
    const { part, delta } = event.properties;
    const sessionId = part.sessionID;
    const tabId = this.sessionToTab.get(sessionId);
    if (!tabId) return;

    const tabSession = this.tabSessions.get(tabId);
    if (!tabSession) return;

    if (part.type === 'text' && delta) {
      tabSession.fullResponse += delta;
      this.mainWindow?.webContents.send(AGENT_OUTPUT(tabId), delta);
    } else if (part.type === 'tool') {
      const toolPart = part as ToolPart;
      const summary = `\n[tool: ${toolPart.tool}]\n`;
      tabSession.fullResponse += summary;
      this.mainWindow?.webContents.send(AGENT_OUTPUT(tabId), summary);
    } else if (part.type === 'step-finish') {
      this.accumulateTokens(tabId, part as StepFinishPart);
    }
  }

  private handleSessionIdle(event: EventSessionIdle): void {
    const sessionId = event.properties.sessionID;
    const tabId = this.sessionToTab.get(sessionId);
    if (!tabId) return;

    const tabSession = this.tabSessions.get(tabId);
    if (!tabSession) return;

    if (tabSession.fullResponse) {
      tabSession.messages.push({ role: 'assistant', content: tabSession.fullResponse });
    }
    tabSession.fullResponse = '';
    tabSession.processing = false;
    this.mainWindow?.webContents.send(AGENT_DONE(tabId));
  }

  private handleSessionError(event: EventSessionError): void {
    const sessionId = event.properties.sessionID;
    if (!sessionId) return;

    const tabId = this.sessionToTab.get(sessionId);
    if (!tabId) return;

    const tabSession = this.tabSessions.get(tabId);
    if (tabSession) tabSession.processing = false;

    const errorMsg = this.formatSessionError(event);
    this.mainWindow?.webContents.send(AGENT_ERROR(tabId), errorMsg);
  }

  private formatSessionError(event: EventSessionError): string {
    const err = event.properties.error;
    if (!err) return 'OpenCode session error';
    if ('message' in err && typeof (err as { message?: string }).message === 'string') {
      return (err as { message: string }).message;
    }
    return JSON.stringify(err);
  }

  private accumulateTokens(tabId: string, stepPart: StepFinishPart): void {
    const { tokens } = stepPart;
    const prev = this.sessionTokens.get(tabId) ?? zeroSessionTokens();
    const next: OuterClaudeSessionTokens = {
      input_tokens: prev.input_tokens + tokens.input,
      output_tokens: prev.output_tokens + tokens.output,
      cache_creation_input_tokens: prev.cache_creation_input_tokens + tokens.cache.write,
      cache_read_input_tokens: prev.cache_read_input_tokens + tokens.cache.read,
    };
    this.sessionTokens.set(tabId, next);
    this.mainWindow?.webContents.send(AGENT_TOKEN_USAGE_EVENT(tabId), next);
  }

  // --- Session management ---

  sendMessage(tabId: string, message: string, projectDir?: string): void {
    let tabSession = this.tabSessions.get(tabId);
    if (!tabSession) {
      tabSession = {
        tabId,
        openCodeSessionId: '',
        creatingSession: null,
        messages: [],
        processing: false,
        fullResponse: '',
        projectDir,
      };
      this.tabSessions.set(tabId, tabSession);
    }
    if (projectDir) tabSession.projectDir = projectDir;

    tabSession.messages.push({ role: 'user', content: message });

    if (tabSession.processing) {
      this.mainWindow?.webContents.send(AGENT_QUEUED(tabId));
    }

    tabSession.processing = true;
    this.mainWindow?.webContents.send(AGENT_USER_MESSAGE(tabId), message);

    if (!this.client) {
      tabSession.processing = false;
      this.mainWindow?.webContents.send(AGENT_ERROR(tabId), 'Backend not initialized');
      return;
    }
    void this.sendMessageAsync(tabSession, message);
  }

  private async sendMessageAsync(tabSession: TabSession, message: string): Promise<void> {
    if (!this.client) return;
    const { tabId, projectDir } = tabSession;

    try {
      // Create session on first message, guarding against concurrent creation.
      // If two sendMessage calls arrive before session.create() resolves, the
      // second awaits the first's in-flight promise instead of launching a second.
      if (!tabSession.openCodeSessionId) {
        if (!tabSession.creatingSession) {
          tabSession.creatingSession = this.client.session
            .create({ query: projectDir ? { directory: projectDir } : undefined })
            .then(({ data: session }) => {
              if (!session) throw new Error('Failed to create OpenCode session');
              tabSession.openCodeSessionId = session.id;
              this.sessionToTab.set(session.id, tabId);
              return session.id;
            })
            .finally(() => {
              tabSession.creatingSession = null;
            });
        }
        await tabSession.creatingSession;
      }

      tabSession.fullResponse = '';

      // Resolve per-session model routing from the project's effective backend config.
      const modelParts = (projectDir && this.registryRef)
        ? splitModel(this.registryRef.getEffectiveRoutingFor(projectDir, 'outer'))
        : null;

      // Send prompt; completion arrives via SSE events
      await this.client.session.promptAsync({
        path: { id: tabSession.openCodeSessionId },
        query: projectDir ? { directory: projectDir } : undefined,
        body: {
          parts: [{ type: 'text', text: message }],
          ...(modelParts ? { model: modelParts } : {}),
        },
      });
    } catch (err) {
      tabSession.processing = false;
      const msg = err instanceof Error ? err.message : String(err);
      this.mainWindow?.webContents.send(AGENT_ERROR(tabId), msg);
    }
  }

  getHistory(tabId: string): AgentSessionHistory {
    const tabSession = this.tabSessions.get(tabId);
    if (!tabSession) return { messages: [], processing: false };
    return { messages: [...tabSession.messages], processing: tabSession.processing };
  }

  cancelSession(tabId: string): void {
    const tabSession = this.tabSessions.get(tabId);
    if (!tabSession || !this.client) return;
    if (tabSession.openCodeSessionId && tabSession.processing) {
      tabSession.processing = false;
      this.mainWindow?.webContents.send(AGENT_DONE(tabId));
      void this.client.session
        .abort({ path: { id: tabSession.openCodeSessionId } })
        .catch(() => {});
    }
  }

  resetSession(tabId: string): void {
    const tabSession = this.tabSessions.get(tabId);
    if (tabSession?.openCodeSessionId) {
      this.sessionToTab.delete(tabSession.openCodeSessionId);
      void this.deleteOpenCodeSession(tabSession.openCodeSessionId);
    }
    this.tabSessions.delete(tabId);
    this.sessionTokens.delete(tabId);
    // Push zero tokens so the UI counter resets immediately
    this.mainWindow?.webContents.send(AGENT_TOKEN_USAGE_EVENT(tabId), zeroSessionTokens());
  }

  getSessionTokens(tabId: string): OuterClaudeSessionTokens {
    return this.sessionTokens.get(tabId) ?? zeroSessionTokens();
  }

  private async deleteOpenCodeSession(sessionId: string): Promise<void> {
    if (!this.client || !sessionId) return;
    try {
      await this.client.session.delete({ path: { id: sessionId } });
    } catch {
      // Best effort
    }
  }

  // --- Ephemeral agents ---

  getEphemeralTimingPath(): string {
    return this.ephemeralTimingPath;
  }

  spawnEphemeralAgent(
    prompt: string,
    projectDir: string,
    timeoutMs = 300_000,
    onChunk?: (event: EphemeralStreamEvent) => void,
    attribution?: { ticketId?: string; stage?: string },
    model?: string,
    _touchpoint?: string,
  ): { promise: Promise<string>; cancel: () => void } {
    if (!this.client) {
      return { promise: Promise.resolve(''), cancel: () => {} };
    }

    const spawnedAt = Date.now();
    let cancelled = false;
    const abortCtrl = new AbortController();

    const runEphemeral = async (): Promise<string> => {
      const { data: session } = await this.client!.session.create({
        query: { directory: projectDir },
      });
      if (!session) throw new Error('Failed to create ephemeral session');

      try {
        // When a model string is provided (as "providerID/modelID" or plain "modelID"),
        // use it directly — the caller (BackendRouter) has already resolved the correct
        // touchpoint descriptor. Otherwise fall back to the outer model from registry.
        const modelParts = model
          ? splitModel({ model })
          : (this.registryRef ? splitModel(this.registryRef.getEffectiveRoutingFor(projectDir, 'outer')) : null);

        const { data: response } = await this.client!.session.prompt({
          path: { id: session.id },
          query: { directory: projectDir },
          body: {
            parts: [{ type: 'text', text: prompt }],
            ...(modelParts ? { model: modelParts } : {}),
          },
          signal: abortCtrl.signal,
        });

        const parts: Part[] = response?.parts ?? [];
        const { text, events } = extractEphemeralEvents(parts);
        if (onChunk) {
          for (const ev of events) onChunk(ev);
        }
        return text;
      } finally {
        void this.deleteOpenCodeSession(session.id);
      }
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const cancelFn = (): void => {
      cancelled = true;
      abortCtrl.abort();
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    const withTimeout = (): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        if (timeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            cancelFn();
            reject(new Error(`Ephemeral agent timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }
        runEphemeral()
          .then((text) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (cancelled) {
              reject(new Error('Ephemeral agent cancelled'));
              return;
            }
            const closedAt = Date.now();
            const record: EphemeralTimingRecord = {
              ts: new Date(closedAt).toISOString(),
              spawnedAt,
              firstChunkAt: null,
              closedAt,
              elapsedMs: closedAt - spawnedAt,
              exitCode: 0,
              promptChars: prompt.length,
              turnCount: 1,
              tokens: 0,
              cancelled,
              ...(attribution?.ticketId != null ? { ticketId: attribution.ticketId } : {}),
              ...(attribution?.stage != null ? { stage: attribution.stage } : {}),
            };
            appendEphemeralTiming(this.ephemeralTimingPath, record);
            resolve(text);
          })
          .catch((err) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });

    return { promise: withTimeout(), cancel: cancelFn };
  }

  runEphemeralAgent(
    prompt: string,
    projectDir: string,
    timeoutMs = 300_000,
    attribution?: { ticketId?: string; stage?: string },
    model?: string,
    _touchpoint?: string,
  ): Promise<string> {
    return this.spawnEphemeralAgent(prompt, projectDir, timeoutMs, undefined, attribution, model)
      .promise;
  }

  spawnEphemeralSession(
    initialPrompt: string,
    projectDir: string,
    timeoutMs = 300_000,
    onChunk?: (event: EphemeralStreamEvent) => void,
  ): EphemeralSessionHandle {
    if (!this.client) {
      return {
        initialResult: Promise.resolve(''),
        sendFollowUp: () => Promise.resolve(''),
        dispose: () => {},
      };
    }

    let openCodeSessionId = '';
    let isDisposed = false;
    let initAbortCtrl = new AbortController();
    // Resolved once in initialResult and reused for all subsequent sendTurn calls.
    let resolvedModelParts: { providerID: string; modelID: string } | null = null;

    const sendTurn = async (text: string, signal: AbortSignal): Promise<string> => {
      if (isDisposed) throw new Error('Session disposed');
      const { data: response } = await this.client!.session.prompt({
        path: { id: openCodeSessionId },
        query: { directory: projectDir },
        body: {
          parts: [{ type: 'text', text }],
          ...(resolvedModelParts ? { model: resolvedModelParts } : {}),
        },
        signal,
      });
      const parts: Part[] = response?.parts ?? [];
      const { text: resultText, events } = extractEphemeralEvents(parts);
      if (onChunk) {
        for (const ev of events) onChunk(ev);
      }
      return resultText;
    };

    const dispose = (): void => {
      if (isDisposed) return;
      isDisposed = true;
      initAbortCtrl.abort();
      if (openCodeSessionId) {
        void this.deleteOpenCodeSession(openCodeSessionId);
      }
    };

    const initialResult = (async (): Promise<string> => {
      if (!this.client) throw new Error('OpenCodeBackend not initialized');

      // Resolve model once for the session lifetime from effective backend config.
      resolvedModelParts = this.registryRef
        ? splitModel(this.registryRef.getEffectiveRoutingFor(projectDir, 'outer'))
        : null;

      const { data: session } = await this.client.session.create({
        query: { directory: projectDir },
      });
      if (!session) throw new Error('Failed to create ephemeral session');
      if (isDisposed) {
        void this.deleteOpenCodeSession(session.id);
        throw new Error('Session disposed');
      }
      openCodeSessionId = session.id;
      return sendTurn(initialPrompt, initAbortCtrl.signal);
    })();

    return {
      initialResult,
      sendFollowUp: (followUp: string) => {
        const ctrl = new AbortController();
        if (isDisposed) return Promise.reject(new Error('Session disposed'));
        return sendTurn(followUp, ctrl.signal);
      },
      dispose,
    };
  }

  // --- Auth ---

  async getAuthStatus(): Promise<AuthStatus> {
    return { loggedIn: false, expired: false };
  }

  async login(_mainWindow?: BrowserWindow): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'OpenCode auth not yet implemented (#479)' };
  }

  async syncCredentials(stacks: StackInfo[]): Promise<void> {
    // Dynamic import to avoid a circular dependency at load time.
    const { registry } = await import('../index');

    // --- Host-side: keep OpenCode server's provider map current ---
    // If new providers have been configured since initialize(), restart the server so
    // ephemeral sessions can use any provider without credential injection per call.
    // Collect project scopes from all known stacks so per-project credentials are included.
    if (this.client && this.registryRef) {
      const projectScopes = [...new Set(
        stacks
          .filter((s) => s.project_dir)
          .map((s) => `project:${path.resolve(s.project_dir!)}`)
      )];
      const newProviderMap = this.buildProviderMapForScopes(this.registryRef, projectScopes);
      const newSignature = JSON.stringify(newProviderMap);
      if (newSignature !== this.serverProviderSignature) {
        // Restart the host OpenCode server with the updated provider set.
        this.eventLoopAbort?.abort();
        this.serverClose?.();

        const { createOpencodeClient } = await import('@opencode-ai/sdk');
        const { createOpencodeServer } = await import('@opencode-ai/sdk/server');
        const globalSettings = registry.getGlobalBackendSettings();
        const providerId = globalSettings.outer_provider ?? undefined;
        const bundle = registry.getBackendSecretBundle('global', 'outer') ?? undefined;
        const model = globalSettings.outer_model ?? undefined;
        const shimPath = path.join(__dirname, 'orchestration-mcp-shim.cjs');
        if (this.bridge) {
          const outerConfig = generateOuterOpencodeConfig({
            shimPath,
            bridgeUrl: this.bridge.url,
            bridgeToken: this.bridge.token,
            instructionsPath: path.join(cliDir, 'SANDSTORM_OUTER.md'),
            providerId,
            bundle,
            model,
          });
          const sdkConfig: OpenCodeConfig = {
            mcp: outerConfig.mcp as OpenCodeConfig['mcp'],
            provider: {
              ...outerConfig.provider as OpenCodeConfig['provider'],
              ...newProviderMap,
            },
          };
          const server = await createOpencodeServer({ hostname: '127.0.0.1', config: sdkConfig });
          this.serverClose = server.close;
          this.serverUrl = server.url;
          this.client = createOpencodeClient({ baseUrl: server.url });
          this.serverProviderSignature = newSignature;
          this.eventLoopAbort = new AbortController();
          void this.startEventLoop(this.eventLoopAbort.signal);
        }
      }
    }


    for (const stack of stacks) {
      if (stack.status !== 'running' && stack.status !== 'up') continue;
      const claudeService = stack.services?.find((s) => s.name === 'claude');
      if (!claudeService?.containerId) continue;

      try {
        // 1. Clean auth.json so env-based credentials always take precedence.
        //    Prevents an OAuth token cached in auth.json from overriding the
        //    configured env credentials (the OAuth-overrides-config trap).
        await this.execInContainer(claudeService.containerId, [
          'bash', '-c',
          'rm -f ~/.local/share/opencode/auth.json && mkdir -p ~/.local/share/opencode',
        ], undefined, this.resolveRuntime?.(stack));

        // 2. Collect distinct opencode providers across all container phases.
        //    For each provider, store its credentials bundle and one representative model.
        const providerMap = new Map<string, { credentials: Record<string, string> | null; model: string }>();
        if (stack.project_dir) {
          for (const touchpoint of ['execution', 'review', 'meta_review'] as const) {
            const desc = registry.getEffectiveTouchpointDescriptor(stack.project_dir, touchpoint);
            if (desc.backend === 'opencode' && !providerMap.has(desc.provider)) {
              providerMap.set(desc.provider, { credentials: desc.credentials, model: desc.model });
            }
          }
        }

        // 3. Write one config file per distinct provider that has credentials.
        //    Providers without credentials are skipped; their absence signals needs_key
        //    to the task runner.
        const { generateOpencodeConfig } = await import('../opencode-config');
        for (const [providerId, { credentials, model }] of providerMap) {
          if (!credentials) continue;
          const config = generateOpencodeConfig({ providerId, bundle: credentials, model: model || undefined });
          const configJson = JSON.stringify(config, null, 2);
          await this.execInContainer(claudeService.containerId, [
            'bash', '-c', 'cat > "$1"', '--', `/tmp/sandstorm-opencode-${providerId}.json`,
          ], configJson, this.resolveRuntime?.(stack));
        }
      } catch {
        // Best effort per container
      }
    }
  }

  private async execInContainer(
    containerId: string,
    cmd: string[],
    input?: string,
    runtime?: ContainerRuntime
  ): Promise<void> {
    if (!runtime) throw new Error('execInContainer requires a ContainerRuntime');
    await runtime.exec(containerId, cmd, { user: 'claude', input });
  }
}
