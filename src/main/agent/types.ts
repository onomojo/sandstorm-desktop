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

  // --- Authentication ---

  /** Check the current authentication status */
  getAuthStatus(): Promise<AuthStatus>;

  /** Initiate an interactive login flow */
  login(mainWindow?: BrowserWindow): Promise<{ success: boolean; error?: string }>;

  /** Sync credentials to running stack containers */
  syncCredentials(stacks: StackInfo[]): Promise<void>;
}
