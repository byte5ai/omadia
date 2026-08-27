/**
 * #575 Phase 1 — `ScopeId`: the typed form of a turn's session scope.
 *
 * Today `sessionScope` is a bare `string` used as the partition key for memory,
 * the knowledge graph, sticky Direct Line bindings and parked MCP input. Five
 * different producers spell it five different ways, and two of those spellings
 * (`'http-default'`, `'teams-unknown'`) are SHARED buckets that several distinct
 * callers land in — the cross-user hole #445 had to paper over with a denylist.
 *
 * The measured producer inventory and the reasoning behind this shape live in
 * `specs/575-scope-and-identity-foundation/spec.md` (§2.2, §3).
 *
 * Two design commitments make this safe to introduce:
 *
 *  1. **"No resolvable scope" is a TYPE, not a value.** `unscoped` forces every
 *     consumer to decide what to do about it instead of silently sharing a
 *     bucket. It carries `reason` because absence and shared-bucket are
 *     genuinely different: an absent scope can never be redeemed, a shared one
 *     can be made per-person by pairing it with a user id.
 *  2. **Machine scopes are their own kind.** `routine:`/`schedule:`/`conductor:`
 *     have no audience at all — no human is present — so "the rights of everyone
 *     present" is undefined for them rather than merely restrictive. Modelling
 *     them as a variant is what lets `directLineSticky` delete its
 *     `SYNTHETIC_SCOPE_PREFIXES` denylist instead of renaming it.
 *
 * Everything here is pure and synchronous.
 */

import { createHash, randomUUID } from 'node:crypto';

/** Machine-driven scope origins. No human is present in any of them. */
export type SystemScopeOrigin = 'routine' | 'schedule' | 'conductor' | 'conductor-builder';

/**
 * The recognised machine origins.
 *
 * Order is deliberately NOT load-bearing, and that is a property worth stating
 * because it is easy to assume otherwise: `'conductor'` and `'conductor-builder'`
 * look like an overlapping-prefix hazard, but `parseSessionScope` matches on
 * `` `${origin}:` `` — and `'conductor-builder:x'` does not start with
 * `'conductor:'`, because the character after `conductor` is `-`, not `:`. The
 * trailing colon is what makes the set unambiguous.
 *
 * (Verified by mutation: reordering this array leaves the suite green. If a
 * future change drops the trailing colon from the match, order becomes
 * load-bearing again and the `conductor-builder` case in `scopeId.test.ts`
 * fails — which is the guard that actually matters.)
 */
export const SYSTEM_SCOPE_ORIGINS: readonly SystemScopeOrigin[] = Object.freeze([
  'conductor-builder',
  'conductor',
  'routine',
  'schedule',
]);

/**
 * Scope strings that are NOT per-conversation — several unrelated callers land
 * in each. Measured producers:
 *
 *  - `'http-default'`  — `middleware/src/routes/chat.ts:54`, for any caller that
 *    sends neither `scope` nor `sessionId`.
 *  - `'teams-unknown'` — `omadia-byte5-plugins` `channel-teams/src/teamsBot.ts:440-441`,
 *    `conversation?.id ?? 'unknown'` folded into `` `teams-${conversationId}` ``.
 *  - `'unknown'`       — no observed producer in either repository, retained
 *    because it costs nothing and its absence is not provable across every
 *    deployment's plugin set.
 */
export const SHARED_SCOPE_TOKENS: ReadonlySet<string> = new Set([
  'http-default',
  'teams-unknown',
  'unknown',
]);

/** Why a scope carries no addressable audience. */
export type UnscopedReason =
  /** No scope was supplied at all. Cannot be redeemed by anything. */
  | 'absent'
  /** A shared bucket several callers land in. A user id can make it per-person. */
  | 'shared';

export type ScopeId =
  | { readonly kind: 'personal'; readonly userId: string }
  | {
      readonly kind: 'conversation';
      readonly conversationId: string;
      /** Present only when the producer stated it. See `parseSessionScope`. */
      readonly channelId?: string;
    }
  | { readonly kind: 'group'; readonly groupRef: string }
  | { readonly kind: 'org'; readonly orgId: string }
  | { readonly kind: 'system'; readonly origin: SystemScopeOrigin; readonly id: string }
  | {
      readonly kind: 'unscoped';
      readonly reason: UnscopedReason;
      /** The shared bucket's literal token. Absent when `reason` is `'absent'`. */
      readonly token?: string;
    };

/** The `channelId::conversationId` separator used by `channels/coreApi.ts:80`. */
const CONVERSATION_SEPARATOR = '::';

