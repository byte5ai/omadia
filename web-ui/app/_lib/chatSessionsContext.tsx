'use client';

import { createContext, useContext } from 'react';

import { useChatSessions, type UseChatSessionsResult } from './chatSessions';

/**
 * Lifts the chat-sessions state (sessions, activeId, mutateActive, …) to
 * a layout-level provider. Without this, the state lived inside
 * `<ChatPage>` and was destroyed whenever the user navigated away — taking
 * any in-flight stream's `mutateActive` closure down with it. With this,
 * the provider is mounted in `RootLayout`, so `<StreamRunner>` (also in
 * the layout) keeps writing message deltas into the same store regardless
 * of which page is currently rendered.
 */

const ChatSessionsCtx = createContext<UseChatSessionsResult | null>(null);

export function ChatSessionsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const value = useChatSessions();
  return (
    <ChatSessionsCtx.Provider value={value}>{children}</ChatSessionsCtx.Provider>
  );
}

/**
 * Read the chat-sessions state from context. Throws if used outside the
 * provider — every consumer in `web-ui/` lives under `RootLayout`, so this
 * fires only on misconfigured tests.
 */
export function useChatSessionsCtx(): UseChatSessionsResult {
  const v = useContext(ChatSessionsCtx);
  if (!v) {
    throw new Error(
      'useChatSessionsCtx: missing <ChatSessionsProvider> — mount it in layout.tsx.',
    );
  }
  return v;
}
