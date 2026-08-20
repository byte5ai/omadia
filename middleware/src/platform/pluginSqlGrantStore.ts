import type { Pool } from 'pg';

/**
 * Epic #470 C7 / G4 — durable operator consent for plugin-owned SQL schema.
 *
 * Backs `plugin_sql_grants` (migration 0047). Sibling of C4's
 * `publicPathGrantStore` and it follows the same rules for the same reasons;
 * the differences below are the ones worth knowing.
 *
 * FAIL-CLOSED ON READ
 * -------------------
 * Every read that cannot be satisfied returns "no grant", never a permissive
 * default. No pool, table missing, database unreachable, query throws — all of
 * them mean `ctx.services.get('graphPool')` throws and `ctx.sql` is undefined.
 * An unread row here removes a PERMISSION, so swallowing the error costs the
 * plugin its database access and costs the operator nothing; the inverse would
 * hand out a pool on the strength of a failed query.
 *
 * The reads are noisy about it, because a persistently unreadable table looks
 * exactly like a plugin that was simply never granted anything, and those two
 * need very different fixes.
 *
 * NOT FAIL-CLOSED ON WRITE
 * ------------------------
 * `grant` does not swallow. An operator who clicks "grant" and gets a silent
 * no-op is the one failure mode worse than a 500 — they would go on believing
 * the plugin is provisioned.
 *
 * `grant` also surfaces the `UNIQUE (ledger)` violation rather than hiding it:
 * a second plugin asking for a ledger someone already owns is precisely the
 * hijack attempt the constraint exists to stop, and the operator must see it.
 */

export interface PluginSqlGrantRow {
  readonly pluginId: string;
  readonly ledger: string;
  readonly grantedBy: string;
  readonly grantedAt: Date;
}

export interface PluginSqlGrantStore {
  /** The grant on record for one plugin, or undefined when there is none. */
  get(pluginId: string): Promise<PluginSqlGrantRow | undefined>;
  /** Every grant, for the admin surface. */
  listAll(): Promise<readonly PluginSqlGrantRow[]>;
  /** Idempotent for the same (plugin, ledger) — re-granting refreshes who and
   *  when. Rejects when another plugin already owns `ledger`. */
  grant(pluginId: string, ledger: string, grantedBy: string): Promise<void>;
  /**
   * Returns true when a row was actually removed.
   *
   * REVOCATION TAKES EFFECT AT THE NEXT ACTIVATION, NOT IMMEDIATELY.
   *
   * The grant is read once, before the plugin's context is built, because
   * `ctx.services.get` is synchronous and cannot await a lookup (see
   * `CreatePluginContextOptions.sqlGranted`). A plugin that is already live
   * therefore keeps the `ctx.sql` accessor and the pool it resolved for the
   * rest of the process — deleting this row does not reach into it.
   *
   * So `revoke()` stops the NEXT activation, and an operator who needs access
   * to stop now must deactivate and reactivate the plugin (or restart the
   * middleware). This is a real property of the design and not an oversight;
   * it is documented here rather than in a design note because this method is
   * where an operator-facing caller meets it. `pluginSqlPermission.test.ts`
   * pins the behaviour so a change to it has to be deliberate.
   */
  revoke(pluginId: string): Promise<boolean>;
}

/** Thrown when a plugin asks for a ledger another plugin already owns. Typed
 *  so the admin surface can say "taken" instead of surfacing a raw 23505. */
export class LedgerAlreadyOwnedError extends Error {
  public readonly ledger: string;
  constructor(ledger: string) {
    super(
      `ledger table '${ledger}' is already granted to another plugin — one ledger belongs to exactly one plugin, or their migration histories would overwrite each other`,
    );
    this.name = 'LedgerAlreadyOwnedError';
    this.ledger = ledger;
  }
}

/** The store used when no database is configured: consents to nothing, ever.
 *  Without a database there is no pool to hand out either, so this is the
 *  consistent answer rather than a degraded one. */
