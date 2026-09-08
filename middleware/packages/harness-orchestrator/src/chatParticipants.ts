/**
 * Channel-neutral participant shape + provider type.
 *
 * Lets the orchestrator's `get_chat_participants` tool ask "who's in the
 * current chat" without knowing about Teams. The Teams adapter implements
 * a `ChatParticipantsProvider` via `TeamsRosterProvider`; other adapters
 * (future Slack / web) can plug in the same interface.
 */
export interface ChatParticipant {
  /** Channel-native user id — used verbatim as `mentioned.id` on outgoing activities. */
  channelUserId: string;
  /** Stable cross-channel identifier when available (AAD object id for Teams). */
  aadObjectId: string | null;
  /** Display name, used both in `<at>…</at>` tokens and Mention-Entity `mentioned.name`. */
  displayName: string;
  /** Email if the channel exposes it; null when unknown (e.g. Teams guest users). */
  email: string | null;
  /** User Principal Name (AAD). Null when absent. */
  userPrincipalName: string | null;
  /**
   * #1018 — who this participant IS. Absent = `'human'` (every roster provider
   * predates the field and lists people only). `'agent'` marks another omadia
   * agent's bot, merged in by the kernel ONLY when agent-to-agent is enabled
   * for both the calling agent and the peer in this chat; `agentSlug` is the
   * name the discussion tools accept.
   */
  kind?: 'human' | 'agent';
  agentSlug?: string;
}

/**
 * #1018 — resolves the peer AGENTS the calling agent may see in the current
 * chat. Kernel-published (`chatPeerAgents@1`) because presence and the peer
 * policy both live in kernel-owned tables; resolved per call, like every
 * optional service. Empty outside a channel turn or when nothing is enabled.
 */
export type ChatPeerAgentsProvider = () => Promise<ChatParticipant[]>;

/**
 * Resolves the active-chat roster on demand. Invoked once per tool call,
 * expected to be cheap (cached by the implementer). Returning an empty
 * array is a valid "unknown / unavailable" state — callers must degrade
 * gracefully.
 */
export type ChatParticipantsProvider = () => Promise<ChatParticipant[]>;
