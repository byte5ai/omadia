/**
 * Channel-agnostic store interfaces. Today both the kernel and the Teams
 * channel collaborate via concrete classes (`ConversationHistoryStore`,
 * `TeamsAttachmentStore`) — these interfaces capture the minimal surface
 * so a Slack / Telegram / WhatsApp connector can provide its own impl
 * without pulling in kernel-internal concretions.
 *
 * Stability contract: treat these interfaces as shared between providers
 * and consumers. Adding a method is a minor (safe for existing impls);
 * renaming / removing is a major. Optional methods carry their own
 * existence check at the call-site.
 */

/** A single round-trip: user message + assistant answer. */
export interface ConversationTurn {
  userMessage: string;
  assistantAnswer: string;
  /** Unix epoch ms. Stores MAY ignore absent values. */
  timestampMs?: number;
}

/**
 * Per-conversation-scope history buffer. Scope is a channel-native
 * conversation id (Teams `conversationReference`, Slack channel+thread,
 * Telegram chat id, …) — connectors own the scoping convention. Stores
 * enforce a retention policy (TTL, max-turns, LRU eviction) — callers
 * MUST NOT rely on unlimited history.
 */
export interface ConversationHistoryStore {
  /** Recent turns for this scope, newest last. Returns [] if scope unknown. */
  get(scope: string): ConversationTurn[];

  /**
   * Append a completed turn. Implementations SHOULD drop empty turns
   * (both strings empty) silently.
   */
  append(scope: string, turn: ConversationTurn): void;

  /** Drop all state for a scope. Optional — not every store supports it. */
  clear?(scope: string): void;
}

/**
 * An attachment the orchestrator / connector has persisted for later
 * retrieval (e.g. as an `OutgoingAttachment.url`). The shape is stable
 * across storage backends (Tigris, S3, local fs, in-memory).
 */
export interface PersistedAttachment {
  /** Storage-internal key. Connectors SHOULD treat as opaque. */
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Content hash for de-duplication & cache-busting. */
  sha256: string;
  /**
   * Signed proxy URL; present iff the store was configured with a signing
   * key. Undefined means the caller must use `storageKey` + store-internal
   * retrieval.
   */
  signedUrl?: string;
  /** Producer hint (mirror of `OutgoingAttachment.producer`). */
  producer?: string;
}

/**
 * Input to `AttachmentStore.put`. Connectors MAY stream or pass a Buffer —
 * implementations typically accept both.
 */
export interface AttachmentPutInput {
  fileName: string;
  contentType: string;
  /** Raw bytes. Streaming variants are backend-specific. */
  body: Buffer | Uint8Array;
  /** Producer hint. Recorded on the resulting PersistedAttachment. */
  producer?: string;
}

/**
 * Channel-agnostic attachment persistence. Today Teams owns a concrete
 * `TeamsAttachmentStore` (Tigris-backed with signed-URL generation); the
 * Diagrams plugin owns its own `TigrisStore` (same bucket, different
 * purpose). Slack / Telegram connectors may ship their own impl or share
 * a backend via DI once a common bucket strategy is agreed.
 */
export interface AttachmentStore {
  /** Persist a new attachment. Returns the canonical record. */
  put(input: AttachmentPutInput): Promise<PersistedAttachment>;

  /** Look up by storage key. Returns undefined if unknown / expired. */
  get(storageKey: string): Promise<PersistedAttachment | undefined>;

  /**
   * Produce a signed URL for an existing key, re-signing if the store
   * supports TTL refresh. Implementations without a signing key return
   * undefined — callers must then fall back to storage-native retrieval.
   */
  signUrl?(storageKey: string, ttlMs?: number): Promise<string | undefined>;
}
