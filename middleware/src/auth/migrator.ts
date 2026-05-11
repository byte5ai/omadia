import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/**
 * Apply pending auth-subsystem SQL migrations against the shared Postgres
 * pool. Tracking happens in `_auth_migrations` so the lifecycle is fully
 * independent of `_graph_migrations` and `_routine_migrations` — auth has
 * a different schema-evolution cadence (rare, security-sensitive bumps)
 * than the knowledge-graph (frequent, additive).
 *
 * Idempotent: each file is wrapped in a transaction and recorded only on
 * commit, so a partial failure leaves the tracking table consistent.
 *
 * Mirrors `runGraphMigrations` and `runRoutineMigrations` line for line so
 * the three migrators stay diff-comparable.
 */
export async function runAuthMigrations(
  pool: Pool,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _auth_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (
        await client.query<{ id: string }>(
          'SELECT id FROM _auth_migrations',
        )
      ).rows.map((r) => r.id),
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log(`[auth] applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _auth_migrations (id) VALUES ($1)',
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
