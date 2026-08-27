/**
 * W5 memory-ACL — `TurnOrigin`: where a chat turn came from, and the memory
 * axes that follow from it (design: issue #870 §2, §5).
 *
 * Agent memory is isolated per AGENT today (`ScopedMemoryStore` over
 * `['core', 'orchestrator:<slug>:*']`) but not per CHAT CONTEXT: what an agent
 * learns in Teams team A lands in the agent-global tree and is quotable in team
 * B on the next turn. Closing that hole needs one thing the kernel does not have
 * yet — a typed statement of WHERE a turn came from, carried on the single
 * contract every channel adapter shares.
 *
 * `ChatAgent.chat(input)` is that contract. Teams, Telegram, the HTTP dev route
 * and the CLI all go through it, so `ChatTurnInput.origin` is the only place the
 * injection can live without becoming channel-specific. It is optional: an old
 * channel plugin that sends no `origin` resolves to the context-free axes, which
 * are byte-identical to today's behaviour. No flag day.
 *
 * `memoryAxesForOrigin` is the pure translation from that origin to the scope
 * patterns of §3. It decides NOTHING about enforcement — `effectiveMemoryScope`
 * intersects these axes with the static agent scope, and `ScopedMemoryStore`
 * remains the backstop that turns a mapping bug into a `MemoryScopeViolation`
 * rather than a leak. Keeping this function pure and synchronous is what makes
 * the security decision testable as a table instead of as an integration.
 *
 * **Fail-closed is the whole design.** Every path that cannot name a context
 * with confidence returns {@link CONTEXT_FREE_MEMORY_AXES} — row 1 of the §2
 * table, exactly what a turn does today. Note which direction that fails in:
 * context-free grants read/write on the agent-private tier and reaches NO
 * context tree, so an unrecognised turn can never see team A's notes. Guessing
 * a context would be the unsafe direction; refusing one is not.
 */

import type { Principal } from './principal.js';
import { memoryContextKey, type ScopeId } from './scopeId.js';

/**
 * The three context tiers a turn can reach, narrowest-first in the sense that
 * matters here: `channel` and `user` are per-conversation, `team` spans the
 * conversations of one container.
 */
export type MemoryAxis = 'team' | 'channel' | 'user';

/**
 * Where a turn came from, in the platform-agnostic terms the memory ACL needs.
 *
 * Built by the channel adapter from the platform-native event, immediately
 * beside the `sessionScope` it already builds — see §4 of the design for the
 * per-channel recipes (Teams: `parseSessionScope(sessionScope)` plus
 * `channelData.team?.id`; Telegram: `chat.type` decides personal vs.
 * conversation and never yields a container).
 */
export interface TurnOrigin {
  /** Plugin-/Channel-Typ, z.B. 'teams' | 'telegram' | 'http' | 'api'. */
  readonly channelType: string;
  /** Conversation-Scope des Turns — bestehender #575-Typ. */
  readonly scope: ScopeId;
  /** Umgebender Container, wenn die Plattform einen liefert (Teams-Team, API-Mandant). */
  readonly container?: { readonly kind: 'team' | 'tenant'; readonly id: string };
  /**
   * Sprechende Person — bestehender #333-Typ.
   *
   * Carried for audit and for the promote action's actor, NOT for the axis
   * derivation: on a personal chat the scope's own `userId` is the authority on
   * whose tier this is, and deriving the user key from a second field would let
   * the two disagree. See {@link memoryAxesForOrigin}.
   */
  readonly principal?: Principal;
}

/** The memory axes a turn may reach, in the scope grammar of design §3. */
export interface MemoryAxes {
  readonly isContextFree: boolean;
  /** Scope-Patterns in Grammatik aus Abschnitt 3, z.B. ['channel:teams~…:*', 'team:teams~…:*']. */
  readonly patterns: readonly string[];
  /** Engstes Tier — bestimmt das privateRoot des Namespacers. */
  readonly narrowest?: { readonly axis: MemoryAxis; readonly ctxKey: string };
}

/**
 * Row 1 of the §2 table: no context tree is reachable, the agent-private tier
 * stays read/write. Frozen and shared because every fail-closed path returns
 * the same value and a caller must not be able to mutate it into a wider one.
 */
