// #2043 — how many messages went out to a conversation as an agent's own
// identity. The facilitator wrapper compares the number before and after a
// turn the channel started: when the engine posted in between (the handshake
// that opens a facilitation), the turn's own answer is dropped instead of
// being posted next to it. A counter, never a log of what was said.

export interface OwnIdentityPostLog {
  record(agentSlug: string, channelType: string, conversationId: string): void;
  count(agentSlug: string, channelType: string, conversationId: string): number;
}

const keyOf = (agentSlug: string, channelType: string, conversationId: string): string =>
  JSON.stringify([agentSlug, channelType, conversationId]);

export function createOwnIdentityPostLog(): OwnIdentityPostLog {
  const counts = new Map<string, number>();
  return {
    record(agentSlug, channelType, conversationId) {
      const key = keyOf(agentSlug, channelType, conversationId);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    count: (agentSlug, channelType, conversationId) =>
      counts.get(keyOf(agentSlug, channelType, conversationId)) ?? 0,
  };
}