export const NULL_PLUGIN_SQL_GRANT_STORE: PluginSqlGrantStore = {
  get: () => Promise.resolve(undefined),
  listAll: () => Promise.resolve([]),
  grant: () =>
    Promise.reject(
      new Error('plugin SQL grants require a database — none is configured'),
    ),
  revoke: () => Promise.resolve(false),
};

export class PostgresPluginSqlGrantStore implements PluginSqlGrantStore {
  constructor(private readonly pool: Pool) {}

  async get(pluginId: string): Promise<PluginSqlGrantRow | undefined> {
    try {
      const result = await this.pool.query<GrantRowShape>(
        `SELECT plugin_id, ledger, granted_by, granted_at
           FROM plugin_sql_grants
          WHERE plugin_id = $1`,
        [pluginId],
      );
      const row = result.rows[0];
      return row ? toRow(row) : undefined;
    } catch (err) {
      console.warn(
        `[plugin-sql] grant lookup failed for '${pluginId}' — treating as ungranted:`,
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  async listAll(): Promise<readonly PluginSqlGrantRow[]> {
    try {
      const result = await this.pool.query<GrantRowShape>(
        `SELECT plugin_id, ledger, granted_by, granted_at
           FROM plugin_sql_grants
          ORDER BY plugin_id`,
      );
      return result.rows.map(toRow);
    } catch (err) {
      console.warn(
        '[plugin-sql] grant listing failed — reporting none:',
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  async grant(
    pluginId: string,
    ledger: string,
    grantedBy: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO plugin_sql_grants (plugin_id, ledger, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (plugin_id)
         DO UPDATE SET ledger = EXCLUDED.ledger,
                       granted_by = EXCLUDED.granted_by,
                       granted_at = now()`,
        [pluginId, ledger, grantedBy],
      );
    } catch (err) {
      // 23505 on this statement can only be the `UNIQUE (ledger)` index: the
      // plugin_id conflict is handled by ON CONFLICT above, so the sole
      // remaining unique constraint is ledger ownership.
      if ((err as { code?: unknown } | null)?.code === '23505') {
        throw new LedgerAlreadyOwnedError(ledger);
      }
      throw err;
    }
  }

  async revoke(pluginId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM plugin_sql_grants WHERE plugin_id = $1`,
      [pluginId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

/**
 * A store that resolves `graphPool` from the service registry on every call.
 *
 * `ToolPluginRuntime` is constructed ~600 lines before `graphPool` exists —
 * the pool is published by a PLUGIN, which this very runtime activates. A
 * store captured at construction time would therefore always be the null one.
 * Resolving per call defers the question to activate time, by which point the
 * topological order has already brought the provider up.
 *
 * A plugin that activates BEFORE the pool provider (or before migration 0047
 * has been applied by `runMultiOrchestratorMigrations`) reads no grant and is
 * treated as ungranted. That is the fail-closed direction and it self-corrects
 * on the next boot, when the ordering has settled.
 */
export function createServiceRegistryBackedSqlGrantStore(
  resolvePool: () => Pool | undefined,
): PluginSqlGrantStore {
  const delegate = (): PluginSqlGrantStore => {
    const pool = resolvePool();
    return pool
      ? new PostgresPluginSqlGrantStore(pool)
      : NULL_PLUGIN_SQL_GRANT_STORE;
  };
  return {
    get: (pluginId) => delegate().get(pluginId),
    listAll: () => delegate().listAll(),
    grant: (pluginId, ledger, grantedBy) =>
      delegate().grant(pluginId, ledger, grantedBy),
    revoke: (pluginId) => delegate().revoke(pluginId),
  };
}

interface GrantRowShape {
  plugin_id: string;
  ledger: string;
  granted_by: string;
  granted_at: Date;
}

function toRow(row: GrantRowShape): PluginSqlGrantRow {
  return {
    pluginId: row.plugin_id,
    ledger: row.ledger,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
  };
}
