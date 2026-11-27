import type {
  ChatAgent,
  ChatStreamEvent,
  ChatStreamObserver,
  ChatTurnInput,
  SemanticAnswer,
} from '@omadia/channel-sdk';

/**
 * #2316 (ADR-0279) — the conversation's data block for a session scope (today:
 * the recent routine deliveries into a channel chat), or undefined.
 */
export type ConversationContextLookup = (sessionScope: string, agentSlug: string) => Promise<string | undefined>;

/**
 * Fills `ChatTurnInput.conversationContextHint` from the kernel's lookup when
 * the caller set none — so a Teams, Telegram, Slack, Discord or WhatsApp turn
 * sees what routines delivered into that chat, like the web chat (ADR 0244),
 * without any channel plugin passing it. Sits outside the fast path: the field
 * is no pass-through reason there (ADR-0278), and a turn it hands on keeps it.
 * A lookup that fails costs the block, never the turn.
 */
export function wrapChatAgentWithConversationContext(
  inner: ChatAgent,
  agentSlug: string,
  lookup: ConversationContextLookup,
  log: (message: string) => void = (m) => console.warn(m),
): ChatAgent & { readonly inner: ChatAgent } {
  const enrich = async (input: ChatTurnInput): Promise<ChatTurnInput> => {
    const scope = input.sessionScope;
    if (input.conversationContextHint !== undefined || scope === undefined || scope.trim() === '') return input;
    try {
      const hint = await lookup(scope, agentSlug);
      return hint ? { ...input, conversationContextHint: hint } : input;
    } catch (err) {
      log(`[conversation-context] lookup failed, turn runs without it: ${err instanceof Error ? err.message : String(err)}`);
      return input;
    }
  };
  return {
    // Kept reachable for introspection, like the fast-path wrapper's.
    inner,
    async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
      return inner.chat(await enrich(input));
    },
    async *chatStream(input: ChatTurnInput, observer?: ChatStreamObserver): AsyncGenerator<ChatStreamEvent> {
      yield* inner.chatStream(await enrich(input), observer);
    },
    ...(inner.holdsContentUntilVerdict !== undefined
      ? { holdsContentUntilVerdict: inner.holdsContentUntilVerdict }
      : {}),
    ...(inner.offeredToolNames ? { offeredToolNames: () => inner.offeredToolNames!() } : {}),
    ...(inner.offeredToolDefinitions ? { offeredToolDefinitions: () => inner.offeredToolDefinitions!() } : {}),
  };
}
