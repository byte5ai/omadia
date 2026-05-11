import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/**
 * Apply pending profile-snapshot SQL migrations against the shared
 * Postgres pool. Tracking happens in `_profile_snapshot_migrations` so
 * the lifecycle is independent of `_auth_migrations` /
 * `_profile_storage_migrations` / `_graph_migrations` — snapshots evolve
 * with the bundle/lifecycle stack, not with auth or graph.
 *
 * Mirrors `runAuthMigrations` and `runProfileStorageMigrations` line for
 * line so the migrators stay diff-comparable.
 */
export async function runProfileSnapshotMigrations(
  pool: Pool,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _profile_snapshot_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (
        await client.query<{ id: string }>(
          'SELECT id FROM _profile_snapshot_migrations',
        )
      ).rows.map((r) => r.id),
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log(`[profile-snapshot] applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _profile_snapshot_migrations (id) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}
