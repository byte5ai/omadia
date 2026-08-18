/**
 * #575 phase 2 — the durable {@link GrantStore}.
 *
 * `InMemoryGrantStore` was the only implementation, which made the audience
 * floor unusable for a real deployment in a way that is worth stating plainly:
 * the floor **fails closed**, so an empty grant table does not mean "no policy
 * configured", it means "nobody may do anything". A restart did not degrade the
 * feature — it shut every room until someone re-seeded the grants by hand.
 *
 * ## Why this class must be allowed to throw
 *
 * The `GrantStore` contract says a store that cannot answer must throw, and
 * that is the single property this file exists to preserve. `resolveCapabilities`
 * catches the throw and turns it into an `unresolved` audience member, which
 * closes the floor **with a reason**. A store that swallowed a database error
 * and returned `[]` would instead hand the floor a *smaller* capability set —
 * indistinguishable from a deliberate policy — and the intersection would
 * quietly narrow. The operator would read "the floor forbids it" and never
 * learn that Postgres was unreachable.
 *
 * So there is no try/catch on the read path here. That is not an oversight, and
 * a well-meaning "let's make this robust" edit would reintroduce the exact
 * failure the layer below was designed to make visible.
 *
 * ## It does not own the pool
 *
 * The pool is injected and never closed by this class. Issue #665 was precisely
 * this mistake elsewhere: one subsystem called `close()` on a pool that ~40
 * others shared, taking the process down with it. `close()` is not a
 * process-exit path, and a store is not the owner of its connection.
 *
 * ## Canonicalisation happens on both sides
 *
 * Writes and reads both canonicalise, with the two different rules #333 phase 1
 * established: user references lower-case, role keys keep their case. Applying
 * only one side would mean a grant written through the admin API could not be
 * found by the lookup that is supposed to honour it.
 */

import type { Pool } from 'pg';

import {
  canonicalizePrincipalRef,
  principalRef,
  type Capability,
  type GrantStore,
  type Principal,
} from '@omadia/channel-sdk';

/** One stored direct grant, as the admin surface lists it. */
export interface DirectGrantRow {
  readonly principalKind: string;
  readonly principalRef: string;
  readonly capability: Capability;
  readonly grantedBy: string;
  readonly grantedAt: Date;
}

/** One stored role grant, as the admin surface lists it. */
export interface RoleGrantRow {
  readonly roleKey: string;
  readonly capability: Capability;
  readonly grantedBy: string;
  readonly grantedAt: Date;
}

/**
 * A capability is stored verbatim apart from surrounding whitespace, matching
 * what `resolveCapabilities` does when it builds the set. Rejecting the empty
 * string at the boundary keeps a row that can never match anything out of the
 * table — the floor treats `''` as absent, so such a row would read as a grant
 * in the admin list while granting nothing.
 */
export function normalizeCapability(capability: string): string {
  return capability.trim();
}

export class PostgresGrantStore implements GrantStore {
  constructor(private readonly pool: Pool) {}

  // ── read path (hot; used by resolveCapabilities on every evaluation) ──────

  async directGrants(principal: Principal): Promise<readonly Capability[]> {
    // A role principal never has direct grants — `resolveCapabilities` refuses
    // it before reaching here, so this is defence for a direct caller rather
    // than a code path the floor takes.
    const ref = canonicalizePrincipalRef(principal.kind, principalRef(principal));
    const result = await this.pool.query<{ capability: string }>(
      `SELECT capability FROM audience_direct_grants
        WHERE principal_kind = $1 AND principal_ref = $2`,
      [principal.kind, ref],
    );
    return result.rows.map((row) => row.capability);
  }

  async roleGrants(roleKey: string): Promise<readonly Capability[]> {
    const key = canonicalizePrincipalRef('role', roleKey);
    const result = await this.pool.query<{ capability: string }>(
      `SELECT capability FROM audience_role_grants WHERE role_key = $1`,
      [key],
    );
    return result.rows.map((row) => row.capability);
  }

  // ── admin path (operator surface; never on a turn's hot path) ─────────────

  /**
   * Idempotent by primary key: re-granting an existing capability refreshes who
   * granted it and when, rather than failing. An operator re-running a seeding
   * script must not have to care whether it ran before.
   */
  async grantToPrincipal(
    principal: Principal,
    capability: string,
    grantedBy: string,
  ): Promise<void> {
    const value = normalizeCapability(capability);
    if (value.length === 0) throw new Error('capability must not be empty');
    const ref = canonicalizePrincipalRef(principal.kind, principalRef(principal));
    await this.pool.query(
      `INSERT INTO audience_direct_grants (principal_kind, principal_ref, capability, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (principal_kind, principal_ref, capability)
       DO UPDATE SET granted_by = EXCLUDED.granted_by, granted_at = now()`,
      [principal.kind, ref, value, grantedBy],
    );
  }

  async grantToRole(roleKey: string, capability: string, grantedBy: string): Promise<void> {
    const value = normalizeCapability(capability);
    if (value.length === 0) throw new Error('capability must not be empty');
    const key = canonicalizePrincipalRef('role', roleKey);
    if (key.length === 0) throw new Error('role key must not be empty');
    await this.pool.query(
      `INSERT INTO audience_role_grants (role_key, capability, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (role_key, capability)
       DO UPDATE SET granted_by = EXCLUDED.granted_by, granted_at = now()`,
      [key, value, grantedBy],
    );
  }

  /** @returns whether a row was actually removed, so the API can 404 honestly. */
  async revokeFromPrincipal(principal: Principal, capability: string): Promise<boolean> {
    const ref = canonicalizePrincipalRef(principal.kind, principalRef(principal));
    const result = await this.pool.query(
      `DELETE FROM audience_direct_grants
        WHERE principal_kind = $1 AND principal_ref = $2 AND capability = $3`,
      [principal.kind, ref, normalizeCapability(capability)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeFromRole(roleKey: string, capability: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM audience_role_grants WHERE role_key = $1 AND capability = $2`,
      [canonicalizePrincipalRef('role', roleKey), normalizeCapability(capability)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listDirectGrants(): Promise<DirectGrantRow[]> {
    const result = await this.pool.query<{
      principal_kind: string;
      principal_ref: string;
      capability: string;
      granted_by: string;
      granted_at: Date;
    }>(
      `SELECT principal_kind, principal_ref, capability, granted_by, granted_at
         FROM audience_direct_grants
        ORDER BY principal_kind, principal_ref, capability`,
    );
    return result.rows.map((row) => ({
      principalKind: row.principal_kind,
      principalRef: row.principal_ref,
      capability: row.capability,
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
    }));
  }

  async listRoleGrants(): Promise<RoleGrantRow[]> {
    const result = await this.pool.query<{
      role_key: string;
      capability: string;
      granted_by: string;
      granted_at: Date;
    }>(
      `SELECT role_key, capability, granted_by, granted_at
         FROM audience_role_grants
        ORDER BY role_key, capability`,
    );
    return result.rows.map((row) => ({
      roleKey: row.role_key,
      capability: row.capability,
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
    }));
  }
}
