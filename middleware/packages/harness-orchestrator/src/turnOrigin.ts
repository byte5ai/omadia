/**
 * W5 — turn origin and the memory axes derived from it (design spec #870 §2/§5).
 *
 * A turn's *origin* is the chat context it arrived from: which channel, which
 * conversation, which surrounding container (a Teams team, an API tenant) and
 * who spoke. From it we derive the *memory axes* — which context tiers this
 * turn may touch — following the table in §2 of the design:
 *
 * | Turn context                                   | core | agent tier | team | channel | user |
 * |------------------------------------------------|------|------------|------|---------|------|
 * | context-free (operator UI, CLI, system scopes)  | rw   | rw         | —    | —       | —    |
 * | team channel (container present)                | rw   | ro         | rw   | rw      | —    |
 * | group/conversation without container            | rw   | ro         | —    | rw      | —    |
 * | personal chat                                   | rw   | ro         | —    | —       | rw   |
 * | API turn with a tenant container                | rw   | ro         | rw   | rw      | —    |
 *
 * Everything here is pure and synchronous; `memoryAxesForOrigin` is a total
 * function whose fail-closed answer — `{ isContextFree: true, patterns: [] }` —
 * reproduces today's agent-private behaviour exactly.
 *
 * **Temporary home.** The design places `TurnOrigin`, `MemoryAxes`,
 * `memoryAxesForOrigin` in `@omadia/channel-sdk` (`src/turnOrigin.ts`) and
 * `memoryContextKey` next to `scopeGraphKey` in `src/scopeId.ts`, because the
 * channel adapters are the producers. That move is the SDK-injection unit's
 * work; until it lands the binder needs these shapes, so they live here. The
 * declarations are structurally identical to the spec's, so re-pointing the
 * imports later is mechanical and changes no behaviour.
 */

import { createHash } from 'node:crypto';
import { formatSessionScope, type Principal, type ScopeId } from '@omadia/channel-sdk';

/** Where a turn came from. Producers: the channel adapters and the chat route. */
export interface TurnOrigin {
  /** Plugin/channel type, e.g. `'teams' | 'telegram' | 'http' | 'api'`. */
  readonly channelType: string;
  /** The turn's conversation scope — the #575 type. */
  readonly scope: ScopeId;
  /** Surrounding container, when the platform supplies one. */
  readonly container?: { readonly kind: 'team' | 'tenant'; readonly id: string };
  /** The speaking person — the #333 type. Not part of the memory axes today. */
  readonly principal?: Principal;
}

/** The narrowest tier a turn writes to by default. */
export type MemoryContextAxis = 'team' | 'channel' | 'user';

export interface MemoryAxes {
  /** `true` ⇒ today's agent-private stack, byte-identical. */
  readonly isContextFree: boolean;
  /** Scope patterns in the §3 grammar, e.g. `['channel:teams~…:*', 'team:teams~…:*']`. */
  readonly patterns: readonly string[];
  /** Narrowest tier — determines the namespacer's private root. */
  readonly narrowest?: { readonly axis: MemoryContextAxis; readonly ctxKey: string };
}

/** The fail-closed answer. Frozen so no caller can widen it by mutation. */
const CONTEXT_FREE: MemoryAxes = Object.freeze({
  isContextFree: true,
  patterns: Object.freeze([]) as readonly string[],
});

const CTX_KEY_MAX_LEN = 64;
const CTX_KEY_SAFE = /^[a-z0-9_-]{1,64}$/;
const CTX_DIGEST_LEN = 16;

/**
 * The injective half of a context key — same construction as `scopeGraphKey`
 * (#575 D3): an already-safe id is returned byte-identically, anything else
 * keeps a readable stem and gains a digest of the RAW string.
 */
function safeKeyPart(raw: string): string {
  const trimmed = raw.trim();
  if (CTX_KEY_SAFE.test(trimmed)) return trimmed;

  const digest = createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, CTX_DIGEST_LEN);
  const stem = trimmed
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, CTX_KEY_MAX_LEN - CTX_DIGEST_LEN - 1);
  return `${stem.length > 0 ? stem : 'ctx'}-${digest}`;
}

/**
 * Derive the path-safe context key for one (channel, native id) pair.
 *
 * `~` is outside the safe alphabet, so the split back into channel type and id
 * is unambiguous, and the result can never contain `:` — which is what keeps
 * the `team:<ctxKey>:*` pattern grammar parseable. Injective: two different
 * native ids never produce the same key, because a sanitised stem always
 * carries the digest of the raw string.
 */
export function memoryContextKey(channelType: string, nativeId: string): string {
  return `${safeKeyPart(channelType.toLowerCase())}~${safeKeyPart(nativeId)}`;
}

function pattern(axis: MemoryContextAxis, ctxKey: string): string {
  return `${axis}:${ctxKey}:*`;
}

/** A container only counts when it actually carries an id. */
function containerKey(origin: TurnOrigin, channelType: string): string | undefined {
  const id = origin.container?.id?.trim();
  if (id === undefined || id.length === 0) return undefined;
  return memoryContextKey(channelType, `${origin.container!.kind}:${id}`);
}

/**
 * Map a turn origin onto its memory axes. Total and fail-closed: a missing
 * origin, a machine scope, an unscoped turn or a blank channel type all yield
 * the context-free answer rather than a guess at a wider one.
 */
export function memoryAxesForOrigin(origin: TurnOrigin | undefined): MemoryAxes {
  if (!origin) return CONTEXT_FREE;

  const channelType = origin.channelType?.trim() ?? '';
  if (channelType.length === 0) return CONTEXT_FREE;

  const scope = origin.scope;
  // System scopes have no audience and unscoped ones have no resolvable
  // partition — both are deliberately context-free (§2, decision 3).
  if (!scope || scope.kind === 'system' || scope.kind === 'unscoped') return CONTEXT_FREE;

  const teamKey = containerKey(origin, channelType);

  if (scope.kind === 'org') {
    // An org-wide turn has a container but no conversation: team tier only.
    const orgKey = teamKey ?? memoryContextKey(channelType, formatSessionScope(scope));
    return {
      isContextFree: false,
      patterns: [pattern('team', orgKey)],
      narrowest: { axis: 'team', ctxKey: orgKey },
    };
  }

  if (scope.kind === 'personal') {
    // A personal chat is nobody's team channel — no team tier even if the
    // platform happened to hand us a container.
    const userKey = memoryContextKey(channelType, formatSessionScope(scope));
    return {
      isContextFree: false,
      patterns: [pattern('user', userKey)],
      narrowest: { axis: 'user', ctxKey: userKey },
    };
  }

  // `conversation` and `group`: channel tier, plus the team tier when the
  // platform placed this conversation inside a container.
  const channelKey = memoryContextKey(channelType, formatSessionScope(scope));
  const patterns = [pattern('channel', channelKey)];
  if (teamKey !== undefined) patterns.push(pattern('team', teamKey));
  return {
    isContextFree: false,
    patterns,
    narrowest: { axis: 'channel', ctxKey: channelKey },
  };
}

/** The `team:<ctxKey>:*` key granted by these axes, if any. */
export function teamAxisKey(axes: MemoryAxes): string | undefined {
  for (const p of axes.patterns) {
    const m = /^team:([^:]+):\*$/.exec(p);
    if (m) return m[1]!;
  }
  return undefined;
}
