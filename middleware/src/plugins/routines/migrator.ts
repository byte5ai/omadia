import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/**
 * Apply pending routines-plugin SQL migrations against the shared Neon pool.
 * Tracks applied files in `_routine_migrations` so the lifecycle is
 * independent of the knowledge-graph migrator (different package, different
 * schema-evolution cadence). Idempotent: each file is wrapped in a
 * transaction and recorded only on commit, so a partial failure leaves the
 * tracking table consistent.
 */
export async function runRoutineMigrations(
  pool: Pool,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _routine_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (
        await client.query<{ id: string }>(
          'SELECT id FROM _routine_migrations',
        )
      ).rows.map((r) => r.id),
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log(`[routines] applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _routine_migrations (id) VALUES ($1)',
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