/**
 * Classify a raw `sessionScope` string.
 *
 * This is a MIGRATION ADAPTER, not a general parser. Its contract is that it
 * classifies every value the tree actually produces while `formatSessionScope`
 * round-trips it byte-identically — introducing the type must not move a single
 * scope string, because moving one would move its graph partition and orphan
 * that conversation's memory.
 *
 * That contract is why it stays deliberately conservative on two shapes it
 * *could* decode further:
 *
 *  - `` `teams-${conversationId}` `` — splitting on `-` is unsafe (a chat-tab id
 *    may contain dashes, and `http-…` would be misread as channel `http`).
 *  - `` `telegram:${chat.id}` `` — decoding it would re-emit `telegram::<id>`,
 *    a different string and therefore a different partition.
 *
 * Both stay opaque `conversation` scopes here. **D7 migrates the producers** to
 * emit the canonical form; that is the correct place to fix the spelling,
 * because the producer knows its own channel id and the adapter can only guess.
 */
export function parseSessionScope(raw: string | undefined): ScopeId {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) return { kind: 'unscoped', reason: 'absent' };

  if (SHARED_SCOPE_TOKENS.has(trimmed)) {
    return { kind: 'unscoped', reason: 'shared', token: trimmed };
  }

  for (const origin of SYSTEM_SCOPE_ORIGINS) {
    const prefix = `${origin}:`;
    if (trimmed.startsWith(prefix)) {
      return { kind: 'system', origin, id: trimmed.slice(prefix.length) };
    }
  }

  if (trimmed.startsWith('personal:')) {
    return { kind: 'personal', userId: trimmed.slice('personal:'.length) };
  }
  if (trimmed.startsWith('group:')) {
    return { kind: 'group', groupRef: trimmed.slice('group:'.length) };
  }
  if (trimmed.startsWith('org:')) {
    return { kind: 'org', orgId: trimmed.slice('org:'.length) };
  }

  const separatorAt = trimmed.indexOf(CONVERSATION_SEPARATOR);
  if (separatorAt > 0) {
    const channelId = trimmed.slice(0, separatorAt);
    const conversationId = trimmed.slice(separatorAt + CONVERSATION_SEPARATOR.length);
    // An empty half is not a channel-qualified scope — keep it opaque so it
    // still round-trips rather than becoming a half-decoded pair.
    if (conversationId.length > 0) return { kind: 'conversation', channelId, conversationId };
  }

  return { kind: 'conversation', conversationId: trimmed };
}

/**
 * Render a `ScopeId` back to its wire string. Inverse of `parseSessionScope`
 * for every value the tree produces — asserted in `test/scopeId.test.ts`.
 */
export function formatSessionScope(scope: ScopeId): string {
  switch (scope.kind) {
    case 'personal':
      return `personal:${scope.userId}`;
    case 'group':
      return `group:${scope.groupRef}`;
    case 'org':
      return `org:${scope.orgId}`;
    case 'system':
      return `${scope.origin}:${scope.id}`;
    case 'conversation':
      return scope.channelId === undefined
        ? scope.conversationId
        : `${scope.channelId}${CONVERSATION_SEPARATOR}${scope.conversationId}`;
    case 'unscoped':
      return scope.token ?? '';
  }
}

/**
 * Whether a scope identifies an audience that can hold per-conversation state.
 * `false` for machine scopes (no human present) and for both unscoped reasons.
 */
export function isAddressableScope(scope: ScopeId): boolean {
  return scope.kind !== 'system' && scope.kind !== 'unscoped';
}

/**
 * #575 D7 — derive a channel turn's scope, refusing to land it in a SHARED one.
 *
 * A channel adapter builds its scope from the conversation id its platform
 * supplies. When that id is missing, the natural `?? 'unknown'` fallback
 * produces a literal that EVERY such turn shares — measured live in
 * `omadia-byte5-plugins` `channel-teams/src/teamsBot.ts:440-441`, where a Teams
 * activity without a conversation id yields `teams-unknown`. That single bucket
 * then keys conversation history and the knowledge-graph partition for every
 * unrelated caller who hits the same gap: the `'http-default'` hole again, in a
 * second place.
 *
 * This helper is the one decision point for that gap:
 *
 *  - A scope that resolves to a real conversation is returned **untouched**, so
 *    the wire form does not move and no existing partition is orphaned.
 *  - A scope that resolves to `unscoped` — absent OR any known shared token —
 *    is replaced by a scope unique to this turn. Two callers who both hit the
 *    gap get two scopes, which is the entire point.
 *  - Anything else (a machine scope arriving at a channel ingress — a routing
 *    bug) is returned as-is rather than laundered into a conversation.
 *
 * Because the decision is driven by `parseSessionScope`, a shared token added
 * to `SHARED_SCOPE_TOKENS` later is handled here automatically; no channel
 * plugin has to learn about it.
 *
 * `uniqueSuffix` should be the platform's per-message id (a Bot Framework
 * activity id, a Telegram update id) so a retry of the SAME message resolves to
 * the same scope. When the platform offers nothing to key on, a random id is
 * used — isolation is preserved, continuity genuinely is not recoverable.
 */
