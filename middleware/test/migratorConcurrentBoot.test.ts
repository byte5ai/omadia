import { strict as assert } from 'node:assert';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  GRAPH_MIGRATION_LOCK_WAIT_MS,
  runGraphMigrations,
} from '../packages/harness-knowledge-graph-neon/src/migrator.js';
import {
  MEMORY_MIGRATION_LOCK_WAIT_MS,
  runMemoryMigrations,
} from '../packages/harness-memory-postgres/src/migrator.js';
import {
  MULTI_ORCH_MIGRATION_LOCK_WAIT_MS,
  runMultiOrchestratorMigrations,
} from '../packages/harness-orchestrator/src/registry/migrator.js';
import {
  AUTH_MIGRATION_LOCK_WAIT_MS,
  runAuthMigrations,
} from '../src/auth/migrator.js';
import {
  CONDUCTOR_MIGRATION_LOCK_WAIT_MS,
  runConductorMigrations,
} from '../src/conductor/migrator.js';
import {
  ROUTINE_MIGRATION_LOCK_WAIT_MS,
  runRoutineMigrations,
} from '../src/plugins/routines/migrator.js';
import {
  PROFILE_SNAPSHOT_MIGRATION_LOCK_WAIT_MS,
  runProfileSnapshotMigrations,
} from '../src/profileSnapshots/migrator.js';
import {
  PROFILE_STORAGE_MIGRATION_LOCK_WAIT_MS,
  runProfileStorageMigrations,
} from '../src/profileStorage/migrator.js';

/**
 * All eight SQL migrators are `read ledger → filter → apply`. Two replicas
 * booting together both read the same pending list and both execute it.
 * `CREATE … IF NOT EXISTS` masks that; `ALTER TABLE … ADD CONSTRAINT` does not
 * — the loser gets 42710 and its boot fails. Three of the eight run inside a
 * plugin `activate()` that `ToolPluginRuntime` hard-caps at 10s, so the wait
 * for the lock has to be bounded.
 *
 * THE LOCK IS TRANSACTION-SCOPED. The first version took a session-level
 * advisory lock (`pg_try_advisory_lock` … `pg_advisory_unlock`). Behind a
 * transaction-mode connection pooler (PgBouncer, Neon's `-pooler` host, which
 * is what the hosted instance connects through) the lock and the unlock run
 * on different server sessions: the lock stays held by a session nobody owns
 * and blocks the next boot that has a migration to apply, and two replicas
 * that happen to share a server session both "hold" it. So every file is
 * applied in a transaction that takes `pg_advisory_xact_lock` first, bounded
 * by `SET LOCAL lock_timeout`, and re-reads the ledger under it.
 *
 * These tests pin the mechanism, not Postgres: a fake driver is the only way
 * to force the cases that matter — a lock that is never granted, a migration
 * that throws while the lock is held, a ROLLBACK that fails. What they observe
 * is which SQL was issued, in which order, and whether the connection was
 * POOLED (`release(false)`) or DESTROYED (`release(true)`).
 * `coreMigrations.pg.test.ts` runs the real thing against Postgres.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MIDDLEWARE_DIR = resolve(TEST_DIR, '..');

/**
 * `waitForPostgres`' default budget (see `neonKnowledgeGraph.ts`), which the
 * knowledge-graph plugin burns inside `activate()` BEFORE calling its
 * migrator. The lock budget has to fit in what is left of the 10s cap.
 */
const WAIT_FOR_POSTGRES_BUDGET_MS = 6_000;
const ACTIVATE_TIMEOUT_MS = 10_000;

interface MigratorCase {
  readonly name: string;
  readonly ledger: string;
  readonly migrationsDir: string;
  readonly budgetMs: number;
  run(pool: Pool, log?: (msg: string) => void): Promise<void>;
}

