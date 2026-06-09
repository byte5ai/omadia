import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/**
 * Applies the memory-store schema migrations against the shared graphPool.
 *
 * Mirrors @omadia/knowledge-graph-neon's `runGraphMigrations`: a dedicated
 * `_memory_migrations` tracking table records which `.sql` files (sorted by
 * name) have already run; each unapplied file executes inside its own
 * transaction. Safe to call on every activate() — already-applied migrations
 * are skipped.
 */
export async function runMemoryMigrations(
  pool: Pool,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _memory_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (
        await client.query<{ id: string }>(
          'SELECT id FROM _memory_migrations',
        )
      ).rows.map((r) => r.id),
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log(`[memory-pg] applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _memory_migrations (id) VALUES ($1)',
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
