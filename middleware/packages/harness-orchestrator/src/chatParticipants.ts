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
}

/**
 * Resolves the active-chat roster on demand. Invoked once per tool call,
 * expected to be cheap (cached by the implementer). Returning an empty
 * array is a valid "unknown / unavailable" state — callers must degrade
 * gracefully.
 */
export type ChatParticipantsProvider = () => Promise<ChatParticipant[]>;
