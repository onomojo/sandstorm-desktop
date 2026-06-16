/**
 * BackendRouter — routes AgentBackend calls to a concrete backend per tab/project.
 *
 * The outer Claude session is a singleton with per-tabId sessions. BackendRouter
 * sits in front of the concrete backends (ClaudeBackend, OpenCodeBackend, …) and
 * multiplexes method calls based on which backend owns each tab.
 *
 * Routing rules:
 *  - sendMessage with projectDir: call selector(projectDir) → record tabId ownership.
 *  - sendMessage without projectDir: look up existing ownership; default to 'claude'.
 *  - Ownership is sticky until resetSession(tabId), which clears it. A backend
 *    change for a project applies on the next new/reset session — intentional.
 *  - getHistory/cancelSession/resetSession/getSessionTokens: look up owner;
 *    unknown tab → default to 'claude' (back-compat).
 *  - getAuthStatus/login: route to lastProjectBackendId (most-recently resolved
 *    by any sendMessage or ephemeral call); fall back to 'claude'.
 *  - getEphemeralTimingPath: delegates to claude; OpenCode shares the same timing file via OpenCodeBackend.getEphemeralTimingPath().
 *  - syncCredentials/initialize/destroy/setMainWindow: fan out to all instantiated
 *    backends.
 *  - Ephemeral calls (run/spawn/spawnSession): call selector(projectDir) → delegate.
 */

import type { BrowserWindow } from 'electron';
import type {
  AgentBackend,
  AgentSessionHistory,
  AuthStatus,
  EphemeralSessionHandle,
  EphemeralStreamEvent,
  OuterClaudeSessionTokens,
  StackInfo,
} from './types';
import type { BackendType } from '../control-plane/backend-resolution';

export class BackendRouter implements AgentBackend {
  private readonly factories: Partial<Record<BackendType, () => AgentBackend>>;
  private readonly selector: (projectDir: string) => BackendType;
  private readonly instances: Partial<Record<BackendType, AgentBackend>> = {};

  // tabId → backend type. Sticky until resetSession clears it.
  private readonly tabOwnership = new Map<string, BackendType>();

  // Last backend type resolved by any sendMessage or ephemeral call.
  // Routes auth calls (getAuthStatus/login) to the relevant backend.
  // Falls back to 'claude' before any call has been made.
  private lastProjectBackendId: BackendType = 'claude';

  // Stored so newly-instantiated backends receive the current window reference.
  private mainWindow: BrowserWindow | null = null;

  // Set to true after initialize() completes. Ensures lazily-created backends
  // are initialized immediately on first use rather than left un-initialized.
  private _initialized = false;

  // Per-type init promise stored when a backend is created post-initialize().
  // Callers can await this to ensure the backend is ready before use.
  private readonly _initPromises: Partial<Record<BackendType, Promise<void>>> = {};

  readonly name = 'BackendRouter';

  constructor(
    factories: Partial<Record<BackendType, () => AgentBackend>>,
    selector: (projectDir: string) => BackendType,
  ) {
    this.factories = factories;
    this.selector = selector;
  }

  /**
   * Return the cached concrete backend for `type`, creating it on first call.
   * Does NOT call initialize() — that is the caller's responsibility.
   * Throws if no factory is registered for the requested type.
   */
  private getBackend(type: BackendType): AgentBackend {
    if (!this.instances[type]) {
      const factory = this.factories[type];
      if (!factory) {
        throw new Error(`BackendRouter: no factory registered for backend type '${type}'`);
      }
      const backend = factory();
      if (this.mainWindow !== null) {
        backend.setMainWindow(this.mainWindow);
      }
      this.instances[type] = backend;
      if (this._initialized) {
        // Router already initialized — kick off initialization for this lazily-created
        // backend. Store the promise so callers can await readiness if needed.
        this._initPromises[type] = backend.initialize();
      }
    }
    return this.instances[type]!;
  }

  /**
   * Resolve which backend owns a tab, recording the mapping when projectDir
   * is provided. Defaults to 'claude' if the tab has no prior ownership.
   */
  private resolveTabOwner(tabId: string, projectDir?: string): BackendType {
    if (projectDir) {
      const type = this.selector(projectDir);
      this.tabOwnership.set(tabId, type);
      this.lastProjectBackendId = type;
      return type;
    }
    const existing = this.tabOwnership.get(tabId);
    if (existing) return existing;
    // No projectDir and no prior ownership (e.g. outer-claude tab without project):
    // default to claude and record it.
    this.tabOwnership.set(tabId, 'claude');
    return 'claude';
  }

