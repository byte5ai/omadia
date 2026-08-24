import type { Pool, PoolClient } from 'pg';

import type { PublishPointer, PublishVersionRecord } from './publishManifest.js';
import type { CreateVersionInput, PublishStore } from './publishStore.js';

/**
 * Postgres-backed `PublishStore` — migration `0045_publish_versions.sql`.
 *
 * Version allocation is ONE statement — an upsert on the app's counter row
 * that returns the number it just consumed — so two concurrent publishes to
 * the same `appId` serialize on that row's lock rather than racing for the
 * same version number. That is the DB-level guarantee backing the invariant
 * `InMemoryPublishStore` gets for free from JS's single-threaded execution.
 * `publish_versions`'s primary key `(app_id, version)` is the second,
 * independent line of defense: even a bug in the allocator can only ever
 * fail loudly (a unique-violation) rather than silently overwrite a row.
 *
 * WHY ONE STATEMENT (issue #834)
 * ------------------------------
 * The allocator used to read the counter with `SELECT ... FOR UPDATE` and
 * then, when that returned nothing, `INSERT` the row. `FOR UPDATE` locks the
 * rows it finds, and on the first publish for an app there is no row to find
 * — so it locked NOTHING and every concurrent caller fell through to the
 * same bare `INSERT`. One won; the rest died on `publish_apps_pkey`. It read
 * as an intermittent CI flake because it needs two publishes to a brand-new
 * app to overlap; with eight racing callers it reproduces every time.
 *
 * A read-modify-write cannot be made safe by locking harder at the read: the
 * row whose absence is the problem is the row the lock has nothing to hold.
 * So the read-modify-write is gone. `ON CONFLICT ... DO UPDATE` is the one
 * form Postgres documents as an atomic insert-or-update: a caller that finds
 * the row missing and a caller that finds it present take the same code path,
 * and a caller arriving while another's insert is still uncommitted waits for
 * that transaction and then updates the row it committed.
 *
 * Two alternatives were considered and rejected:
 *
 *   - **`ON CONFLICT DO NOTHING`, then `SELECT ... FOR UPDATE`.** Correct on
 *     PG16 (verified: `DO NOTHING` really does wait out the conflicting
 *     transaction, so the follow-up SELECT sees a committed row), but it is
 *     three statements where one suffices, and its correctness rests on
 *     speculative-insertion wait semantics that a future reader cannot check
 *     by reading the query. Atomic-by-construction beats atomic-if-you-know.
 *
 *   - **`pg_advisory_xact_lock(ns, hashtext(app_id))`** around the original
 *     read-modify-write, the shape core migrators use (namespace 4410) and
 *     `embeddingModelGate` uses (4401). Those lock a *concept* with no row of
 *     its own; here the contended thing already IS a row with a primary key,
 *     so the row lock is both free and exact. An advisory lock would key on
 *     `hashtext` of a caller-supplied app id, which makes two unrelated apps
 *     whose ids collide serialize against each other — the same "hash
 *     collision as an availability lever" that `pluginMigrations.ts` gives a
 *     whole namespace to avoid. Cheaper and stricter to lock the row itself.
 */
export class PostgresPublishStore implements PublishStore {
  constructor(private readonly pool: Pool) {}

