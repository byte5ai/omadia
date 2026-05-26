import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

/**
 * Resolve the `migrations/` directory from this file's location. The path
 * converges on the right location in both layouts via four `..` steps:
 *
 *   - Local dev   `<repo>/middleware/packages/harness-orchestrator/src/registry/migrator.ts`
 *                  → `<repo>/middleware/migrations/`
 *   - Docker      `/app/packages/harness-orchestrator/dist/registry/migrator.js`
 *                  → `/app/migrations/`
 *
 * The Docker layout has no `middleware/` segment (the runtime image makes
 * the middleware dir the workdir root), so the Dockerfile must
 * `COPY middleware/migrations ./migrations`. The `MULTI_ORCH_MIGRATIONS_DIR`
 * env var overrides the default for tests that want a fixture dir.
 */
function defaultMigrationsDir(): string {
  const override = process.env['MULTI_ORCH_MIGRATIONS_DIR'];
  if (override) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', 'migrations');
}

/**
 * Apply pending multi-orchestrator-runtime SQL migrations.
 *
 * Mirrors `runAuthMigrations` / `runGraphMigrations` / `runRoutineMigrations`
 * line for line so the four migrators stay diff-comparable. Bookkeeping table
 * `_multi_orchestrator_migrations` is independent of the other three because
 * the multi-orchestrator schema has its own evolution cadence.
 *
 * Each file is wrapped in a transaction and recorded only on commit, so a
 * partial failure leaves the tracking table consistent.
 */
export async function runMultiOrchestratorMigrations(
  pool: Pool,
  log: (msg: string) => void = () => undefined,
  migrationsDir: string = defaultMigrationsDir(),
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _multi_orchestrator_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (
        await client.query<{ id: string }>(
          'SELECT id FROM _multi_orchestrator_migrations',
        )
      ).rows.map((r) => r.id),
    );

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      log(`[multi-orchestrator] applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _multi_orchestrator_migrations (id) VALUES ($1)',
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
