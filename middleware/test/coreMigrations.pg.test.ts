/**
 * #796 (epic #470 C9 / G3) — core's base schema must not depend on an LLM key.
 *
 * WHAT WAS WRONG
 * --------------
 * `middleware/migrations/` is a core-owned directory whose only production
 * caller lived inside the harness-orchestrator plugin's `activate()`, several
 * hundred lines past an early return taken whenever no LLM provider resolves:
 *
 *     const provider = await resolveLlmProvider(...);
 *     if (!provider) return { async close() {...} };
 *
 * On a deployment with no provider key, core therefore had no schema at all.
 * `_multi_orchestrator_migrations` did not exist, and neither did
 * `plugin_public_path_grants` (C4's public-path consent table) nor
 * `plugin_sql_grants` (C7's SQL consent table) — so recording either operator
 * consent was structurally impossible. The failure was silent by
 * construction: nothing logged a migration error, because no migration was
 * ever attempted. The P5 acceptance run had to apply all 47 files by hand.
 *
 * WHAT THIS PINS
 * --------------
 * `runCoreMigrations` is what core's boot now calls, before any tool plugin
 * activates and with no provider configured. The suite deliberately runs with
 * every provider key stripped from the environment, so a regression that
 * reattached the ledger to a credential fails here rather than in staging.
 *
 * Isolation: each case builds its own schema and takes `public` off the
 * search_path, so the 47 files apply against an empty namespace without
 * touching the tables the other pg suites share. Schema names carry the
 * `c9core_` prefix.
 *
 * Skips when no test Postgres is reachable, mirroring the other pg suites.
 */

import { strict as assert } from 'node:assert';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { runCoreMigrations } from '../src/platform/coreMigrations.js';

import { probePgTest } from './_helpers/pgTestDb.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'coreMigrations',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'WS5_PG_TEST_URL'],
});

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/** Env vars any provider path could read. Cleared for the whole suite. */
const PROVIDER_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'LLM_PROVIDER_API_KEY',
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of PROVIDER_KEYS) {
  savedEnv.set(key, process.env[key]);
  delete process.env[key];
}

/**
 * One capped pool for the suite's own assertions. ~16 other pg suites run
 * concurrently, each holding a default-sized pool, so an uncapped extra pool
 * here is enough to exhaust `max_connections` and cancel an unrelated suite.
 */
const probePool = pgAvailable
  ? new Pool({ connectionString: PG_URL, max: 2, idleTimeoutMillis: 1_000 })
  : undefined;

after(async () => {
  await probePool?.end().catch(() => undefined);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Run `runCoreMigrations` against a scratch schema.
 *
 * The `createPool` seam exists for exactly this: the migrations are written
 * unqualified, so pointing `search_path` at a private schema is what makes
 * them land somewhere this suite may drop afterwards.
 */
async function migrateInto(schema: string): Promise<string> {
  await probePool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await probePool?.query(`CREATE SCHEMA ${schema}`);
  const outcome = await runCoreMigrations({
    databaseUrl: PG_URL ?? '',
    createPool: (connectionString) =>
      new Pool({
        connectionString,
        max: 2,
        idleTimeoutMillis: 1_000,
        options: `-c search_path=${schema}`,
      }),
  });
  return outcome;
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const res = await probePool?.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`${schema}.${table}`],
  );
  return res?.rows[0]?.exists === true;
}

describe('#796 core migrations run at boot, without any LLM provider', () => {
  it('is a no-op when there is no DATABASE_URL, not a crash', async () => {
    // Tests and zero-config dev boot on the in-memory backend. Core must
    // say so and continue, rather than throwing on a missing connection.
    assert.equal(await runCoreMigrations({ databaseUrl: undefined }), 'no-database');
    assert.equal(await runCoreMigrations({ databaseUrl: '   ' }), 'no-database');
    assert.equal(await runCoreMigrations({}), 'no-database');
  });

  it('applies the full core ledger with every provider key unset', {
    skip: pgAvailable ? false : 'no test Postgres reachable',
  }, async () => {
    for (const key of PROVIDER_KEYS) {
      assert.equal(process.env[key], undefined, `${key} must be unset here`);
    }

    const schema = 'c9core_apply';
    try {
      assert.equal(await migrateInto(schema), 'applied');

      // The ledger itself exists and names every file on disk. Asserting the
      // COUNT against the directory (rather than a hardcoded 47) keeps this
      // honest as migrations are added.
      const onDisk = (await readdir(migrationsDir)).filter((f) =>
        f.endsWith('.sql'),
      );
      const ledger = await probePool?.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${schema}._multi_orchestrator_migrations`,
      );
      assert.equal(
        Number(ledger?.rows[0]?.n),
        onDisk.length,
        'every migration on disk must be recorded in the ledger',
      );

      // The two tables the gap actually cost operators. Named individually
      // rather than folded into the count above, because "the ledger ran"
      // and "consent is recordable" are the two separate claims #796 makes.
      assert.ok(
        await tableExists(schema, 'plugin_public_path_grants'),
        "C4's public-path consent table must exist",
      );
      assert.ok(
        await tableExists(schema, 'plugin_sql_grants'),
        "C7's SQL-grant consent table must exist",
      );
    } finally {
      await probePool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it('is idempotent — a second pass applies nothing and takes no lock', {
    skip: pgAvailable ? false : 'no test Postgres reachable',
  }, async () => {
    const schema = 'c9core_second_pass';
    try {
      await migrateInto(schema);
      const first = await probePool?.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${schema}._multi_orchestrator_migrations`,
      );

      // This is the shape the harness-orchestrator plugin's retained call
      // now has: core already ran the ledger at boot, so the plugin's own
      // invocation must be a cheap no-op rather than a re-apply.
      assert.equal(await migrateInto2(schema), 'applied');

      const second = await probePool?.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${schema}._multi_orchestrator_migrations`,
      );
      assert.equal(second?.rows[0]?.n, first?.rows[0]?.n);

      // Nothing was left holding the migration advisory lock.
      const locks = await probePool?.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 4410",
      );
      assert.equal(Number(locks?.rows[0]?.n), 0, 'advisory lock must be released');
    } finally {
      await probePool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});

/** Second run against an already-migrated schema (no DROP/CREATE first). */
async function migrateInto2(schema: string): Promise<string> {
  return runCoreMigrations({
    databaseUrl: PG_URL ?? '',
    createPool: (connectionString) =>
      new Pool({
        connectionString,
        max: 2,
        idleTimeoutMillis: 1_000,
        options: `-c search_path=${schema}`,
      }),
  });
}