  async createVersion(input: CreateVersionInput): Promise<PublishVersionRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const allocated = await this.allocateVersion(client, input.appId, input.now);
      await client.query(
        `INSERT INTO publish_versions (app_id, version, name, entrypoint, dir_hash, source_scope_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [input.appId, allocated, input.name, input.entrypoint, input.dirHash, input.sourceScopeKey, input.now.toISOString()],
      );
      await client.query('COMMIT');
      return {
        appId: input.appId,
        version: allocated,
        name: input.name,
        entrypoint: input.entrypoint,
        dirHash: input.dirHash,
        sourceScopeKey: input.sourceScopeKey,
        createdAt: input.now,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Consumes `appId`'s next version number and returns it, creating the
   * counter row on first publish. Atomic and race-free by construction — see
   * the class header for why this is one statement and not a read-then-write.
   *
   * Both branches advance the counter by exactly one and return the value it
   * held before: a fresh row is written straight to 2 (having handed out 1),
   * an existing row goes to `next_version + 1`. `RETURNING next_version - 1`
   * reads the post-action row, so the same expression is correct either way.
   *
   * Caller must already be inside the transaction that also inserts the
   * version row. That is what makes the number gapless: the upsert holds the
   * counter row's lock until that transaction ends, so a concurrent allocator
   * cannot pass it, and a rollback returns the number to the pool instead of
   * retiring it with no `publish_versions` row to show for it.
   */
  private async allocateVersion(client: PoolClient, appId: string, now: Date): Promise<number> {
    const result = await client.query<{ allocated: number }>(
      `INSERT INTO publish_apps (app_id, next_version, updated_at)
       VALUES ($1, 2, $2)
       ON CONFLICT (app_id) DO UPDATE SET
         next_version = publish_apps.next_version + 1,
         updated_at = EXCLUDED.updated_at
       RETURNING next_version - 1 AS allocated`,
      [appId, now.toISOString()],
    );
    return result.rows[0]!.allocated;
  }

  async getVersion(appId: string, version: number): Promise<PublishVersionRecord | undefined> {
    const result = await this.pool.query<VersionRow>(
      `SELECT app_id, version, name, entrypoint, dir_hash, source_scope_key, created_at
       FROM publish_versions WHERE app_id = $1 AND version = $2`,
      [appId, version],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async listVersions(appId: string): Promise<readonly PublishVersionRecord[]> {
    const result = await this.pool.query<VersionRow>(
      `SELECT app_id, version, name, entrypoint, dir_hash, source_scope_key, created_at
       FROM publish_versions WHERE app_id = $1 ORDER BY version ASC`,
      [appId],
    );
    return result.rows.map(rowToRecord);
  }

  async getPointer(appId: string): Promise<PublishPointer | undefined> {
    const result = await this.pool.query<{ app_id: string; current_version: number | null; updated_at: Date }>(
      `SELECT app_id, current_version, updated_at FROM publish_apps WHERE app_id = $1`,
      [appId],
    );
    const row = result.rows[0];
    if (!row || row.current_version === null) return undefined;
    return { appId: row.app_id, currentVersion: row.current_version, updatedAt: new Date(row.updated_at) };
  }

  async setPointer(appId: string, version: number, now: Date): Promise<PublishPointer> {
    // `publish_apps` already has a row for `appId` by the time any version
    // exists to point at (created by `allocateVersion`), but a caller could
    // in principle set a pointer without ever having published through
    // THIS store instance (e.g. a restored backup) — ON CONFLICT keeps
    // this safe either way. The composite FK to `publish_versions` (see the
    // migration) is what actually enforces "version must exist", not this
    // query.
    const result = await this.pool.query<{ app_id: string; current_version: number; updated_at: Date }>(
      `INSERT INTO publish_apps (app_id, next_version, current_version, updated_at)
       VALUES ($1, $2 + 1, $2, $3)
       ON CONFLICT (app_id) DO UPDATE SET
         current_version = EXCLUDED.current_version,
         next_version = GREATEST(publish_apps.next_version, EXCLUDED.next_version),
         updated_at = EXCLUDED.updated_at
       RETURNING app_id, current_version, updated_at`,
      [appId, version, now.toISOString()],
    );
    const row = result.rows[0]!;
    return { appId: row.app_id, currentVersion: row.current_version, updatedAt: new Date(row.updated_at) };
  }
}

interface VersionRow {
  app_id: string;
  version: number;
  name: string;
  entrypoint: string;
  dir_hash: string;
  source_scope_key: string;
  created_at: Date;
}

function rowToRecord(row: VersionRow): PublishVersionRecord {
  return {
    appId: row.app_id,
    version: row.version,
    name: row.name,
    entrypoint: row.entrypoint,
    dirHash: row.dir_hash,
    sourceScopeKey: row.source_scope_key,
    createdAt: new Date(row.created_at),
  };
}
