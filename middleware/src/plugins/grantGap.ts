import type { SqlPermission } from '@omadia/plugin-api';

import type { MissingGrant } from '../api/admin-v1.js';
import type { PluginSqlGrantStore } from '../platform/pluginSqlGrantStore.js';
import type { PublicPathGrantStore } from '../platform/publicPathGrantStore.js';
import type { PluginCatalog } from './manifestLoader.js';

/**
 * Epic #470 C16 (issue #825) — the ONE derivation of "what did the manifest ask
 * for that the operator has not granted".
 *
 * WHY IT LIVES HERE
 * -----------------
 * Two surfaces answer this question and they must never disagree:
 *
 *   * `GET /api/v1/admin/runtime/installed/:id/grants` (routes/runtimeGrants.ts),
 *     the operator-facing consent panel; and
 *   * the install job's `activation_state.missing` (plugins/installService.ts),
 *     which #825 added so automation driving the install API learns the same
 *     thing the wizard learns.
 *
 * #825 exists because two answers to the same question drifted: the job said
 * `active` while the grants view said `errored` with `missing[]` populated. The
 * fix would be worth very little if it introduced a SECOND copy of the missing-
 * grant rule that could drift the same way tomorrow — a re-implementation that
 * forgets, say, the ledger-mismatch case would put the install job right back
 * to disagreeing with the panel, only more subtly.
 *
 * So the rule is computed once, here, and both callers import it. It sits in
 * `plugins/` rather than `routes/` because `installService` is a `plugins/`
 * module: importing it from a route would invert the layering and risk a cycle
 * (`runtimeGrants` already imports `plugins/installedRegistry`).
 */

/** The stores this derivation reads. All optional: a deployment without a
 *  database has no grant rows, which is not an error — it means nothing has
 *  been granted, and everything the manifest declares is missing. */
export interface GrantGapDeps {
  catalog?: PluginCatalog;
  publicPathGrantStore?: PublicPathGrantStore;
  sqlGrantStore?: PluginSqlGrantStore;
}

/** Everything the consent surfaces read, resolved once. */
export interface GrantGap {
  readonly declaredSql: SqlPermission | null;
  readonly declaredPaths: readonly string[];
  /** Every public path with a consent row, INCLUDING ones the manifest no
   *  longer declares — the caller separates granted from orphaned. */
  readonly grantedPaths: ReadonlySet<string>;
  /** The ledger actually on record, which may be one the manifest no longer
   *  declares. `null` when there is no row. */
  readonly sqlLedger: string | null;
  /** EFFECTIVE SQL consent: a row exists AND its ledger still matches the
   *  manifest. A grant for a ledger the plugin no longer declares is not
   *  consent to the one it declares now. */
  readonly sqlEffective: boolean;
  /** What the manifest asks for and the operator has not granted. */
  readonly missing: readonly MissingGrant[];
}

export function declaredSqlOf(
  deps: GrantGapDeps,
  id: string,
): SqlPermission | null {
  return deps.catalog?.get(id)?.plugin.permissions_summary?.sql ?? null;
}

export function declaredPublicPathsOf(
  deps: GrantGapDeps,
  id: string,
): readonly string[] {
  return deps.catalog?.get(id)?.plugin.permissions_summary?.public_paths ?? [];
}

/**
 * Read the manifest's declarations and both grant tables, and derive the gap
 * between them.
 *
 * Never throws: both stores already fail closed on read (a lookup that cannot
 * be satisfied answers "no grant"), and a derivation that threw would take down
 * the very surfaces that exist to explain a broken install.
 */
export async function readGrantGap(
  deps: GrantGapDeps,
  id: string,
): Promise<GrantGap> {
  const declaredSql = declaredSqlOf(deps, id);
  const declaredPaths = declaredPublicPathsOf(deps, id);

  const sqlRow = deps.sqlGrantStore
    ? await deps.sqlGrantStore.get(id)
    : undefined;
  const grantedPaths = deps.publicPathGrantStore
    ? await deps.publicPathGrantStore.listForPlugin(id)
    : new Set<string>();

  const sqlEffective =
    declaredSql !== null && sqlRow?.ledger === declaredSql.ledger;

  const missing: MissingGrant[] = [];
  if (declaredSql && !sqlEffective) {
    missing.push({ kind: 'sql', ledger: declaredSql.ledger });
  }
  for (const path of declaredPaths) {
    if (!grantedPaths.has(path)) missing.push({ kind: 'public_path', path });
  }

  return {
    declaredSql,
    declaredPaths,
    grantedPaths,
    sqlLedger: sqlRow?.ledger ?? null,
    sqlEffective,
    missing,
  };
}
