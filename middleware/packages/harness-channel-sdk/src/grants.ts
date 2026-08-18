/**
 * #575 Phase 2 — grants: the mapping from a Principal to the capabilities the
 * audience floor intersects.
 *
 * The floor (`audienceFloor.ts`) intersects capability *sets*; this is where a
 * set comes from. Two independent ways to hold a capability, deliberately kept
 * separate:
 *
 *  - a **direct grant** to a `user:` principal, and
 *  - a **role grant**, held by everyone who currently holds that role.
 *
 * Role grants are why #333 had to land first. A principal's capabilities are
 * the union of their direct grants and the grants of every role they hold, and
 * "every role they hold" is exactly what `RoleSourceRegistry` answers.
 *
 * ## Union here, intersection there — and both are deliberate
 *
 * Within one principal, capabilities UNION: holding two roles gives you the
 * powers of both. Across the audience they INTERSECT: a room may only do what
 * everyone in it may do. Getting these backwards in either direction is a
 * privilege bug, so they live in separate modules with the reasoning stated in
 * both.
 *
 * ## A partial role lookup must not produce a capability set
 *
 * #333 phase 2 made "we could not read a role source" a distinct outcome rather
 * than an empty list. That distinction has to survive the trip here, because a
 * capability set built from partially-known roles is a LOWER BOUND — and the
 * floor cannot tell a lower bound from a real answer once it is just a `Set`.
 *
 * Reading it as a real answer fails in the direction that matters:
 *
 *  - too few capabilities for a member → the intersection is too small → the
 *    room is over-restricted. Annoying, and safe.
 *  - but the same shrunken set is indistinguishable from a deliberate policy,
 *    so an operator sees "the floor forbids it" and never learns a directory
 *    was down.
 *
 * So {@link resolveCapabilities} refuses: a partial role lookup yields
 * `undefined`, which `resolveAudience` turns into an `unresolved` member, which
 * closes the floor with a reason an operator can act on.
 */

import type { Capability, ResolvedAudienceMember } from './audienceFloor.js';
import { canonicalizePrincipalRef, principalRef, type Principal } from './principal.js';
import type { RoleSourceRegistry } from './roleSource.js';

/**
 * Where capability grants are read from.
 *
 * Intentionally two narrow lookups rather than one "give me everything" call:
 * the role side is fanned out over however many roles a principal holds, and a
 * store backed by SQL wants to see them as separate, cacheable questions.
 *
 * Implementations live outside this package. A store that cannot answer must
 * **throw** — {@link resolveCapabilities} converts that into a closed floor
 * rather than a silently smaller one.
 */
export interface GrantStore {
  /** Capabilities granted directly to this principal. */
  directGrants(principal: Principal): Promise<readonly Capability[]>;
  /** Capabilities granted to a role, held by whoever currently holds it. */
  roleGrants(roleKey: string): Promise<readonly Capability[]>;
}

/**
 * Resolve one principal into the audience member the floor consumes.
 *
 * Returns `undefined` — meaning "unresolved", which closes the floor — when the
 * answer would be a lower bound rather than a fact:
 *
 *  - the principal's role lookup came back `partial` (a role source was down),
 *  - or the grant store threw.
 *
 * Both are outages, and an outage must not read as policy.
 *
 * A `role:` principal is not an audience member: rooms contain people, and
 * #333's registry already refuses to resolve roles-of-a-role. Passing one is a
 * caller error, so it resolves to `undefined` rather than being quietly
 * expanded into its holders — expansion is `RoleHolderRegistry`'s job and doing
 * it here would hide which of the two happened.
 */
export async function resolveCapabilities(
  principal: Principal,
  roles: RoleSourceRegistry,
  grants: GrantStore,
): Promise<ResolvedAudienceMember | undefined> {
  if (principal.kind !== 'user') return undefined;

  try {
    const roleLookup = await roles.resolveRoles(principal);
    // A lower bound is not an answer. See the module header.
    if (roleLookup.partial) return undefined;

    const capabilities = new Set<Capability>();
    for (const capability of await grants.directGrants(principal)) {
      const trimmed = capability.trim();
      if (trimmed.length > 0) capabilities.add(trimmed);
    }

    // Role keys keep their case (#333 phase 1: `createRole` writes them
    // verbatim), so they are canonicalized with the ROLE rule before lookup —
    // lowercasing here would miss every mixed-case grant row.
    const perRole = await Promise.all(
      roleLookup.roles.map((role) => grants.roleGrants(canonicalizePrincipalRef('role', role))),
    );
    for (const granted of perRole) {
      for (const capability of granted) {
        const trimmed = capability.trim();
        if (trimmed.length > 0) capabilities.add(trimmed);
      }
    }

    return { principal, capabilities };
  } catch {
    // Deliberately swallowed here and surfaced as `unresolved` by the caller:
    // the floor's `closed` reason is the operator-facing signal, and letting
    // this reject would take down the turn instead of restricting it.
    return undefined;
  }
}

/**
 * An in-memory {@link GrantStore}, for tests and for deployments that configure
 * grants declaratively rather than in a database.
 *
 * Direct grants are keyed by the principal's canonical wire form so a
 * differently-cased id cannot miss its own grants; role grants are keyed by the
 * role key with its case intact, matching `conductor_roles`.
 */
export class InMemoryGrantStore implements GrantStore {
  private readonly direct = new Map<string, Set<Capability>>();
  private readonly byRole = new Map<string, Set<Capability>>();

  grantToPrincipal(principal: Principal, ...capabilities: Capability[]): this {
    const key = principalKey(principal);
    const set = this.direct.get(key) ?? new Set<Capability>();
    for (const c of capabilities) set.add(c);
    this.direct.set(key, set);
    return this;
  }

  grantToRole(roleKey: string, ...capabilities: Capability[]): this {
    const key = canonicalizePrincipalRef('role', roleKey);
    const set = this.byRole.get(key) ?? new Set<Capability>();
    for (const c of capabilities) set.add(c);
    this.byRole.set(key, set);
    return this;
  }

  async directGrants(principal: Principal): Promise<readonly Capability[]> {
    return [...(this.direct.get(principalKey(principal)) ?? [])];
  }

  async roleGrants(roleKey: string): Promise<readonly Capability[]> {
    return [...(this.byRole.get(canonicalizePrincipalRef('role', roleKey)) ?? [])];
  }
}

function principalKey(principal: Principal): string {
  return `${principal.kind}:${canonicalizePrincipalRef(principal.kind, principalRef(principal))}`;
}
