/**
 * agentStreamService — persistent IPC listener registry for outer Claude streaming.
 *
 * The problem this solves: AgentSession registers IPC listeners in a useEffect, which
 * tears them down when the component unmounts (e.g. when the user switches project tabs).
 * Streaming events that arrive while the component is unmounted are silently dropped,
 * causing in-progress messages to disappear on navigation.
 *
 * Fix: register listeners once per tabId (never unregistered) and write all streaming
 * state into the Zustand store. The component reads from the store, so it picks up the
 * accumulated state immediately on remount regardless of when the events arrived.
 */

import { useAppStore, OuterClaudeSessionTokens } from './store';
import { AGENT_DONE, AGENT_ERROR, AGENT_OUTPUT, AGENT_QUEUED, AGENT_TOKEN_USAGE_EVENT, AGENT_USER_MESSAGE } from '../main/ipc-channels';

const registeredTabs = new Set<string>();

export function registerAgentStreamListeners(tabId: string): void {
  if (registeredTabs.has(tabId)) return;
  registeredTabs.add(tabId);

  window.sandstorm.on(AGENT_QUEUED(tabId), () => {
    useAppStore.getState().updateAgentSession(tabId, { isQueued: true });
  });

  window.sandstorm.on(AGENT_OUTPUT(tabId), (data: unknown) => {
    const current = useAppStore.getState().agentSessions[tabId];
    useAppStore.getState().updateAgentSession(tabId, {
      isQueued: false,
      streamingContent: (current?.streamingContent ?? '') + (data as string),
    });
  });

  window.sandstorm.on(AGENT_DONE(tabId), () => {
    useAppStore.getState().updateAgentSession(tabId, {
      isQueued: false,
      isLoading: false,
      streamingContent: '',
    });
    // Re-fetch authoritative history from backend (handles queued messages too).
    window.sandstorm.agent.history(tabId).then((result) => {
      const messages = result.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
      useAppStore.getState().updateAgentSession(tabId, {
        messages,
        isLoading: result.processing,
      });
    });
  });

  window.sandstorm.on(AGENT_ERROR(tabId), (error: unknown) => {
    const current = useAppStore.getState().agentSessions[tabId];
    const partial = current?.streamingContent ?? '';
    const errorMsg = (partial ? partial + '\n\n' : '') + 'Error: ' + (error as string);
    useAppStore.getState().updateAgentSession(tabId, {
      isQueued: false,
      isLoading: false,
      streamingContent: '',
      messages: [
        ...(current?.messages ?? []),
        { role: 'assistant', content: errorMsg.trim() },
      ],
    });
  });

  window.sandstorm.on(AGENT_TOKEN_USAGE_EVENT(tabId), (tokens: unknown) => {
    useAppStore.getState().setOuterClaudeTokens(tabId, tokens as OuterClaudeSessionTokens);
  });

  window.sandstorm.on(AGENT_USER_MESSAGE(tabId), (message: unknown) => {
    const current = useAppStore.getState().agentSessions[tabId];
    const msgs = current?.messages ?? [];
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user' && last.content === (message as string)) {
      // Deduplicate: already added optimistically by sendMessage
      useAppStore.getState().updateAgentSession(tabId, { isLoading: true });
    } else {
      useAppStore.getState().updateAgentSession(tabId, {
        messages: [...msgs, { role: 'user', content: message as string }],
        isLoading: true,
      });
    }
  });
}

/** Reset registered tab tracking — for test isolation only. */
export function _resetForTesting(): void {
  registeredTabs.clear();
}
