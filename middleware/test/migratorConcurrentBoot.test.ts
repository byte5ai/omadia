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
 * All eight SQL migrators are `read ledger → filter → apply` with no mutual
 * exclusion. Two replicas booting together both read the same pending list and
 * both execute it. `CREATE … IF NOT EXISTS` masks that; `ALTER TABLE … ADD
 * CONSTRAINT` does not — the loser gets 42710 and its boot fails. Three of the
 * eight run inside a plugin `activate()` that `ToolPluginRuntime` hard-caps at
 * 10s, so the fix cannot be an unbounded `pg_advisory_lock`.
 *
 * These tests pin the mechanism, not Postgres: a real server proves a lock is
 * free at the end, but it cannot force the cases that matter — an unlock that
 * FAILS, a lock that is never granted, a migration that throws while the lock
 * is held. A fake driver is the only way to reach those, and the observable
 * behaviour they must produce is exactly three things: which SQL was issued,
 * in which order, and whether the connection was POOLED (`release(false)`) or
 * DESTROYED (`release(true)` — the only other way a session-scoped advisory
 * lock is released).
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
  /** Successive answers to `pg_try_advisory_lock`; the last one repeats.
   *  `null` models a driver that answers with no row at all. */
  readonly lockAnswers?: readonly (boolean | null)[];
  /** `pg_advisory_unlock` throws — what a connection stuck in an aborted
   *  transaction actually does. */
  readonly unlockThrows?: boolean;
  /** `pg_advisory_unlock`'s answer; `null` models a driver with no row. */
  readonly unlockAnswer?: boolean | null;
  /** Thrown by the FIRST migration body that executes. */
  readonly migrationThrows?: Error;
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
  let lockCount = 0;
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

  const query = async (text: string): Promise<QueryResult> => {
    sql.push(text);

    if (/CREATE TABLE IF NOT EXISTS _[a-z_]+_migrations/i.test(text)) {
      const err = script.ledgerDdlErrors?.[ddlCount];
      ddlCount += 1;
      if (err !== undefined) throw err;
      return rows([]);
    }

    if (/pg_try_advisory_lock/.test(text)) {
      const answer = pick<boolean | null>(script.lockAnswers, lockCount, true);
      lockCount += 1;
      return answer === null ? rows([]) : rows([{ locked: answer }]);
    }

    if (/pg_advisory_unlock/.test(text)) {
      if (script.unlockThrows === true) {
        throw new Error('current transaction is aborted, commands ignored');
      }
      const answer = script.unlockAnswer === undefined ? true : script.unlockAnswer;
      return answer === null ? rows([]) : rows([{ unlocked: answer }]);
    }

    if (/^\s*SELECT id FROM _[a-z_]+_migrations/i.test(text)) {
      const applied = pick<readonly string[]>(script.ledgerReads, ledgerReadCount, []);
      ledgerReadCount += 1;
      return rows(applied.map((id) => ({ id })));
    }

    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) return rows([]);
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

