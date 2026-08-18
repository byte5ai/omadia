/**
 * #333 Phase 2 — role and attribute sources: "what is this Principal entitled to?"
 *
 * Phase 1 gave the platform a `Principal` — a typed answer to *who*. This is
 * the other half of the question `specs/575-scope-and-identity-foundation/spec.md`
 * §6 assigns to #333:
 *
 * > **#333 answers "who is this, and what are they entitled to?"**
 * > **#333 produces Principals. #575 consumes Principals and produces decisions.**
 *
 * So this file resolves **facts about a principal** — the roles an Entra group
 * membership or an Odoo HR record confers. It never decides whether those roles
 * permit anything. The audience floor, grants and per-recipient filtering are
 * #575's, and they consume what this returns.
 *
 * ## Shape borrowed from `ProviderRegistry`, and why the split matters MORE here
 *
 * `auth/providerRegistry.ts` separates a **catalog** (the superset an operator
 * allowed via env) from the **active registry** (what the admin UI switched on),
 * so "a compromised admin can never enable a provider the operator didn't
 * intend". A role source is strictly more dangerous than an auth provider: an
 * auth provider decides *whether you get in*, a role source decides *what you
 * are once inside*. Silently registering one is privilege escalation with no
 * login event to notice. The same two-tier gate is therefore mandatory here,
 * not decorative.
 *
 * ## The one property everything else hangs on: absence is a TYPE
 *
 * `rolesFor` never returns a bare array. An empty array and "the directory was
 * unreachable" are different facts, and collapsing them is an authorization bug
 * in whichever direction the caller happens to guess:
 *
 *  - Read as *"this user has no roles"*, an unreachable Entra tenant quietly
 *    strips every entitlement — a self-inflicted outage that looks like policy.
 *  - Read as *"unknown, so allow"*, it is a silent full grant.
 *
 * `RoleLookup` forces the caller to see the difference, and
 * {@link AggregateRoleLookup.partial} carries it through aggregation so a
 * consumer cannot accidentally treat a half-answered lookup as complete. This
 * is the same reasoning that made `ScopeId`'s `unscoped` and `Principal`'s
 * `undefined` types rather than values.
 */

import { canonicalizePrincipalRef, type Principal } from './principal.js';

/** Why a source could not answer. Never means "the principal has no roles". */
export type RoleLookupUnavailableCode =
  /** The backing directory/API failed, timed out, or refused the read. */
  | 'source_error'
  /** The source is registered but not configured enough to answer yet. */
  | 'not_configured'
  /** The source does not know this principal at all (no record, not an error). */
  | 'unknown_principal';

/**
 * One source's answer about one principal.
 *
 * `resolved` with an empty `roles` array is a real, trustworthy answer: the
 * source knows this principal and confers nothing. That is NOT the same as
 * `unavailable`.
 */
export type RoleLookup =
  | { readonly outcome: 'resolved'; readonly roles: readonly string[] }
  | {
      readonly outcome: 'unavailable';
      readonly code: RoleLookupUnavailableCode;
      /** Operator-readable. Belongs in logs, never in an HTTP body. */
      readonly message: string;
    };

/**
 * A pluggable origin of role/attribute facts — Entra group membership, an Odoo
 * HR record, a local table.
 *
 * Mirrors `AuthProvider`: a stable `id` the registry keys on, a `displayName`
 * for operator surfaces, and one async method. Implementations live outside
 * this package (`middleware/src`), so this file stays dependency-free and
 * importable from the orchestrator, the kernel and the middleware alike.
 */
export interface RoleSource {
  readonly id: string;
  readonly displayName: string;
  /**
   * Roles this source confers on `principal`.
   *
   * Implementations should **return** `unavailable` rather than throw, but the
   * registry defends against throwing anyway — a source that rejects must not
   * be able to take down a turn (see {@link RoleSourceRegistry.resolveRoles}).
   */
  rolesFor(principal: Principal): Promise<RoleLookup>;
}

/**
 * The combined answer across every active source.
 *
 * `partial` is the field that matters. It is `true` when at least one source
 * could not answer, which means `roles` is a LOWER BOUND and nothing may be
 * concluded from a role's absence. A consumer that ignores it will eventually
 * deny a legitimate action during a directory outage, or — worse — treat the
 * empty set as "no restrictions apply".
 */
