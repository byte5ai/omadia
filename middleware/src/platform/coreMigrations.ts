import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

/**
 * Core's own base schema, applied by core (#796, epic #470 C9 / G3).
 *
 * WHAT WAS WRONG
 * --------------
 * `middleware/migrations/` is a core-owned directory — 47 files, including
 * `0046_plugin_public_path_grants.sql` (C4's operator-consent table for
 * plugin public paths) and `0047_plugin_sql_grants.sql` (C7's operator-consent
 * table for plugin SQL access). Its only production caller was the
 * harness-orchestrator plugin's `activate()`, several hundred lines after an
 * early return:
 *
 *     const provider = await resolveLlmProvider(...);
 *     if (!provider) return { async close() {...} };   // <- ledger never runs
 *
 * So on a deployment with no LLM provider key, core had no schema. Not a
 * degraded one — none. `_multi_orchestrator_migrations` did not exist,
 * neither grant table existed, and recording either consent was structurally
 * impossible. The failure was silent by construction: nothing logged a
 * migration error because no migration was ever attempted.
 *
 * THE RULE
 * --------
 * Core's schema is core's responsibility, and it cannot be conditional on a
 * plugin choosing to activate, let alone on a credential unrelated to it.
 * This runs at boot, before any tool plugin activates, whatever the provider
 * configuration is.
 *
 * WHY ITS OWN POOL
 * ----------------
 * `graphPool` is published into the service registry by the knowledge-graph
 * plugin during `activateAllInstalled()` — i.e. after the point where these
 * tables must already exist, since the SQL-grant gate reads a grant row while
 * building each plugin's context. Waiting for that pool would reintroduce the
 * same defect one layer up: core's schema depending on a plugin. So core opens
 * a small, short-lived connection of its own from `DATABASE_URL`, applies the
 * ledger, and closes it. Two connections for a few hundred milliseconds at
 * boot is the entire cost.
 *
 * IDEMPOTENCE
 * -----------
 * `runMultiOrchestratorMigrations` reads its ledger first and takes the
 * `_multi_orchestrator_migrations` advisory lock only when there is work owed,
 * so the steady-state boot is one SELECT and the orchestrator's own later call
 * is a no-op second pass. Multiple replicas booting together serialise on the
 * same lock they always did.
 */

/** Outcome of a boot-time core-migration run. Returned rather than logged-only
 *  so callers (and tests) can assert which branch was taken. */
export type CoreMigrationsOutcome =
  /** No `DATABASE_URL` — the in-memory backend is in use and there is no
   *  database to migrate. Not an error: tests and zero-config dev boot here. */
  | 'no-database'
  /** The ledger is current, whether this call applied files or found none. */
  | 'applied';

export interface CoreMigrationsOptions {
  /** Postgres connection string. Omit / leave empty to skip. */
  readonly databaseUrl?: string | undefined;
  /** Where progress goes. Defaults to a no-op so tests stay quiet. */
  readonly log?: ((msg: string) => void) | undefined;
  /**
   * Pool factory seam. Defaults to a real `pg.Pool`; overridden in tests that
   * want to hand in a pool against a scratch database without going through
   * the environment.
   */
  readonly createPool?: ((connectionString: string) => Pool) | undefined;
}

export async function runCoreMigrations(
  opts: CoreMigrationsOptions = {},
): Promise<CoreMigrationsOutcome> {
  const databaseUrl = opts.databaseUrl?.trim();
  const log = opts.log ?? ((): void => undefined);
  if (!databaseUrl) return 'no-database';

  const createPool =
    opts.createPool ??
    ((connectionString: string): Pool =>
      // Two connections is enough: the migrator uses exactly one, and the
      // spare keeps a transient checkout failure from stalling boot. The pool
      // is closed before boot continues, so it never competes with the
      // long-lived pools plugins open later.
      new Pool({ connectionString, max: 2, idleTimeoutMillis: 1_000 }));

  const pool = createPool(databaseUrl);
  try {
    await runMultiOrchestratorMigrations(pool, log);
    return 'applied';
  } finally {
    // `end()` must not mask a migration failure, and must not itself fail the
    // boot: the migrations are already committed by the time we get here.
    await pool.end().catch(() => undefined);
  }
}