const MIGRATORS: readonly MigratorCase[] = [
  {
    name: 'auth',
    ledger: '_auth_migrations',
    migrationsDir: join(MIDDLEWARE_DIR, 'src', 'auth', 'migrations'),
    budgetMs: AUTH_MIGRATION_LOCK_WAIT_MS,
    run: (pool, log) => runAuthMigrations(pool, log),
  },
  {
    name: 'conductor',
    ledger: '_conductor_migrations',
    migrationsDir: join(MIDDLEWARE_DIR, 'src', 'conductor', 'migrations'),
    budgetMs: CONDUCTOR_MIGRATION_LOCK_WAIT_MS,
    run: (pool, log) => runConductorMigrations(pool, log),
  },
  {
    name: 'routines',
    ledger: '_routine_migrations',
    migrationsDir: join(MIDDLEWARE_DIR, 'src', 'plugins', 'routines', 'migrations'),
    budgetMs: ROUTINE_MIGRATION_LOCK_WAIT_MS,
    run: (pool, log) => runRoutineMigrations(pool, log),
  },
  {
    name: 'profile-snapshots',
    ledger: '_profile_snapshot_migrations',
    migrationsDir: join(MIDDLEWARE_DIR, 'src', 'profileSnapshots', 'migrations'),
    budgetMs: PROFILE_SNAPSHOT_MIGRATION_LOCK_WAIT_MS,
    run: (pool, log) => runProfileSnapshotMigrations(pool, log),
  },
  {
    name: 'profile-storage',
    ledger: '_profile_storage_migrations',
    migrationsDir: join(MIDDLEWARE_DIR, 'src', 'profileStorage', 'migrations'),
    budgetMs: PROFILE_STORAGE_MIGRATION_LOCK_WAIT_MS,
    run: (pool, log) => runProfileStorageMigrations(pool, log),
  },
  {
    name: 'knowledge-graph',
    ledger: '_graph_migrations',
    migrationsDir: join(
      MIDDLEWARE_DIR,
      'packages',
      'harness-knowledge-graph-neon',
      'src',
      'migrations',
    ),
    budgetMs: GRAPH_MIGRATION_LOCK_WAIT_MS,
    run: (pool, log) => runGraphMigrations(pool, log),
  },
  {
    name: 'memory-postgres',
    ledger: '_memory_migrations',
    migrationsDir: join(
      MIDDLEWARE_DIR,
      'packages',
      'harness-memory-postgres',
      'src',
      'migrations',
    ),
    budgetMs: MEMORY_MIGRATION_LOCK_WAIT_MS,
    run: (pool, log) => runMemoryMigrations(pool, log),
  },
  {
    name: 'multi-orchestrator',
    ledger: '_multi_orchestrator_migrations',
    migrationsDir: join(MIDDLEWARE_DIR, 'migrations'),
    budgetMs: MULTI_ORCH_MIGRATION_LOCK_WAIT_MS,
    run: (pool, log) =>
      runMultiOrchestratorMigrations(pool, log, join(MIDDLEWARE_DIR, 'migrations')),
  },
];

async function sqlFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
}

interface FakeScript {
  /** Successive answers to the ledger SELECT; the last one repeats. */
  readonly ledgerReads?: readonly (readonly string[])[];
  /** Files the ledger shows as applied when asked UNDER the lock. */
  readonly appliedUnderLock?: readonly string[];
  /** The lock is never granted: `pg_advisory_xact_lock` fails with 55P03
   *  (lock_not_available), which is what `lock_timeout` produces. */
  readonly lockTimesOut?: boolean;
  /** Thrown by the FIRST migration body that executes. */
  readonly migrationThrows?: Error;
  /** ROLLBACK itself throws (a connection that is gone). */
  readonly rollbackThrows?: boolean;
  /** Errors thrown by successive `CREATE TABLE IF NOT EXISTS` attempts. */
  readonly ledgerDdlErrors?: readonly unknown[];
}

interface Fake {
  readonly pool: Pool;
  /** `true` = the connection was DESTROYED, `false` = returned to the pool. */
  readonly releases: boolean[];
  readonly sql: string[];
}