export const CONTEXT_FREE_MEMORY_AXES: MemoryAxes = Object.freeze({
  isContextFree: true,
  patterns: Object.freeze([]) as readonly string[],
});

/**
 * The channel types whose turns may reach a context tree.
 *
 * An allowlist rather than "any non-empty string" because the §2 table is a
 * per-channel statement: it says what a Teams team channel means, what a
 * Telegram private chat means, what an API turn with a tenant means. A channel
 * nobody has reasoned about has no row, and inventing one for it would be
 * exactly the guess this design refuses. A new channel therefore behaves like
 * today (context-free) until someone adds it here together with its recipe in
 * §4 — a deliberate act, reviewable as a one-line diff.
 *
 * Matching is on the trimmed, lower-cased type token, the same normalisation
 * `memoryContextKey` applies to its type segment.
 */
export const CONTEXT_MEMORY_CHANNEL_TYPES: ReadonlySet<string> = Object.freeze(
  new Set(['teams', 'telegram', 'http', 'api']),
);

/**
 * A context key for `nativeId`, or `undefined` when `identity` names nothing.
 *
 * The blank check runs on the IDENTITY-bearing field rather than on the string
 * that gets keyed, because the keyed string is often a composed one
 * (`` `org:${orgId}` ``, `` `group:${groupRef}` ``): a blank id composes into a
 * perfectly non-blank `'org:'` that every such turn would then share — the
 * shared-bucket hole in a new place.
 *
 * The check itself runs on a trimmed copy while the RAW string is what gets
 * keyed: `memoryContextKey` hashes identity byte-exact on purpose (`' c1'` and
 * `'c1'` are two ids), and trimming here would produce a key that no purge
 * selector or promote route computing the same id could reproduce.
 */
function contextKeyFor(
  channelType: string,
  identity: string,
  nativeId = identity,
): string | undefined {
  if ((identity ?? '').trim().length === 0) return undefined;
  return memoryContextKey(channelType, nativeId);
}

/**
 * An injective string for a tuple of scope parts.
 *
 * `JSON.stringify` of an array of strings is unambiguous — every `"` and `\`
 * inside a part is escaped, so no two different tuples can produce one string.
 * That is the whole reason it is used here instead of joining with a
 * separator.
 *
 * The alternative, `formatSessionScope(scope)`, is NOT safe for this job even
 * though it is the canonical wire form. It is injective only over the string
 * subset `parseSessionScope` emits, while §4 has the Telegram adapter build
 * conversation scopes DIRECTLY, so that precondition is not guaranteed —
 * `{kind:'group', groupRef:'x'}` and `{kind:'conversation',
 * conversationId:'group:x'}` both format to `group:x`, and its
 * `CONVERSATION_SEPARATOR` is not escaped either, so
 * `{channelId:'msteams', conversationId:'c'}` and
 * `{conversationId:'msteams::c'}` also collapse. Each collapse is two
 * structurally different chats sharing one memory tier.
 *
 * The readable stem survives: `["conversation","msteams","c1"]` sanitises to
 * the stem `conversation-msteams-c1`, so the operator still recognises the
 * tree — it just carries a digest of the exact tuple beside it.
 */
function scopeTuple(...parts: ReadonlyArray<string | undefined>): string {
  // Absent optional parts are OMITTED rather than encoded as null, purely so
  // the sanitised stem reads as `conversation-c1` instead of
  // `conversation-null-c1`. Injectivity is unaffected: JSON arrays of different
  // length are different strings, and only trailing optionals are ever absent.
  return JSON.stringify(parts.filter((p): p is string => p !== undefined));
}

/**
 * The per-conversation axis of a scope: `channel` for conversation/group scopes,
 * `user` for personal ones, none for anything else.
 *
 * A personal scope keys on `userId` alone rather than on a tuple, because the
 * user tier is about the PERSON: the same human's private chat should land in
 * one tree whatever the scope spelling, and `userId` is the whole identity of a
 * personal scope anyway. That cannot collide with a conversation key that
 * happens to read the same, since the axis is part of both the pattern
 * (`user:` vs `channel:`) and the physical path (`…/user/<key>` vs
 * `…/channel/<key>`).
 */