const LOCK_RE = /pg_try_advisory_lock/;
const UNLOCK_RE = /pg_advisory_unlock/;
const INSERT_RE = /^\s*INSERT INTO _[a-z_]+_migrations/i;
const BEGIN_RE = /^\s*BEGIN\s*$/i;

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
      assert.equal(count(fake.sql, LOCK_RE), 0, `${m.name}: locked with no work to do`);
      assert.equal(count(fake.sql, INSERT_RE), 0, `${m.name}: re-applied a migration`);
      assert.deepEqual(fake.releases, [false], `${m.name}: connection must be pooled`);
    }
  });

  it('takes the lock BEFORE the first migration and applies every pending file', async () => {
    for (const m of MIGRATORS) {
      const files = await sqlFiles(m.migrationsDir);
      const fake = makeFake({ ledgerReads: [[]] });
      await m.run(fake.pool);

      const lockAt = fake.sql.findIndex((s) => LOCK_RE.test(s));
      const beginAt = fake.sql.findIndex((s) => BEGIN_RE.test(s));
      assert.ok(lockAt >= 0, `${m.name}: no lock was taken`);
      assert.ok(beginAt > lockAt, `${m.name}: migration started before the lock`);
      assert.equal(count(fake.sql, INSERT_RE), files.length, `${m.name}: ledger writes`);
      assert.equal(count(fake.sql, UNLOCK_RE), 1, `${m.name}: released exactly once`);
      assert.deepEqual(fake.releases, [false], `${m.name}: healthy connection is pooled`);
    }
  });

  it('re-reads the ledger UNDER the lock, so the winner is never re-run', async () => {
    for (const m of MIGRATORS) {
      const files = await sqlFiles(m.migrationsDir);
      // Pending before the lock, complete once we hold it: exactly what a
      // replica sees when it queues behind a winner that then finishes.
      const fake = makeFake({ ledgerReads: [[], files] });
      await m.run(fake.pool);

      assert.equal(count(fake.sql, LOCK_RE), 1, `${m.name}: expected one lock attempt`);
      assert.equal(
        count(fake.sql, INSERT_RE),
        0,
        `${m.name}: applied migrations the winner had already applied`,
      );
      assert.equal(count(fake.sql, UNLOCK_RE), 1, `${m.name}: released the lock`);
      assert.deepEqual(fake.releases, [false], `${m.name}: connection pooled`);
    }
  });

  it('gives a loser a CLEAR RETRYABLE ERROR — never a silent skip', async () => {
    // Runs the eight in parallel: each burns its full budget by design, and
    // 8 x 2s sequentially would dominate the suite.
    await Promise.all(
      MIGRATORS.map(async (m) => {
        const fake = makeFake({ ledgerReads: [[]], lockAnswers: [false] });
        const started = Date.now();

        await assert.rejects(m.run(fake.pool), (err: unknown) => {
          assert.ok(err instanceof Error);
          // "timed out" is load-bearing: `bootstrap.retryErroredPlugins`
          // matches it as a transient activation error and re-attempts the
          // plugin instead of latching it `errored` forever.
          assert.match(err.message, /timed out/);
          assert.match(err.message, /still pending/);
          assert.match(err.message, new RegExp(m.ledger));
          return true;
        });

        const elapsed = Date.now() - started;
        assert.ok(
          elapsed >= m.budgetMs - 150,
          `${m.name}: gave up after ${String(elapsed)}ms, before its ${String(m.budgetMs)}ms budget`,
        );
        assert.ok(
          elapsed < m.budgetMs + 2_000,
          `${m.name}: overran its budget (${String(elapsed)}ms)`,
        );
        assert.equal(count(fake.sql, INSERT_RE), 0, `${m.name}: applied without the lock`);
        assert.equal(
          count(fake.sql, UNLOCK_RE),
          0,
          `${m.name}: unlocked a lock it never held`,
        );
        // Never acquired ⇒ nothing to leak ⇒ a healthy connection must not be
        // thrown away.
        assert.deepEqual(fake.releases, [false], `${m.name}: connection pooled`);
      }),
    );
  });

  it('lets a loser finish cleanly when the winner applied everything while it waited', async () => {
    await Promise.all(
      MIGRATORS.map(async (m) => {
        const files = await sqlFiles(m.migrationsDir);
        const logs: string[] = [];
        const fake = makeFake({ ledgerReads: [[], files], lockAnswers: [false] });

        await m.run(fake.pool, (msg) => logs.push(msg));

        assert.ok(
          logs.some((l) => /applied by another replica/.test(l)),
          `${m.name}: the outcome must be stated, not silently assumed`,
        );
        assert.equal(count(fake.sql, INSERT_RE), 0, `${m.name}: applied without the lock`);
        assert.deepEqual(fake.releases, [false], `${m.name}: connection pooled`);
      }),
    );
  });

  it('preserves the ORIGINAL error when a migration throws, and destroys the connection', async () => {
    for (const m of MIGRATORS) {
      const boom = Object.assign(
        new Error('constraint "x_pkey" for relation "x" already exists'),
        { code: '42710' },
      );
      const fake = makeFake({ ledgerReads: [[]], migrationThrows: boom });

      await assert.rejects(m.run(fake.pool), (err: unknown) => {
        // Identity, not shape: an unlock in `finally` would replace this.
        assert.equal(err, boom, `${m.name}: the original error was replaced`);
        return true;
      });

      assert.ok(
        fake.sql.some((s) => /^\s*ROLLBACK\s*$/i.test(s)),
        `${m.name}: the failed migration was not rolled back`,
      );
      assert.equal(
        count(fake.sql, UNLOCK_RE),
        0,
        `${m.name}: no unlock may be issued on the failure path — the pools set no statement_timeout, so it can hang the release, and a throwing unlock would mask the migration error`,
      );
      assert.deepEqual(
        fake.releases,
        [true],
        `${m.name}: destroying the connection is what releases the session lock here`,
      );
    }
  });

  it('destroys the connection when the unlock THROWS on the success path', async () => {
    for (const m of MIGRATORS) {
      const fake = makeFake({ ledgerReads: [[]], unlockThrows: true });
      // Everything committed; only the unlock failed. The migration itself
      // succeeded, so this must NOT reject.
      await m.run(fake.pool);
      assert.deepEqual(fake.releases, [true], `${m.name}: unlock threw, connection pooled`);
    }
  });

  it('destroys the connection when the driver says the lock was NOT released', async () => {
    for (const m of MIGRATORS) {
      const fake = makeFake({ ledgerReads: [[]], unlockAnswer: false });
      await m.run(fake.pool);
      // Reading `pg_advisory_unlock`'s boolean is the whole point: `false`
      // means this session never held it / did not release it, and pooling
      // the connection would strand the lock.
      assert.deepEqual(fake.releases, [true], `${m.name}: ignored the unlock verdict`);
    }
  });

  it('treats a driver that models no advisory locks as clean (no row ⇒ acquired ⇒ released)', async () => {
    for (const m of MIGRATORS) {
      const files = await sqlFiles(m.migrationsDir);
      const fake = makeFake({
        ledgerReads: [[]],
        lockAnswers: [null],
        unlockAnswer: null,
      });
      await m.run(fake.pool);
      assert.equal(count(fake.sql, INSERT_RE), files.length, `${m.name}: migrations skipped`);
      assert.deepEqual(fake.releases, [false], `${m.name}: nothing was held, nothing to destroy`);
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
