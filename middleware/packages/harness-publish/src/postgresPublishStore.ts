import type { Pool, PoolClient } from 'pg';

import type { PublishPointer, PublishVersionRecord } from './publishManifest.js';
import type { CreateVersionInput, PublishStore } from './publishStore.js';

/**
 * Postgres-backed `PublishStore` — migration `0045_publish_versions.sql`.
 *
 * Version allocation runs `SELECT ... FOR UPDATE` on the app's counter row
 * inside a transaction, so two concurrent publishes to the same `appId`
 * serialize on that row lock rather than racing for the same version
 * number — the DB-level guarantee backing the same invariant
 * `InMemoryPublishStore` gets from JS's single-threaded execution.
 * `publish_versions`'s primary key `(app_id, version)` is the second,
 * independent line of defense: even a bug in the allocator can only ever
 * fail loudly (a unique-violation) rather than silently overwrite a row.
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

  /** Row-locks (or creates) `appId`'s counter row and returns the version
   *  number to use THIS call, leaving the row set to hand out the next one
   *  after. Caller must already be inside the transaction that also inserts
   *  the version row, so a crash between the two never leaves a gap a
   *  concurrent caller could reuse. */
  private async allocateVersion(client: PoolClient, appId: string, now: Date): Promise<number> {
    const existing = await client.query<{ next_version: number }>(
      `SELECT next_version FROM publish_apps WHERE app_id = $1 FOR UPDATE`,
      [appId],
    );
    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO publish_apps (app_id, next_version, updated_at) VALUES ($1, 2, $2)`,
        [appId, now.toISOString()],
      );
      return 1;
    }
    const allocated = existing.rows[0]!.next_version;
    await client.query(`UPDATE publish_apps SET next_version = $2, updated_at = $3 WHERE app_id = $1`, [
      appId,
      allocated + 1,
      now.toISOString(),
    ]);
    return allocated;
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