function narrowAxisFor(
  channelType: string,
  scope: ScopeId,
): { readonly axis: MemoryAxis; readonly ctxKey: string } | undefined {
  if (scope.kind === 'personal') {
    const ctxKey = contextKeyFor(channelType, scope.userId);
    return ctxKey === undefined ? undefined : { axis: 'user', ctxKey };
  }

  if (scope.kind === 'conversation') {
    const ctxKey = contextKeyFor(
      channelType,
      scope.conversationId,
      scopeTuple(scope.kind, scope.channelId, scope.conversationId),
    );
    return ctxKey === undefined ? undefined : { axis: 'channel', ctxKey };
  }

  if (scope.kind === 'group') {
    const ctxKey = contextKeyFor(
      channelType,
      scope.groupRef,
      scopeTuple(scope.kind, scope.groupRef),
    );
    return ctxKey === undefined ? undefined : { axis: 'channel', ctxKey };
  }

  // `org` has no conversation of its own — it is handled as a container below.
  return undefined;
}

/**
 * The team-tier key of a turn, or `undefined` when it has no container.
 *
 * Two sources, in precedence order:
 *
 *  1. An explicit `container` — a Teams team or an API tenant. Both land in the
 *     SAME tier, so the container kind is part of the keyed identity: a team
 *     `acme` and a tenant `acme` on one channel type must not share a tree.
 *  2. An `org` scope with no container. An org scope names a tenant-wide
 *     audience rather than a conversation, so the team tier is where it
 *     belongs — and note this is the SAFE direction: mapping it to a team tier
 *     is strictly narrower than the context-free row it would otherwise take.
 */
function teamKeyFor(channelType: string, origin: TurnOrigin): string | undefined {
  const container = origin.container;
  if (container !== undefined) {
    // Defensive: `container.kind` is typed, but this value crosses a plugin
    // boundary from an independently versioned channel package.
    if (container.kind !== 'team' && container.kind !== 'tenant') return undefined;
    return contextKeyFor(channelType, container.id, scopeTuple(container.kind, container.id));
  }

  if (origin.scope?.kind === 'org') {
    const orgId = origin.scope.orgId;
    return contextKeyFor(channelType, orgId, scopeTuple('org', orgId));
  }

  return undefined;
}

/** Pure. unscoped/system/unbekannt → { isContextFree: true, patterns: [] }. */
export function memoryAxesForOrigin(origin: TurnOrigin | undefined): MemoryAxes {
  if (origin === undefined) return CONTEXT_FREE_MEMORY_AXES;

  const channelType = (origin.channelType ?? '').trim().toLowerCase();
  if (!CONTEXT_MEMORY_CHANNEL_TYPES.has(channelType)) return CONTEXT_FREE_MEMORY_AXES;

  const scope = origin.scope;
  // `unscoped` is a shared bucket or nothing at all, and a `system` scope has no
  // audience by construction (`isAddressableScope`) — neither names a context.
  if (scope === undefined || scope.kind === 'unscoped' || scope.kind === 'system') {
    return CONTEXT_FREE_MEMORY_AXES;
  }

  const narrow = narrowAxisFor(channelType, scope);
  const teamKey = teamKeyFor(channelType, origin);
  if (narrow === undefined && teamKey === undefined) return CONTEXT_FREE_MEMORY_AXES;

  // Narrowest first: the default write target is the first pattern, and the
  // order is what the namespacer reads its `privateRoot` from.
  const patterns: string[] = [];
  if (narrow !== undefined) patterns.push(`${narrow.axis}:${narrow.ctxKey}:*`);
  if (teamKey !== undefined) patterns.push(`team:${teamKey}:*`);

  return Object.freeze({
    isContextFree: false,
    patterns: Object.freeze(patterns) as readonly string[],
    narrowest: narrow ?? ({ axis: 'team', ctxKey: teamKey as string } as const),
  });
}

/** `team:<ctxKey>:*` — the pattern token for one context tier. */
const TEAM_PATTERN = /^team:([^:]+):\*$/;

/**
 * The team-tier key these axes grant, if any.
 *
 * Read back off the emitted patterns rather than recomputed, so the `~team`
 * alias the namespacer exposes can never point at a tier the compiled scope
 * does not actually grant.
 */
export function teamAxisKey(axes: MemoryAxes | undefined): string | undefined {
  if (axes === undefined) return undefined;
  for (const p of axes.patterns) {
    const m = TEAM_PATTERN.exec(p);
    if (m) return m[1]!;
  }
  return undefined;
}