function makeFake(script: FakeScript = {}): Fake {
  const releases: boolean[] = [];
  const sql: string[] = [];
  let ledgerReadCount = 0;
  let ddlCount = 0;
  let migrationCount = 0;

  const rows = (r: ReadonlyArray<Record<string, unknown>>): QueryResult =>
    ({
      command: '',
      rowCount: r.length,
      oid: 0,
      rows: [...r],
      fields: [],
    }) as unknown as QueryResult;

  function pick<T>(list: readonly T[] | undefined, index: number, fallback: T): T {
    if (list === undefined || list.length === 0) return fallback;
    return list[Math.min(index, list.length - 1)] as T;
  }

  const query = async (text: string, params?: readonly unknown[]): Promise<QueryResult> => {
    sql.push(text);

    if (/CREATE TABLE IF NOT EXISTS _[a-z_]+_migrations/i.test(text)) {
      const err = script.ledgerDdlErrors?.[ddlCount];
      ddlCount += 1;
      if (err !== undefined) throw err;
      return rows([]);
    }

    if (/pg_advisory_xact_lock/.test(text)) {
      if (script.lockTimesOut === true) {
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      }
      return rows([{}]);
    }

    if (/^\s*SET LOCAL lock_timeout/i.test(text)) return rows([]);

    if (/^\s*SELECT 1 FROM _[a-z_]+_migrations WHERE id = \$1/i.test(text)) {
      return (script.appliedUnderLock ?? []).includes(String(params?.[0])) ? rows([{}]) : rows([]);
    }

    if (/^\s*SELECT id FROM _[a-z_]+_migrations/i.test(text)) {
      const applied = pick<readonly string[]>(script.ledgerReads, ledgerReadCount, []);
      ledgerReadCount += 1;
      return rows(applied.map((id) => ({ id })));
    }

    if (/^\s*ROLLBACK\s*$/i.test(text)) {
      if (script.rollbackThrows === true) throw new Error('Connection terminated unexpectedly');
      return rows([]);
    }
    if (/^\s*(BEGIN|COMMIT)\s*$/i.test(text)) return rows([]);
    if (/^\s*INSERT INTO _[a-z_]+_migrations/i.test(text)) return rows([]);

    // Everything else is a migration body.
    migrationCount += 1;
    if (script.migrationThrows !== undefined && migrationCount === 1) {
      throw script.migrationThrows;
    }
    return rows([]);
  };

  const pool = {
    async connect(): Promise<PoolClient> {
      return {
        query,
        release(destroy?: boolean): void {
          releases.push(destroy === true);
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;

  return { pool, releases, sql };
}

const count = (sql: readonly string[], re: RegExp): number =>
  sql.filter((s) => re.test(s)).length;

const XACT_LOCK_RE = /pg_advisory_xact_lock/;
const SESSION_LOCK_RE = /pg_(try_)?advisory_lock|pg_advisory_unlock/;
const LOCK_TIMEOUT_RE = /^\s*SET LOCAL lock_timeout = '\d+ms'/i;
const INSERT_RE = /^\s*INSERT INTO _[a-z_]+_migrations/i;
const BEGIN_RE = /^\s*BEGIN\s*$/i;
const COMMIT_RE = /^\s*COMMIT\s*$/i;
const ROLLBACK_RE = /^\s*ROLLBACK\s*$/i;

describe('SQL migrators — concurrent multi-replica boot', () => {
  it('never touches the lock when the ledger says there is nothing to apply', async () => {
    for (const m of MIGRATORS) {
      const files = await sqlFiles(m.migrationsDir);
      assert.ok(files.length > 0, `${m.name}: fixture check — expected .sql files`);

      const fake = makeFake({ ledgerReads: [files] });
      await m.run(fake.pool);

      // The steady-state boot is the common case by orders of magnitude. It
      // must not pay a round-trip for the lock, and — more importantly — must
      // not be able to queue behind a replica that IS migrating.
      assert.equal(count(fake.sql, XACT_LOCK_RE), 0, `${m.name}: locked with no work to do`);
      assert.equal(count(fake.sql, BEGIN_RE), 0, `${m.name}: opened a transaction with no work to do`);
      assert.equal(count(fake.sql, INSERT_RE), 0, `${m.name}: re-applied a migration`);
      assert.deepEqual(fake.releases, [false], `${m.name}: connection must be pooled`);
    }
  });

  it('never takes a session-level advisory lock: it would not survive a transaction-mode pooler', async () => {
    for (const m of MIGRATORS) {
      const fake = makeFake({ ledgerReads: [[]] });
      await m.run(fake.pool);
      assert.equal(count(fake.sql, SESSION_LOCK_RE), 0, `${m.name}: session-level advisory lock`);
      assert.equal(
        fake.sql.filter((s) => /^\s*SET\s/i.test(s) && !/^\s*SET LOCAL\s/i.test(s)).length,
        0,
        `${m.name}: a SET outside SET LOCAL does not survive the pooler either`,
      );
    }
  });

  it('takes the lock INSIDE each file transaction, bounded, before the migration body', async () => {
    for (const m of MIGRATORS) {
      const files = await sqlFiles(m.migrationsDir);
      const fake = makeFake({ ledgerReads: [[]] });
      await m.run(fake.pool);

      assert.equal(count(fake.sql, BEGIN_RE), files.length, `${m.name}: one transaction per file`);
      assert.equal(count(fake.sql, XACT_LOCK_RE), files.length, `${m.name}: one lock per transaction`);
      assert.equal(count(fake.sql, COMMIT_RE), files.length, `${m.name}: every file committed`);
      assert.equal(count(fake.sql, INSERT_RE), files.length, `${m.name}: ledger writes`);
      // The order inside the first transaction: BEGIN, bound the wait, lock,
      // lift the bound, ask the ledger, and only then the migration.
      const begin = fake.sql.findIndex((s) => BEGIN_RE.test(s));
      assert.match(fake.sql[begin + 1] ?? '', LOCK_TIMEOUT_RE, `${m.name}: the wait is not bounded`);
      assert.match(fake.sql[begin + 2] ?? '', XACT_LOCK_RE, `${m.name}: lock is not the first thing in the transaction`);
      assert.match(fake.sql[begin + 3] ?? '', /^\s*SET LOCAL lock_timeout = DEFAULT/i, `${m.name}: the bound must not apply to the migration's own DDL`);
      assert.match(fake.sql[begin + 4] ?? '', /^\s*SELECT 1 FROM _[a-z_]+_migrations WHERE id = \$1/i, `${m.name}: ledger not re-read under the lock`);
      assert.deepEqual(fake.releases, [false], `${m.name}: healthy connection is pooled`);
    }
  });

  it('re-reads the ledger UNDER the lock, so the winner is never re-run', async () => {
    for (const m of MIGRATORS) {
      const files = await sqlFiles(m.migrationsDir);
      // Pending before the lock, applied once we hold it: exactly what a
      // replica sees when it queues behind a winner that then finishes.
      const fake = makeFake({ ledgerReads: [[]], appliedUnderLock: files });
      await m.run(fake.pool);

      assert.equal(count(fake.sql, INSERT_RE), 0, `${m.name}: applied migrations the winner had already applied`);
      assert.equal(count(fake.sql, ROLLBACK_RE), files.length, `${m.name}: every skipped file ends its transaction, which releases the lock`);
      assert.equal(count(fake.sql, COMMIT_RE), 0, `${m.name}: nothing to commit`);
      assert.deepEqual(fake.releases, [false], `${m.name}: connection pooled`);
    }
  });

  it('applies only what the winner left: a file applied meanwhile is skipped, the rest runs', async () => {
    for (const m of MIGRATORS) {
      const files = await sqlFiles(m.migrationsDir);
      if (files.length < 2) continue;
      const fake = makeFake({ ledgerReads: [[]], appliedUnderLock: [files[0]!] });
      await m.run(fake.pool);
      assert.equal(count(fake.sql, INSERT_RE), files.length - 1, `${m.name}: ledger writes`);
    }
  });

  it('gives a loser a CLEAR RETRYABLE ERROR — never a silent skip', async () => {
    for (const m of MIGRATORS) {
      const fake = makeFake({ ledgerReads: [[]], lockTimesOut: true });

      await assert.rejects(m.run(fake.pool), (err: unknown) => {
        assert.ok(err instanceof Error);
        // "timed out" is load-bearing: `bootstrap.retryErroredPlugins`
        // matches it as a transient activation error and re-attempts the
        // plugin instead of latching it `errored` forever.
        assert.match(err.message, /timed out/);
        assert.match(err.message, /still pending/);
        assert.match(err.message, new RegExp(m.ledger));
        assert.match(err.message, new RegExp(`${String(m.budgetMs)}ms`));
        return true;
      });

      // The wait the server enforces is this migrator's budget.
      const bound = fake.sql.find((s) => LOCK_TIMEOUT_RE.test(s)) ?? '';
      assert.match(bound, new RegExp(`'${String(m.budgetMs)}ms'`), `${m.name}: lock_timeout is not the budget`);
      assert.equal(count(fake.sql, INSERT_RE), 0, `${m.name}: applied without the lock`);
      assert.equal(count(fake.sql, ROLLBACK_RE), 1, `${m.name}: the waiting transaction was not ended`);
      // Nothing is held after the ROLLBACK, so a healthy connection is pooled.
      assert.deepEqual(fake.releases, [false], `${m.name}: connection pooled`);
    }
  });

  it('lets a loser finish cleanly when the winner applied everything while it waited', async () => {
    for (const m of MIGRATORS) {
      const files = await sqlFiles(m.migrationsDir);
      const logs: string[] = [];
      const fake = makeFake({ ledgerReads: [[], files], lockTimesOut: true });

      await m.run(fake.pool, (msg) => logs.push(msg));

      assert.ok(
        logs.some((l) => /applied by another replica/.test(l)),
        `${m.name}: the outcome must be stated, not silently assumed`,
      );
      assert.equal(count(fake.sql, INSERT_RE), 0, `${m.name}: applied without the lock`);
      assert.deepEqual(fake.releases, [false], `${m.name}: connection pooled`);
    }
  });

  it('preserves the ORIGINAL error when a migration throws; the ROLLBACK releases the lock', async () => {
    for (const m of MIGRATORS) {
      const boom = Object.assign(
        new Error('constraint "x_pkey" for relation "x" already exists'),
        { code: '42710' },
      );
      const fake = makeFake({ ledgerReads: [[]], migrationThrows: boom });

      await assert.rejects(m.run(fake.pool), (err: unknown) => {
        assert.equal(err, boom, `${m.name}: the original error was replaced`);
        return true;
      });

      assert.equal(count(fake.sql, ROLLBACK_RE), 1, `${m.name}: the failed migration was not rolled back`);
      assert.equal(count(fake.sql, INSERT_RE), 0, `${m.name}: a failed file was recorded`);
      // The lock went with the transaction: nothing to destroy the connection for.
      assert.deepEqual(fake.releases, [false], `${m.name}: a rolled-back connection is healthy and pooled`);
    }
  });

  it('destroys the connection when the ROLLBACK itself fails, and still reports the original error', async () => {
    for (const m of MIGRATORS) {
      const boom = new Error('syntax error at or near "ALTR"');
      const fake = makeFake({ ledgerReads: [[]], migrationThrows: boom, rollbackThrows: true });
      await assert.rejects(m.run(fake.pool), (err: unknown) => {
        assert.equal(err, boom, `${m.name}: the ROLLBACK failure replaced the migration error`);
        return true;
      });
      assert.deepEqual(fake.releases, [true], `${m.name}: a connection in an unknown state was pooled`);

      // The same when the lock wait timed out and the ROLLBACK then failed:
      // the ledger cannot be re-read on that connection, so the file counts
      // as still owed and the error stays retryable.
      const lost = makeFake({ ledgerReads: [[]], lockTimesOut: true, rollbackThrows: true });
      await assert.rejects(m.run(lost.pool), /timed out/);
      assert.deepEqual(lost.releases, [true], `${m.name}: connection pooled after a failed ROLLBACK`);
    }
  });

  it('survives a concurrent CREATE TABLE of the ledger (42P07 / 23505) and rethrows anything else', async () => {
    for (const m of MIGRATORS) {
      const files = await sqlFiles(m.migrationsDir);

      for (const code of ['42P07', '23505']) {
        const dup = Object.assign(new Error(`duplicate ${code}`), { code });
        const fake = makeFake({ ledgerReads: [files], ledgerDdlErrors: [dup] });
        await m.run(fake.pool);
        assert.equal(
          count(fake.sql, /CREATE TABLE IF NOT EXISTS/i),
          2,
          `${m.name}: ${code} must be retried exactly once`,
        );
        assert.deepEqual(fake.releases, [false], `${m.name}: connection pooled`);
      }

      const denied = Object.assign(new Error('permission denied for schema public'), {
        code: '42501',
      });
      const fake = makeFake({ ledgerReads: [files], ledgerDdlErrors: [denied] });
      await assert.rejects(m.run(fake.pool), (err: unknown) => {
        assert.equal(err, denied, `${m.name}: a real DDL failure must not be swallowed`);
        return true;
      });
      assert.deepEqual(fake.releases, [false], `${m.name}: connection pooled`);
    }
  });

  it('fits the bounded wait inside the 10s activate() cap for every migrator', async () => {
    for (const m of MIGRATORS) {
      // The knowledge-graph plugin spends up to WAIT_FOR_POSTGRES_BUDGET_MS in
      // `waitForPostgres` before its migrator is even called, and all eight
      // share one budget so this is the binding constraint for all of them.
      assert.ok(m.budgetMs > 0, `${m.name}: budget must be positive`);
      assert.ok(
        WAIT_FOR_POSTGRES_BUDGET_MS + m.budgetMs < ACTIVATE_TIMEOUT_MS,
        `${m.name}: ${String(WAIT_FOR_POSTGRES_BUDGET_MS)}ms + ${String(m.budgetMs)}ms leaves no room inside the ${String(ACTIVATE_TIMEOUT_MS)}ms activate() cap`,
      );
    }
  });
});