export interface AggregateRoleLookup {
  /** Canonical, de-duplicated, sorted. Sorted so results are comparable. */
  readonly roles: readonly string[];
  /** True iff at least one active source failed to answer. */
  readonly partial: boolean;
  /** Per-source outcome, in registration order. For operator diagnostics. */
  readonly bySource: readonly { readonly sourceId: string; readonly lookup: RoleLookup }[];
}

/**
 * The superset of sources the operator allowed. Built once at boot from
 * configuration and immutable thereafter — the admin UI may only activate
 * something that already exists here.
 */
export class RoleSourceCatalog {
  private readonly sources = new Map<string, RoleSource>();

  add(source: RoleSource): void {
    if (this.sources.has(source.id)) {
      throw new Error(`role-source catalog id collision: ${source.id} already added`);
    }
    this.sources.set(source.id, source);
  }

  get(id: string): RoleSource | undefined {
    return this.sources.get(id);
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  list(): RoleSource[] {
    return Array.from(this.sources.values());
  }
}

/**
 * The currently-active sources, in registration order.
 *
 * Activation goes through {@link RoleSourceRegistry.activate}, which takes the
 * catalog as its gate — there is deliberately no way to register an arbitrary
 * object. `register` exists for boot-time wiring and tests, where the caller
 * already holds the instance it intends to trust.
 */
export class RoleSourceRegistry {
  private readonly sources = new Map<string, RoleSource>();

  register(source: RoleSource): void {
    if (this.sources.has(source.id)) {
      throw new Error(`role-source id collision: ${source.id} already registered`);
    }
    this.sources.set(source.id, source);
  }

  /**
   * Activate a catalogued source by id. Returns false when the id is not in the
   * catalog — the operator gate. Callers must treat `false` as "refused", never
   * retry by constructing the source themselves.
   */
  activate(catalog: RoleSourceCatalog, id: string): boolean {
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

  list(): RoleSource[] {
    return Array.from(this.sources.values());
  }

  size(): number {
    return this.sources.size;
  }

  /**
   * Ask every active source about `principal` and merge the answers.
   *
   * Three deliberate behaviours:
   *
   *  1. **A `role:` principal short-circuits.** Asking "what roles does this
   *     role have?" is a category error — a role is an indirection over
   *     holders, not a subject with entitlements. Resolving it here would
   *     invite a source to invent an answer, and role nesting is a design
   *     decision #575 has not made. It resolves to no roles, with no source
   *     consulted, so the outcome is `resolved` and NOT `partial`: this is a
   *     complete answer, not a failed one.
   *  2. **Sources run concurrently.** They are independent network reads on a
   *     turn's hot path; serialising them would add every directory's latency
   *     together.
   *  3. **A throwing source becomes `unavailable`, never an exception.** One
   *     misbehaving directory must not fail the turn — but it must also not
   *     vanish, so it lands in `bySource` and sets `partial`.
   */
  async resolveRoles(principal: Principal): Promise<AggregateRoleLookup> {
    if (principal.kind === 'role') {
      return { roles: [], partial: false, bySource: [] };
    }

    const active = this.list();
    const bySource = await Promise.all(
      active.map(async (source) => ({
        sourceId: source.id,
        lookup: await safeRolesFor(source, principal),
      })),
    );

    const roles = new Set<string>();
    let partial = false;
    for (const { lookup } of bySource) {
      if (lookup.outcome === 'unavailable') {
        partial = true;
        continue;
      }
      for (const role of lookup.roles) {
        // Canonicalized with the `role` rule — trim only. Lowercasing here
        // would stop matching the mixed-case keys `createRole` writes verbatim
        // (see `principal.ts`), which is how a role silently stops resolving.
        const canonical = canonicalizePrincipalRef('role', role);
        if (canonical.length > 0) roles.add(canonical);
      }
    }

    return { roles: [...roles].sort(), partial, bySource };
  }
}

async function safeRolesFor(source: RoleSource, principal: Principal): Promise<RoleLookup> {
  try {
    return await source.rolesFor(principal);
  } catch (err) {
    return {
      outcome: 'unavailable',
      code: 'source_error',
      message: `role source ${source.id} threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