export function unsharedConversationScope(args: {
  readonly scope: string | undefined;
  readonly uniqueSuffix?: string | undefined;
}): ScopeId {
  const parsed = parseSessionScope(args.scope);
  if (parsed.kind !== 'unscoped') return parsed;

  const suffix =
    args.uniqueSuffix !== undefined && args.uniqueSuffix.trim().length > 0
      ? args.uniqueSuffix.trim()
      : randomUUID();
  return { kind: 'conversation', conversationId: `unresolved-${suffix}` };
}

/** Legacy graph-key constraints, preserved verbatim from `sessionLogger.ts`. */
const GRAPH_KEY_MAX_LEN = 80;
const GRAPH_KEY_SAFE = /^[a-z0-9_-]{1,80}$/;
const DIGEST_LEN = 16;

/**
 * #575 D3 — the injective replacement for `sanitizeScope`.
 *
 * `sanitizeScope` (`harness-orchestrator/src/sessionLogger.ts`) maps a scope to
 * the graph partition key by collapsing every non-`[a-zA-Z0-9_-]` run to `-`,
 * truncating at 80 characters and lowercasing. That mapping is **not
 * injective**: `teams::c1`, `teams:c1` and `teams-c1` all become `teams-c1`, as
 * do any two scopes agreeing on their first 80 sanitized characters or
 * differing only in case. While scope is merely a recall hint that is a quality
 * nuisance; once scope is a security boundary — the point of #575 — two scopes
 * that must not see each other's memory can share one partition while the
 * isolation check (string equality on `excludeScope`) still passes.
 *
 * This function keeps the same output alphabet and length budget while being
 * injective in practice:
 *
 *  - A scope that was ALREADY lossless (it matches the safe pattern) is
 *    returned byte-identically, so every partition that was never at risk keeps
 *    its existing data. `'http-default'`, `'teams-unknown'` and ordinary
 *    chat-tab ids all take this path.
 *  - Anything else keeps a readable sanitized stem and gains a digest of the
 *    RAW string, which is what makes the mapping injective.
 *
 * A genuinely empty scope still maps to `'unscoped'`, exactly as before. A
 * non-empty scope never does — conflating "no scope" with "a scope made of
 * punctuation" is part of the bug.
 *
 * **Migration:** for any scope that was lossy — which is every `teams-<conv>`,
 * `telegram:<id>`, `routine:<id>`, `conductor:<run>:<step>` and every
 * `channelId::conversationId` — this returns a DIFFERENT key than
 * `sanitizeScope` did, so its existing graph partition is orphaned. That is why
 * the caller gates it behind an explicit opt-in rather than switching
 * deployments over silently.
 */
export function scopeGraphKey(rawScope: string): string {
  const trimmed = rawScope?.trim() ?? '';
  if (trimmed.length === 0) return 'unscoped';
  if (GRAPH_KEY_SAFE.test(trimmed)) return trimmed;

  const digest = createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, DIGEST_LEN);
  const stem = trimmed
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, GRAPH_KEY_MAX_LEN - DIGEST_LEN - 1);
  // `stem` is empty when the scope was punctuation-only. A fixed placeholder
  // keeps the key well-formed without collapsing it onto `'unscoped'`.
  return `${stem.length > 0 ? stem : 'scope'}-${digest}`;
}

/**
 * Context-key constraints. Same construction as `scopeGraphKey` above, a
 * tighter budget: a context key is a PATH SEGMENT under
 * `/memories/contexts/<slug>/<axis>/`, and it is embedded in the scope pattern
 * `` `team:<ctxKey>:*` `` — so it must stay short and must never carry a `:`.
 */
const CONTEXT_KEY_MAX_LEN = 64;
const CONTEXT_KEY_SAFE = /^[a-z0-9_-]{1,64}$/;

/**
 * The channel-type / id separator. Deliberately OUTSIDE the safe alphabet, so
 * splitting a key at its first `~` recovers exactly the two parts that made it.
 */
