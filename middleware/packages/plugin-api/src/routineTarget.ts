/**
 * Routine delivery-target model — the contract that lets a routine reach a
 * person who has **never** messaged the bot ("cold-start" 1:1 outreach),
 * shared between the routines feature (kernel) and channel plugins (e.g.
 * Teams) that resolve the target into a live conversation.
 *
 * ## Why this lives in plugin-api
 *
 * The routine's `conversation_ref` is an opaque JSONB column. Historically
 * it stored a raw, channel-native conversation reference captured from an
 * inbound turn (Bot Framework `ConversationReference`, Telegram chat id, …)
 * — meaning a routine could only deliver to someone who had already DMed
 * the bot. To add cold-start delivery WITHOUT a schema migration and
 * WITHOUT breaking the existing warm path, we overlay a tagged union on the
 * same column:
 *
 *   - **warm / legacy** — any value that is NOT a `ColdStartTarget` (i.e.
 *     no `kind: 'coldStart'` discriminator) is treated as an
 *     already-resolved, channel-native reference. Current behaviour,
 *     untouched.
 *   - **cold-start** — `{ kind: 'coldStart', … }`. The recipient has not
 *     been reached yet. On first delivery the channel sender resolves a
 *     live conversation (e.g. install the bot for the user + open a 1:1),
 *     delivers, then calls `RoutinesIntegration.updateRoutineConversationRef`
 *     to persist the materialised reference so subsequent runs deliver via
 *     the warm path.
 *
 * Both repos import these types from `@omadia/plugin-api` so the cold-start
 * shape has a single source of truth across the OSS kernel and the private
 * channel plugins.
 */

/** How a cold-start recipient is identified before a conversation exists. */
export type RoutineRecipient =
  | { readonly by: 'email'; readonly email: string }
  | { readonly by: 'aadObjectId'; readonly aadObjectId: string };

/**
 * Orchestrator binding for a freshly materialised cold-start conversation.
 *
 * - `'bare'` — bind the new 1:1 to a default orchestrator with **no
 *   attached plugins**. This is the default for cold-start: the first
 *   contact with someone who never opted in stays controlled and minimal
 *   (it should ask its review/reminder question, not expose the full
 *   plugin toolset to an unprimed user).
 * - `'inherit'` — let the channel's normal binding resolution decide the
 *   orchestrator for the new conversation.
 */
export type RoutineOrchestratorProfile = 'bare' | 'inherit';

export const COLD_START_TARGET_KIND = 'coldStart' as const;

/**
 * A deferred delivery target stored on a routine row in place of a
 * resolved conversation reference. See the module doc for the warm/legacy
 * vs cold-start overlay rationale.
 */
export interface ColdStartTarget {
  readonly kind: typeof COLD_START_TARGET_KIND;
  /** Channel the recipient must be reached on. Mirrors `routine.channel`. */
  readonly channel: string;
  /** Who to reach, before any conversation exists. */
  readonly recipient: RoutineRecipient;
  /**
   * Orchestrator profile the materialised conversation should bind to.
   * Defaults to `'bare'` for cold-start (see RoutineOrchestratorProfile).
   */
  readonly orchestratorProfile: RoutineOrchestratorProfile;
  /**
   * Audit trail — who created this targeted routine. Cold-start routines
   * message a third party, so the originator is recorded for governance.
   */
  readonly createdBy: { readonly tenant: string; readonly userId: string };
}

/**
 * Type guard: is the opaque `conversation_ref` a cold-start target rather
 * than an already-resolved channel-native reference? Channel senders call
 * this to decide whether to resolve-then-deliver (cold) or deliver
 * directly (warm).
 *
 * Deliberately permissive on the inner shape beyond the discriminator and
 * the two fields a sender must read (`channel`, `recipient`) so a future
 * additive field doesn't break older senders.
 */
export function isColdStartTarget(ref: unknown): ref is ColdStartTarget {
  if (typeof ref !== 'object' || ref === null) return false;
  const r = ref as Record<string, unknown>;
  if (r['kind'] !== COLD_START_TARGET_KIND) return false;
  if (typeof r['channel'] !== 'string' || r['channel'].length === 0) {
    return false;
  }
  return isRoutineRecipient(r['recipient']);
}

/** Narrow an unknown value to a {@link RoutineRecipient}. */
export function isRoutineRecipient(value: unknown): value is RoutineRecipient {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['by'] === 'email') {
    return typeof v['email'] === 'string' && v['email'].length > 0;
  }
  if (v['by'] === 'aadObjectId') {
    return typeof v['aadObjectId'] === 'string' && v['aadObjectId'].length > 0;
  }
  return false;
}

/**
 * Conservative email shape check + normalisation (trim + lowercase) for the
 * `targetEmail` input the routine-management tool accepts. Not a full
 * RFC 5322 validator — just enough to reject obvious garbage before we hand
 * the value to Graph user lookup. Returns `null` for invalid input so the
 * caller can surface a clear error instead of creating a routine that can
 * never resolve a recipient.
 */
export function normaliseRecipientEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  // Single @, non-empty local part, a dotted domain with a 2+ char TLD.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Build a cold-start target for an email recipient. Returns `null` when the
 * email fails {@link normaliseRecipientEmail}.
 */
export function buildEmailColdStartTarget(input: {
  channel: string;
  email: string;
  createdBy: { tenant: string; userId: string };
  orchestratorProfile?: RoutineOrchestratorProfile;
}): ColdStartTarget | null {
  const email = normaliseRecipientEmail(input.email);
  if (email === null) return null;
  return {
    kind: COLD_START_TARGET_KIND,
    channel: input.channel,
    recipient: { by: 'email', email },
    orchestratorProfile: input.orchestratorProfile ?? 'bare',
    createdBy: { tenant: input.createdBy.tenant, userId: input.createdBy.userId },
  };
}
