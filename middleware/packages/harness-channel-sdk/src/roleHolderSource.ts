/**
 * #333 Phase 3 — role → holders, resolved from pluggable sources.
 *
 * Phase 2 answered "what roles does this principal have?". This is the inverse
 * direction, and it is the one Conductor already depends on:
 * `conductor/roleStore.ts:22` calls an external resolver "a follow-up", and the
 * Phase-0 spec (§6) assigns that follow-up to #333.
 *
 * Today a role's holders come only from `conductor_role_assignments`. With an
 * Entra group or an Odoo HR org chart as a source, the holder set becomes a
 * union across systems — which introduces a state that could not exist before:
 * **a partially-known holder list**.
 *
 * ## Why partiality is not a nicety here
 *
 * Conductor makes three decisions from the holder list, and two of them fail
 * OPEN if a shrunken list is mistaken for the truth:
 *
 * | Decision | Shrunken list does what | |
 * |---|---|---|
 * | "may this responder resolve the await?" | rejects a real holder | fail-closed, safe |
 * | **`quorum='all'` completeness** | **completes with too few approvals** | fail-OPEN |
 * | **"role has no holder → take the fallback"** | **skips the human step entirely** | fail-OPEN |
 *
 * A four-eyes approval silently becoming two-eyes during a directory outage, or
 * an approval step being skipped altogether, are exactly the outcomes an
 * approval workflow exists to prevent. So this module never hands out a bare
 * `string[]`: {@link AggregateHolderLookup} carries `partial`, and the callers
 * that can fail open are required to consult it.
 *
 * Same discipline as `roleSource.ts` and, before it, `ScopeId`'s `unscoped` and
 * `Principal`'s `undefined`: **absence is a type, not a value.**
 */

import { canonicalizePrincipalRef } from './principal.js';

/** Why a source could not answer. Never means "this role has no holders". */
export type HolderLookupUnavailableCode =
  /** The backing directory/API failed, timed out, or refused the read. */
  | 'source_error'
  /** Registered but not configured enough to answer yet. */
  | 'not_configured'
  /** The source has no concept of this role (not an error — it simply is not its role). */
  | 'unknown_role';

/**
 * One source's answer about one role key.
 *
 * `resolved` with an empty `holders` array is a real answer: this source knows
 * the role and nobody currently holds it. That is what legitimately triggers
 * Conductor's fallback path — and it is precisely what `unavailable` must never
 * be mistaken for.
 */
export type HolderLookup =
  | { readonly outcome: 'resolved'; readonly holders: readonly string[] }
  | {
      readonly outcome: 'unavailable';
      readonly code: HolderLookupUnavailableCode;
      /** Operator-readable. Belongs in logs, never in an HTTP body. */
      readonly message: string;
    };

/**
 * A pluggable origin of role-holder facts — the local assignment table, an
 * Entra group, an Odoo HR reporting line.
 *
 * The local Conductor store is registered as one of these rather than being
 * special-cased, so composition has exactly one code path and the local store
 * enjoys the same failure handling as any remote directory.
 */
export interface RoleHolderSource {
  readonly id: string;
  readonly displayName: string;
  /**
   * Current holders of `roleKey`, as principal ids.
   *
   * Implementations should **return** `unavailable` rather than throw; the
   * registry defends against throwing anyway, because one unreachable directory
   * must not take down a run.
   */
  holdersFor(roleKey: string): Promise<HolderLookup>;
}

/**
 * The union across every active source.
 *
 * `partial` means `holders` is a LOWER BOUND: more people may hold this role
 * than are listed. Nothing may be concluded from an id's absence — in
 * particular not "this role has no holders" and not "everyone required has
 * answered".
 */
export interface AggregateHolderLookup {
  /** Canonical (trim + lowercase), de-duplicated, sorted for comparability. */
  readonly holders: readonly string[];
  /** True iff at least one active source failed to answer. */
  readonly partial: boolean;
  /** Per-source outcome, in registration order. For operator diagnostics. */
  readonly bySource: readonly { readonly sourceId: string; readonly lookup: HolderLookup }[];
}

/**
 * The superset of holder sources the operator allowed. Immutable after boot;
 * the admin UI may only activate what is already here.
 *
 * Same two-tier gate as `auth/providerRegistry.ts`, and for a sharper reason: a
 * holder source decides **who may approve**. Registering one silently would let
 * an attacker nominate themselves as an approver with no login event to notice.
 */
export class RoleHolderCatalog {
  private readonly sources = new Map<string, RoleHolderSource>();

  add(source: RoleHolderSource): void {
    if (this.sources.has(source.id)) {
      throw new Error(`role-holder catalog id collision: ${source.id} already added`);
    }
    this.sources.set(source.id, source);
  }

  get(id: string): RoleHolderSource | undefined {
    return this.sources.get(id);
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  list(): RoleHolderSource[] {
    return Array.from(this.sources.values());
  }
}

/** The currently-active holder sources, in registration order. */
export class RoleHolderRegistry {
  private readonly sources = new Map<string, RoleHolderSource>();

  register(source: RoleHolderSource): void {
    if (this.sources.has(source.id)) {
      throw new Error(`role-holder source id collision: ${source.id} already registered`);
    }
    this.sources.set(source.id, source);
  }

  /**
   * Activate a catalogued source by id. `false` means "not catalogued" and must
   * be treated as refused — never worked around by constructing the source.
   */
  activate(catalog: RoleHolderCatalog, id: string): boolean {
    const source = catalog.get(id);
    if (!source) return false;
    if (this.sources.has(id)) return true;
    this.sources.set(id, source);
    return true;
  }

  unregister(id: string): boolean {
    return this.sources.delete(id);
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  list(): RoleHolderSource[] {
    return Array.from(this.sources.values());
  }

  size(): number {
    return this.sources.size;
  }

  /**
   * Union the holders every active source reports for `roleKey`.
   *
   * Holder ids are canonicalized with the **user** rule (trim + lowercase),
   * because a holder id IS a user principal — the same rule
   * `canonicalizePrincipalId` applies before Conductor's case-sensitive `=`
   * comparisons. Role KEYS keep their case; holder ids do not. Mixing the two
   * rules up is a silent routing miss (see `principal.ts`).
   *
   * Sources are queried concurrently, and a throwing source becomes
   * `unavailable` rather than rejecting — but it still appears in `bySource`
   * and still sets `partial`, so it cannot disappear quietly.
   *
   * With no active sources the result is `partial: false` and empty: a
   * deployment that configured nothing has genuinely no holders, which is a
   * complete answer rather than a failed lookup.
   */
  async resolveHolders(roleKey: string): Promise<AggregateHolderLookup> {
    const bySource = await Promise.all(
      this.list().map(async (source) => ({
        sourceId: source.id,
        lookup: await safeHoldersFor(source, roleKey),
      })),
    );

    const holders = new Set<string>();
    let partial = false;
    for (const { lookup } of bySource) {
      if (lookup.outcome === 'unavailable') {
        partial = true;
        continue;
      }
      for (const holder of lookup.holders) {
        const canonical = canonicalizePrincipalRef('user', holder);
        if (canonical.length > 0) holders.add(canonical);
      }
    }

    return { holders: [...holders].sort(), partial, bySource };
  }
}

async function safeHoldersFor(source: RoleHolderSource, roleKey: string): Promise<HolderLookup> {
  try {
    return await source.holdersFor(roleKey);
  } catch (err) {
    return {
      outcome: 'unavailable',
      code: 'source_error',
      message: `role-holder source ${source.id} threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
