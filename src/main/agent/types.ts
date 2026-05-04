/**
 * AgentBackend interface — abstracts the AI agent used for orchestration.
 * Currently implemented by ClaudeBackend; designed to be swappable for
 * other LLMs/tools (Codex, Gemini, raw API, etc.) in the future.
 */

import { BrowserWindow } from 'electron';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  expired: boolean;
  expiresAt?: number;
}

export interface AgentSessionHistory {
  messages: ChatMessage[];
  processing: boolean;
}

/**
 * Token usage totals for the current orchestrator session.
 * Reset to zero when the session is reset (e.g. via "New Session").
 * Cache reads/writes are included honestly — they can be non-zero on turn 1
 * if prompt caching hits an existing cached prefix.
 */
export interface OuterClaudeSessionTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function zeroSessionTokens(): OuterClaudeSessionTokens {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

export interface StackServiceInfo {
  name: string;
  status: string;
  containerId: string;
}

export interface StackInfo {
  status: string;
  services?: StackServiceInfo[];
}

export interface AgentBackend {
  /** Human-readable name of the agent backend (e.g., "Claude") */
  readonly name: string;

  /** One-time initialization (start bridges, write configs, etc.) */
  initialize(): Promise<void>;

  /** Tear down all sessions and release resources */
  destroy(): void;

  /** Set the main window for sending IPC events to the renderer */
  setMainWindow(win: BrowserWindow | null): void;

  // --- Session management ---

  /** Send a message to the agent session for a given tab */
  sendMessage(tabId: string, message: string, projectDir?: string): void;

  /** Get conversation history and processing state for a tab */
  getHistory(tabId: string): AgentSessionHistory;

  /** Cancel the currently running agent process for a tab */
  cancelSession(tabId: string): void;

  /** Reset (delete) the session for a tab */
  resetSession(tabId: string): void;

  /** Get the current orchestrator session token totals for a tab */
  getSessionTokens(tabId: string): OuterClaudeSessionTokens;

  // --- Ephemeral agents ---

  /** Spawn a one-shot agent process that evaluates a prompt and returns the text result */
  runEphemeralAgent(prompt: string, projectDir: string, timeoutMs?: number): Promise<string>;

  /** Spawn a cancellable one-shot agent process; returns a promise and a cancel function */
  spawnEphemeralAgent(
    prompt: string,
    projectDir: string,
    timeoutMs?: number
  ): { promise: Promise<string>; cancel: () => void };

  // --- Authentication ---

  /** Check the current authentication status */
  getAuthStatus(): Promise<AuthStatus>;

  /** Initiate an interactive login flow */
  login(mainWindow?: BrowserWindow): Promise<{ success: boolean; error?: string }>;

  /** Sync credentials to running stack containers */
  syncCredentials(stacks: StackInfo[]): Promise<void>;

}