const CONTEXT_KEY_SEPARATOR = '~';

/**
 * Placeholder stem for an id that sanitizes to nothing (punctuation-only, or
 * empty). Keeps the segment well-formed; the digest still carries the identity.
 */
const CONTEXT_KEY_EMPTY_STEM = 'id';

/**
 * The shape the digest branch below always produces: `…-<16 lowercase hex>`.
 *
 * Load-bearing for injectivity, not cosmetic. The two branches of
 * {@link safeContextSegment} would otherwise share one output space: an
 * already-safe id spelled `x-61d6ea9c6d461bda` is carried through verbatim by
 * the passthrough branch and is ALSO what the digest branch emits for the
 * unsafe id `X!` (sha256('X!').slice(0,16) === '61d6ea9c6d461bda'). A caller
 * who can name their own conversation id could then pre-image another
 * context's key and land in its memory tree. Forcing every raw id of this
 * shape down the digest branch makes the two output spaces disjoint, so the
 * segment function is injective wherever sha256-16 is collision-free.
 */
const CONTEXT_KEY_DIGEST_SHAPE = new RegExp(`-[0-9a-f]{${DIGEST_LEN}}$`);

/**
 * One key segment: byte-identical when it is already lossless AND cannot be
 * confused with a digest, stem + digest otherwise. This is `scopeGraphKey`'s
 * body with the context budget — kept as its own function rather than a
 * parameter on `scopeGraphKey` because the two keys must be free to diverge
 * without silently moving graph partitions.
 */
function safeContextSegment(raw: string): string {
  if (CONTEXT_KEY_SAFE.test(raw) && !CONTEXT_KEY_DIGEST_SHAPE.test(raw)) return raw;

  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, DIGEST_LEN);
  const stem = raw
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, CONTEXT_KEY_MAX_LEN - DIGEST_LEN - 1);
  return `${stem.length > 0 ? stem : CONTEXT_KEY_EMPTY_STEM}-${digest}`;
}

/**
 * W5 memory-ACL — the partition key for a chat context's memory tree.
 *
 * Every `<ctxKey>` in the store grammar (`team:<ctxKey>:*`, `channel:<ctxKey>:*`,
 * `user:<ctxKey>:*`), every physical path under
 * `/memories/contexts/<slug>/<axis>/<ctxKey>/`, every purge selector and the
 * promote route go through THIS function. It is the single choke point on
 * purpose: an ad-hoc `replace(/[^a-z0-9]/g, '-')` anywhere else re-opens the
 * hole `scopeGraphKey` was written to close.
 *
 * Why a digest at all: the old `sanitizeScope` collapse is not injective, and
 * that stops being a recall nuisance the moment the key is a SECURITY boundary.
 * A Teams conversation id is `19:abc@thread.tacv2` — it carries `:` and `@`, so
 * plain sanitizing maps it onto the same key as the literal `19-abc-thread-tacv2`
 * and onto every sibling that differs only in punctuation. Two teams that must
 * not see each other's notes would then share one memory tree while every
 * equality check still passes.
 *
 * The shape is `` `${lower(channelType)}~${safeKey(nativeId)}` ``:
 *
 *  - `channelType` is a TYPE TOKEN, so it is case- and whitespace-normalised
 *    before hashing — `'Teams'`, `'teams'` and `' teams '` are the same channel.
 *  - `nativeId` is IDENTITY, so it is hashed byte-exact: `' c1'` and `'c1'` are
 *    two ids and get two partitions. Over-partitioning is the safe direction.
 *  - `~` is outside the safe alphabet, so the split back into channel type and
 *    id is unambiguous, and the result can never contain a `:` that would break
 *    the `` /^team:([^:]+):\*$/ `` pattern format.
 *
 * Injective wherever a 64-bit sha256 prefix is collision-free: an already-safe
 * id is carried through byte-identically, anything else keeps a 64-bit digest
 * of the RAW input beside its readable stem, and the two output spaces are kept
 * DISJOINT by {@link CONTEXT_KEY_DIGEST_SHAPE} — without that a safe id spelled
 * in the digest branch's own shape would pre-image a hashed context's key.
 *
 * Examples: `teams~19-abc-thread-tacv2-a1b2c3d4e5f60718`,
 * `telegram~-1001234567890`, `api~tenant-acme`.
 */
export function memoryContextKey(channelType: string, nativeId: string): string {
  const type = safeContextSegment((channelType ?? '').trim().toLowerCase());
  const id = safeContextSegment(nativeId ?? '');
  return `${type}${CONTEXT_KEY_SEPARATOR}${id}`;
}
