import type { Pool } from 'pg';

/**
 * Epic #470 C4 / H1 — durable operator consent for plugin public paths.
 *
 * Backs `plugin_public_path_grants` (migration 0044). The in-memory
 * `PublicPathGrantRegistry` decides routing; this decides what the operator
 * actually agreed to, and it survives a restart.
 *
 * FAIL-CLOSED, EVERY PATH
 * -----------------------
 * Reads that cannot be satisfied return the EMPTY set, never a permissive
 * default. No pool configured, table missing, database unreachable, query
 * throws — every one of those degrades to "no prefix is public", which sends
 * the request to `requireAuth` and a 401. This is the opposite of the rule
 * `postgresGrantStore` follows for DENIALS (where swallowing an error would
 * silently remove a veto): here an unread row removes an EXEMPTION, so
 * swallowing is the safe direction and being noisy about it is enough.
 */

export interface PublicPathGrantRow {
  readonly pluginId: string;
  readonly pathPrefix: string;
  readonly grantedBy: string;
  readonly grantedAt: Date;
}

export interface PublicPathGrantStore {
  /** Prefixes the operator has consented to for one plugin. */
  listForPlugin(pluginId: string): Promise<ReadonlySet<string>>;
  /** Every grant, for the admin surface. */
  listAll(): Promise<readonly PublicPathGrantRow[]>;
  /** Idempotent by primary key — re-granting refreshes who and when. */
  grant(pluginId: string, pathPrefix: string, grantedBy: string): Promise<void>;
  /** Returns true when a row was actually removed. */
  revoke(pluginId: string, pathPrefix: string): Promise<boolean>;
  /** Uninstall hook. Returns how many rows went away.
   *
   *  B6 in the epic's design notes: the existing per-plugin grant tables are
   *  never cleaned on uninstall, so a plugin that re-claims a used id silently
   *  inherits the previous one's consent. Repeating that here would mean
   *  inheriting an UNAUTHENTICATED surface, so this table does not. */
  revokeAllForPlugin(pluginId: string): Promise<number>;
}

/** The store used when no database is configured: consents to nothing, ever. */
export const NULL_PUBLIC_PATH_GRANT_STORE: PublicPathGrantStore = {
  listForPlugin: () => Promise.resolve(new Set<string>()),
  listAll: () => Promise.resolve([]),
  grant: () =>
    Promise.reject(
      new Error('public-path grants require a database — none is configured'),
    ),
  revoke: () => Promise.resolve(false),
  revokeAllForPlugin: () => Promise.resolve(0),
};

export class PostgresPublicPathGrantStore implements PublicPathGrantStore {
  constructor(private readonly pool: Pool) {}

  async listForPlugin(pluginId: string): Promise<ReadonlySet<string>> {
    try {
      const result = await this.pool.query<{ path_prefix: string }>(
        `SELECT path_prefix FROM plugin_public_path_grants WHERE plugin_id = $1`,
        [pluginId],
      );
      return new Set(result.rows.map((row) => row.path_prefix));
    } catch (err) {
      // Read failure means "no consent on record", which costs availability of
      // the plugin's public route and costs nothing in security. Loud, because
      // a persistently unreadable table looks identical to a plugin that was
      // simply never granted anything.
      console.warn(
        `[public-paths] grant lookup failed for '${pluginId}' — treating as no grants:`,
        err instanceof Error ? err.message : String(err),
      );
      return new Set<string>();
    }
  }

  async listAll(): Promise<readonly PublicPathGrantRow[]> {
    try {
      const result = await this.pool.query<{
        plugin_id: string;
        path_prefix: string;
        granted_by: string;
        granted_at: Date;
      }>(
        `SELECT plugin_id, path_prefix, granted_by, granted_at
           FROM plugin_public_path_grants
          ORDER BY plugin_id, path_prefix`,
      );
      return result.rows.map((row) => ({
        pluginId: row.plugin_id,
        pathPrefix: row.path_prefix,
        grantedBy: row.granted_by,
        grantedAt: row.granted_at,
      }));
    } catch (err) {
      console.warn(
        '[public-paths] grant listing failed — reporting none:',
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  async grant(
    pluginId: string,
    pathPrefix: string,
    grantedBy: string,
  ): Promise<void> {
    // The write path does NOT swallow: an operator clicking "grant" and getting
    // a silent no-op is the one failure mode worse than a 500 here.
    await this.pool.query(
      `INSERT INTO plugin_public_path_grants (plugin_id, path_prefix, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (plugin_id, path_prefix)
       DO UPDATE SET granted_by = EXCLUDED.granted_by, granted_at = now()`,
      [pluginId, pathPrefix, grantedBy],
    );
  }

  async revoke(pluginId: string, pathPrefix: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM plugin_public_path_grants
        WHERE plugin_id = $1 AND path_prefix = $2`,
      [pluginId, pathPrefix],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeAllForPlugin(pluginId: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM plugin_public_path_grants WHERE plugin_id = $1`,
      [pluginId],
    );
    return result.rowCount ?? 0;
  }
}

/**
 * Late-bound store.
 *
 * The pg pool is published into the service registry well AFTER plugins
 * activate, so the activation path cannot hold a `Pool` directly — it would
 * capture `undefined` and every plugin would come up with zero grants on a
 * perfectly healthy database. Resolving per call is the same late-binding
 * pattern the kernel already uses for other post-activation services, and it
 * means the database layer coming up late does not need a plugin restart to
 * take effect.
 *
 * When the pool is not (yet) available the null store answers: no grants, so
 * `requireAuth`.
 */
export function createLazyPublicPathGrantStore(
  getPool: () => Pool | undefined,
): PublicPathGrantStore {
  const resolve = (): PublicPathGrantStore => {
    const pool = getPool();
    return pool
      ? new PostgresPublicPathGrantStore(pool)
      : NULL_PUBLIC_PATH_GRANT_STORE;
  };
  return {
    listForPlugin: (pluginId) => resolve().listForPlugin(pluginId),
    listAll: () => resolve().listAll(),
    grant: (pluginId, pathPrefix, grantedBy) =>
      resolve().grant(pluginId, pathPrefix, grantedBy),
    revoke: (pluginId, pathPrefix) => resolve().revoke(pluginId, pathPrefix),
    revokeAllForPlugin: (pluginId) => resolve().revokeAllForPlugin(pluginId),
  };
}
