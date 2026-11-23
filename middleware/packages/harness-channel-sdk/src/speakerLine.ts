/**
 * The plain name line (spec 2042 INV-4, §5.14, ADR-0013).
 *
 * The speaker is always in the structured answer. People see it the natural
 * way: through the agent's own bot or account, or the name and avatar a chat
 * UI shows anyway. A text name line appears only where the speaker would
 * otherwise be unclear: in a channel WITHOUT per-agent identity, in a
 * conversation where more than one agent speaks, or on the first answer after
 * the speaker changed. Never on every message of a one-agent conversation.
 */

import type { Speaker } from '@omadia/plugin-api';

/** What a channel knows about the conversation when it renders one answer. */
export interface SpeakerLineContext {
  /** The channel shows one identity per agent (own bot / account). Then never. */
  readonly nativeIdentity: boolean;
  /** Agents that spoke in this conversation before, by agent id. */
  readonly previousAgentIds: ReadonlySet<string>;
  /** The agent that spoke last in this conversation, if any. */
  readonly lastAgentId?: string;
}

/**
 * The name line for `speaker`, or `undefined` when none is due. A `system`
 * speaker never gets a name line (a notice is rendered as a notice).
 */
export function speakerLine(
  speaker: Speaker | undefined,
  ctx: SpeakerLineContext,
): string | undefined {
  if (speaker?.kind !== 'agent' || ctx.nativeIdentity) return undefined;
  const others = new Set(ctx.previousAgentIds);
  others.add(speaker.agentId);
  const multiAgent = others.size > 1;
  const changed = ctx.lastAgentId !== undefined && ctx.lastAgentId !== speaker.agentId;
  if (!multiAgent && !changed) return undefined;
  return `${speaker.displayName}:`;
}

/** Remembers which agents spoke in a conversation. Process-local by default. */
export interface SpeakerHistoryStore {
  get(conversationKey: string): { agentIds: ReadonlySet<string>; lastAgentId?: string } | undefined;
  record(conversationKey: string, agentId: string): void;
}

export class InMemorySpeakerHistoryStore implements SpeakerHistoryStore {
  readonly #byConversation = new Map<string, { agentIds: Set<string>; lastAgentId?: string }>();
  get(conversationKey: string) {
    return this.#byConversation.get(conversationKey);
  }
  record(conversationKey: string, agentId: string): void {
    const entry = this.#byConversation.get(conversationKey) ?? { agentIds: new Set<string>() };
    entry.agentIds.add(agentId);
    entry.lastAgentId = agentId;
    this.#byConversation.set(conversationKey, entry);
  }
}

/**
 * The name line for one answer in one conversation, recording the speaker.
 * A store that throws is treated as empty (an extra name line is harmless, a
 * missing one in a multi-agent conversation is not).
 */
export function speakerLineFor(
  store: SpeakerHistoryStore,
  conversationKey: string,
  speaker: Speaker | undefined,
  nativeIdentity: boolean,
): string | undefined {
  let previous: ReturnType<SpeakerHistoryStore['get']>;
  try {
    previous = store.get(conversationKey);
  } catch {
    previous = undefined;
  }
  const line = speakerLine(speaker, {
    nativeIdentity,
    previousAgentIds: previous?.agentIds ?? new Set<string>(),
    ...(previous?.lastAgentId !== undefined ? { lastAgentId: previous.lastAgentId } : {}),
  });
  if (speaker?.kind === 'agent') {
    try {
      store.record(conversationKey, speaker.agentId);
    } catch {
      /* a store that cannot record only costs a later redundant name line */
    }
  }
  return line;
}