  // --- Lifecycle (fan out to all instantiated backends) ---

  async initialize(): Promise<void> {
    // Eagerly instantiate the claude backend so it is ready before any user
    // interaction. Other backends are created on first use.
    this.getBackend('claude');
    await Promise.all(
      (Object.values(this.instances) as AgentBackend[]).map(b => b.initialize()),
    );
    // Set after all current instances are initialized so that getBackend() can
    // distinguish "during initialize()" from "after initialize() completed" and
    // avoid double-initializing backends that were created during this call.
    this._initialized = true;
  }

  destroy(): void {
    for (const backend of Object.values(this.instances) as AgentBackend[]) {
      backend.destroy();
    }
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win;
    for (const backend of Object.values(this.instances) as AgentBackend[]) {
      backend.setMainWindow(win);
    }
  }

  // --- Session management ---

  sendMessage(tabId: string, message: string, projectDir?: string): void {
    const type = this.resolveTabOwner(tabId, projectDir);
    this.getBackend(type).sendMessage(tabId, message, projectDir);
  }

  getHistory(tabId: string): AgentSessionHistory {
    const type = this.tabOwnership.get(tabId) ?? 'claude';
    return this.getBackend(type).getHistory(tabId);
  }

  cancelSession(tabId: string): void {
    const type = this.tabOwnership.get(tabId) ?? 'claude';
    this.getBackend(type).cancelSession(tabId);
  }

  resetSession(tabId: string): void {
    const type = this.tabOwnership.get(tabId) ?? 'claude';
    this.getBackend(type).resetSession(tabId);
    // Clear ownership so the next sendMessage can re-establish the backend.
    // A backend change for a project takes effect on the next new/reset session.
    this.tabOwnership.delete(tabId);
  }

  getSessionTokens(tabId: string): OuterClaudeSessionTokens {
    const type = this.tabOwnership.get(tabId) ?? 'claude';
    return this.getBackend(type).getSessionTokens(tabId);
  }

  // --- Ephemeral agents ---

  getEphemeralTimingPath(): string {
    // Delegates to claude for the shared timing file. OpenCode ephemeral timing
    // goes to the same file via OpenCodeBackend.getEphemeralTimingPath().
    return this.getBackend('claude').getEphemeralTimingPath();
  }

  runEphemeralAgent(
    prompt: string,
    projectDir: string,
    timeoutMs?: number,
    attribution?: { ticketId?: string; stage?: string },
    model?: string,
  ): Promise<string> {
    const type = this.selector(projectDir);
    this.lastProjectBackendId = type;
    return this.getBackend(type).runEphemeralAgent(prompt, projectDir, timeoutMs, attribution, model);
  }

  spawnEphemeralAgent(
    prompt: string,
    projectDir: string,
    timeoutMs?: number,
    onChunk?: (event: EphemeralStreamEvent) => void,
    attribution?: { ticketId?: string; stage?: string },
    model?: string,
  ): { promise: Promise<string>; cancel: () => void } {
    const type = this.selector(projectDir);
    this.lastProjectBackendId = type;
    return this.getBackend(type).spawnEphemeralAgent(prompt, projectDir, timeoutMs, onChunk, attribution, model);
  }

  spawnEphemeralSession(
    initialPrompt: string,
    projectDir: string,
    timeoutMs?: number,
    onChunk?: (event: EphemeralStreamEvent) => void,
  ): EphemeralSessionHandle {
    const type = this.selector(projectDir);
    this.lastProjectBackendId = type;
    return this.getBackend(type).spawnEphemeralSession(initialPrompt, projectDir, timeoutMs, onChunk);
  }

  // --- Authentication ---

  getAuthStatus(): Promise<AuthStatus> {
    // Route to the most recently resolved backend; fall back to claude.
    // Auth is backend-specific — the last used backend is the best proxy for
    // which credentials the user cares about right now.
    return this.getBackend(this.lastProjectBackendId).getAuthStatus();
  }

  login(mainWindow?: BrowserWindow): Promise<{ success: boolean; error?: string }> {
    return this.getBackend(this.lastProjectBackendId).login(mainWindow);
  }

  syncCredentials(stacks: StackInfo[]): Promise<void> {
    return Promise.all(
      (Object.values(this.instances) as AgentBackend[]).map(b => b.syncCredentials(stacks)),
    ).then(() => undefined);
  }
}
