/**
 * Epic #470 C7 / G4 — `runPluginMigrations` against a real Postgres.
 *
 * WHY THIS SUITE NEEDS A REAL DATABASE
 * -----------------------------------
 * The three properties that matter here are all properties of the SERVER, not
 * of this code:
 *
 *   - `pg_advisory_xact_lock` actually serialises two concurrent runners.
 *   - `CREATE TABLE IF NOT EXISTS` under that lock cannot double-create.
 *   - `UNIQUE (ledger)` in `plugin_sql_grants` actually refuses a second owner.
 *
 * A hand-rolled fake would have all three by construction and would prove only
 * that the fake has them. The concurrency test in particular is the counter-
 * proof for the lock: with the lock removed it fails (see the PR body), which
 * is the only way to know the lock is load-bearing rather than decorative.
 *
 * Skips cleanly (issue #572: no hardcoded default port) when no test database
 * is configured.
 */

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { LedgerNameError, SqlMigrationError } from '@omadia/plugin-api';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import {
  PLUGIN_MIGRATION_LOCK_WAIT_MS,
  runPluginMigrations,
} from '../src/platform/pluginMigrations.js';
import {
  LedgerAlreadyOwnedError,
  PostgresPluginSqlGrantStore,
} from '../src/platform/pluginSqlGrantStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'pluginMigrations',
  vars: ['PLUGIN_SQL_PG_TEST_URL', 'GRAPH_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

/** Migration 0045, applied directly so this suite does not depend on the
 *  multi-orchestrator migrator having run against the test database. */
const GRANTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS plugin_sql_grants (
  plugin_id  TEXT NOT NULL,
  ledger     TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id),
  UNIQUE (ledger)
);`;

describe('#470 C7 runPluginMigrations', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let dir: string;
  // Every run gets its own plugin id and therefore its own ledger, so the
  // suite is safe to run concurrently with itself and leaves no shared state
  // between cases.
  let pluginId: string;
  let ledger: string;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 8 });
    await pool.query(GRANTS_SCHEMA);
  });

  after(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const mark = randomUUID().replace(/-/g, '').slice(0, 10);
    pluginId = `@omadia/t${mark}`;
    ledger = `omadia_t${mark}_migrations`;
    dir = await mkdtemp(join(tmpdir(), 'c7-mig-'));
  });

  /** Drop whatever a case created, by name — the ledger and any table its
   *  migrations made. Named after the run mark so nothing collides. */
  async function cleanup(...tables: string[]): Promise<void> {
    for (const t of [ledger, ...tables]) {
      await pool.query(`DROP TABLE IF EXISTS "${t}"`);
    }
    await rm(dir, { recursive: true, force: true });
  }

  it('applies .sql migrations in filename order and reports them', async () => {
    // Deliberately created out of order and named so that lexical order and
    // creation order disagree — a runner that just used readdir() order would
    // pass on some filesystems and fail on others.
    await writeFile(
      join(dir, '0002_add_col.sql'),
      `ALTER TABLE "${ledger}_data" ADD COLUMN note TEXT;`,
    );
    await writeFile(
      join(dir, '0001_create.sql'),
      `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`,
    );

    const report = await runPluginMigrations({ pool, pluginId, ledger, dir });

    assert.deepEqual(report.applied, ['0001_create.sql', '0002_add_col.sql']);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.ledger, ledger);
    assert.equal(typeof report.durationMs, 'number');
    assert.ok(report.durationMs >= 0);

    // The second migration only succeeds if the first ran first — the column
    // is the proof that ordering held, not the report's own array.
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
      [`${ledger}_data`],
    );
    assert.deepEqual(
      cols.rows.map((r) => r.column_name),
      ['id', 'note'],
    );

    await cleanup(`${ledger}_data`);
  });

  it('is idempotent: a second pass skips everything and applies nothing', async () => {
    await writeFile(
      join(dir, '0001_create.sql'),
      `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`,
    );

    const first = await runPluginMigrations({ pool, pluginId, ledger, dir });
    const second = await runPluginMigrations({ pool, pluginId, ledger, dir });

    assert.deepEqual(first.applied, ['0001_create.sql']);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ['0001_create.sql']);

    await cleanup(`${ledger}_data`);
  });

  it('runs .js and .mjs migrations alongside .sql, in one filename order', async () => {
    // D6 in implementation.md: plugins codegen .sql into JS. That path must be
    // the SAME path — same transaction, same lock, same ledger — not a weaker
    // one, so the ordering here interleaves the two kinds on purpose.
    await writeFile(
      join(dir, '0001_create.sql'),
      `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`,
    );
    await writeFile(
      join(dir, '0002_js_col.js'),
      `export default async (client) => {
         await client.query('ALTER TABLE "${ledger}_data" ADD COLUMN from_js TEXT');
       };`,
    );
    await writeFile(
      join(dir, '0003_mjs_col.mjs'),
      `export default async (client) => {
         await client.query('ALTER TABLE "${ledger}_data" ADD COLUMN from_mjs TEXT');
       };`,
    );

    const report = await runPluginMigrations({ pool, pluginId, ledger, dir });
    assert.deepEqual(report.applied, [
      '0001_create.sql',
      '0002_js_col.js',
      '0003_mjs_col.mjs',
    ]);

    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
      [`${ledger}_data`],
    );
    assert.deepEqual(
      cols.rows.map((r) => r.column_name),
      ['from_js', 'from_mjs', 'id'],
    );

    await cleanup(`${ledger}_data`);
  });

  it('throws when a JS migration does not default-export a function', async () => {
    await writeFile(join(dir, '0001_bad.js'), `export const nope = 1;`);
    await assert.rejects(
      runPluginMigrations({ pool, pluginId, ledger, dir }),
      /must `export default async \(client\)/,
    );
    await cleanup();
  });

  it('throws on an EMPTY migrations directory — that is a packaging failure', async () => {
    // Returning "0 applied, all good" would let the plugin activate and then
    // fail later against tables that were never created, several layers away
    // from the cause.
    await assert.rejects(
      runPluginMigrations({ pool, pluginId, ledger, dir }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /contains no/);
        return true;
      },
    );
    await cleanup();
  });

  it('throws on an empty dir even when unrelated files are present', async () => {
    // A directory holding a README but no migrations is still shipping nothing.
    await writeFile(join(dir, 'README.md'), '# schema');
    await writeFile(join(dir, 'notes.txt'), 'nope');
    await assert.rejects(
      runPluginMigrations({ pool, pluginId, ledger, dir }),
      SqlMigrationError,
    );
    await cleanup();
  });

  it('throws on a missing directory rather than reporting an empty changeset', async () => {
    await assert.rejects(
      runPluginMigrations({
        pool,
        pluginId,
        ledger,
        dir: join(dir, 'does-not-exist'),
      }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /not readable/);
        return true;
      },
    );
    await cleanup();
  });

  it('throws when an already-applied file changed, and names both checksums', async () => {
    const file = join(dir, '0001_create.sql');
    await writeFile(file, `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`);
    await runPluginMigrations({ pool, pluginId, ledger, dir });

    // Edit in place — the forbidden move. The database and the package now
    // disagree about what ran.
    await writeFile(
      file,
      `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY, extra TEXT);`,
    );

    await assert.rejects(
      runPluginMigrations({ pool, pluginId, ledger, dir }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /already applied with checksum/);
        assert.match(err.message, /allowChecksumDrift/);
        return true;
      },
    );

    await cleanup(`${ledger}_data`);
  });

  it('accepts drift only with the explicit opt-in, and does not re-run the file', async () => {
    const file = join(dir, '0001_create.sql');
    await writeFile(file, `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`);
    await runPluginMigrations({ pool, pluginId, ledger, dir });

    // A cosmetic edit — the one case the escape hatch is for.
    await writeFile(
      file,
      `-- a comment\nCREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`,
    );

    const report = await runPluginMigrations({
      pool,
      pluginId,
      ledger,
      dir,
      allowChecksumDrift: true,
    });
    // Skipped, NOT re-applied: re-running the CREATE would have thrown 42P07,
    // so this assertion also proves the opt-in does not silently re-execute.
    assert.deepEqual(report.applied, []);
    assert.deepEqual(report.skipped, ['0001_create.sql']);

    await cleanup(`${ledger}_data`);
  });

  it('validates the ledger name BEFORE touching the database', async () => {
    await writeFile(join(dir, '0001.sql'), 'SELECT 1;');
    await assert.rejects(
      runPluginMigrations({
        pool,
        pluginId,
        ledger: 'someone_elses_ledger',
        dir,
      }),
      LedgerNameError,
    );
    await assert.rejects(
      runPluginMigrations({
        pool,
        pluginId,
        ledger: `${ledger}"; DROP TABLE plugin_sql_grants; --`,
        dir,
      }),
      LedgerNameError,
    );
    // The grants table is still there — the injection never reached SQL.
    const still = await pool.query(`SELECT to_regclass('plugin_sql_grants') AS t`);
    assert.notEqual(still.rows[0]?.t, null);
    await cleanup();
  });

  it('rolls the WHOLE batch back when a later migration fails', async () => {
    // One transaction for the batch: a half-applied plugin schema is a state
    // no file in the directory describes.
    await writeFile(
      join(dir, '0001_ok.sql'),
      `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`,
    );
    await writeFile(join(dir, '0002_boom.sql'), `SELECT this_does_not_exist();`);

    await assert.rejects(runPluginMigrations({ pool, pluginId, ledger, dir }));

    // Neither the table nor the ledger survives — including the row for the
    // migration that individually succeeded.
    const table = await pool.query(`SELECT to_regclass($1) AS t`, [
      `${ledger}_data`,
    ]);
    assert.equal(table.rows[0]?.t, null);
    const ledgerTable = await pool.query(`SELECT to_regclass($1) AS t`, [ledger]);
    assert.equal(ledgerTable.rows[0]?.t, null);

    await cleanup(`${ledger}_data`);
  });

  it('the lock wait budget stays inside the 10s activate() cap', () => {
    // Asserted rather than trusted in a comment: this number is what keeps a
    // contended migration from turning into an activate timeout.
    assert.ok(PLUGIN_MIGRATION_LOCK_WAIT_MS > 0);
    assert.ok(PLUGIN_MIGRATION_LOCK_WAIT_MS <= 5_000);
  });

  // ── The counter-proof case ────────────────────────────────────────────────
  //
  // Two runners start together against the same ledger. Without the advisory
  // lock both read an empty ledger, both decide the file is pending, and both
  // execute it — `CREATE TABLE` (no IF NOT EXISTS) then fails with 42P07 for
  // the loser, or the ledger ends up with a duplicate row. With the lock, one
  // applies and the other skips.
  //
  // Repeated so a pass is not a coincidence: a race that reproduces "usually"
  // must be run more than once to have said anything.
  it('two concurrent runners apply each migration exactly once', async () => {
    await writeFile(
      join(dir, '0001_create.sql'),
      `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`,
    );

    const [a, b] = await Promise.all([
      runPluginMigrations({ pool, pluginId, ledger, dir }),
      runPluginMigrations({ pool, pluginId, ledger, dir }),
    ]);

    const appliedTotal = a.applied.length + b.applied.length;
    const skippedTotal = a.skipped.length + b.skipped.length;
    assert.equal(
      appliedTotal,
      1,
      `expected exactly one runner to apply the migration, got ${String(appliedTotal)}`,
    );
    assert.equal(skippedTotal, 1, 'the other runner should have skipped it');

    // And the ledger holds exactly one row — a duplicate would mean the two
    // transactions both wrote, which is the failure the lock prevents.
    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${ledger}"`,
    );
    assert.equal(rows.rows[0]?.n, '1');

    await cleanup(`${ledger}_data`);
  });

  it('five concurrent runners still apply each migration exactly once', async () => {
    await writeFile(
      join(dir, '0001_create.sql'),
      `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`,
    );
    await writeFile(
      join(dir, '0002_more.sql'),
      `CREATE TABLE "${ledger}_more" (id INT PRIMARY KEY);`,
    );

    const reports = await Promise.all(
      Array.from({ length: 5 }, () =>
        runPluginMigrations({ pool, pluginId, ledger, dir }),
      ),
    );

    const applied = reports.flatMap((r) => r.applied).sort();
    assert.deepEqual(
      applied,
      ['0001_create.sql', '0002_more.sql'],
      'each migration must be applied by exactly one of the five runners',
    );

    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${ledger}"`,
    );
    assert.equal(rows.rows[0]?.n, '2');

    await cleanup(`${ledger}_data`, `${ledger}_more`);
  });

  it('different plugins do not serialise against each other', async () => {
    // The lock is keyed on the ledger, so two unrelated plugins migrating at
    // once must not block one another — otherwise every boot would serialise
    // every plugin's schema through one lock.
    const otherMark = randomUUID().replace(/-/g, '').slice(0, 10);
    const otherId = `@omadia/t${otherMark}`;
    const otherLedger = `omadia_t${otherMark}_migrations`;
    const otherDir = await mkdtemp(join(tmpdir(), 'c7-mig-b-'));
    await writeFile(
      join(dir, '0001.sql'),
      `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`,
    );
    await writeFile(
      join(otherDir, '0001.sql'),
      `CREATE TABLE "${otherLedger}_data" (id INT PRIMARY KEY);`,
    );

    const [one, two] = await Promise.all([
      runPluginMigrations({ pool, pluginId, ledger, dir }),
      runPluginMigrations({
        pool,
        pluginId: otherId,
        ledger: otherLedger,
        dir: otherDir,
      }),
    ]);
    assert.deepEqual(one.applied, ['0001.sql']);
    assert.deepEqual(two.applied, ['0001.sql']);

    await pool.query(`DROP TABLE IF EXISTS "${otherLedger}_data"`);
    await pool.query(`DROP TABLE IF EXISTS "${otherLedger}"`);
    await rm(otherDir, { recursive: true, force: true });
    await cleanup(`${ledger}_data`);
  });

  it('a nested migrations subdirectory is ignored, not descended into', async () => {
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'nested', '0001_deep.sql'), 'SELECT 1;');
    await writeFile(
      join(dir, '0001_top.sql'),
      `CREATE TABLE "${ledger}_data" (id INT PRIMARY KEY);`,
    );
    const report = await runPluginMigrations({ pool, pluginId, ledger, dir });
    assert.deepEqual(report.applied, ['0001_top.sql']);
    await cleanup(`${ledger}_data`);
  });
});

describe('#470 C7 PostgresPluginSqlGrantStore', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: PostgresPluginSqlGrantStore;
  const mark = randomUUID().replace(/-/g, '').slice(0, 10);
  const pluginA = `@omadia/g${mark}a`;
  const pluginB = `@omadia/g${mark}b`;
  const ledgerA = `omadia_g${mark}a_migrations`;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    await pool.query(GRANTS_SCHEMA);
    store = new PostgresPluginSqlGrantStore(pool);
  });

  after(async () => {
    await pool.query(`DELETE FROM plugin_sql_grants WHERE plugin_id LIKE $1`, [
      `%${mark}%`,
    ]);
    await pool.end();
  });

  it('records, reads back and revokes a grant', async () => {
    assert.equal(await store.get(pluginA), undefined);

    await store.grant(pluginA, ledgerA, 'operator@example.com');
    const row = await store.get(pluginA);
    assert.equal(row?.pluginId, pluginA);
    assert.equal(row?.ledger, ledgerA);
    assert.equal(row?.grantedBy, 'operator@example.com');
    assert.ok(row?.grantedAt instanceof Date);

    assert.equal(await store.revoke(pluginA), true);
    assert.equal(await store.revoke(pluginA), false);
    assert.equal(await store.get(pluginA), undefined);
  });

  it('re-granting the same plugin is idempotent, not a duplicate', async () => {
    await store.grant(pluginA, ledgerA, 'first@example.com');
    await store.grant(pluginA, ledgerA, 'second@example.com');
    const row = await store.get(pluginA);
    assert.equal(row?.grantedBy, 'second@example.com');
    await store.revoke(pluginA);
  });

  it('refuses to grant a ledger another plugin already owns', async () => {
    // This is the ACTUAL anti-hijack enforcement — the prefix rule in
    // `pluginSqlGrants.ts` cannot cover the `acme_tool` / `acme_tool_extra`
    // case, and this constraint has no such edge.
    await store.grant(pluginA, ledgerA, 'operator@example.com');
    await assert.rejects(
      store.grant(pluginB, ledgerA, 'operator@example.com'),
      (err: unknown) => {
        assert.ok(err instanceof LedgerAlreadyOwnedError);
        assert.equal(err.ledger, ledgerA);
        return true;
      },
    );
    // The original owner is untouched.
    assert.equal((await store.get(pluginA))?.ledger, ledgerA);
    assert.equal(await store.get(pluginB), undefined);
    await store.revoke(pluginA);
  });

  it('reads fail CLOSED when the table is unreachable', async () => {
    // An unread row removes a PERMISSION, so degrading to "ungranted" costs
    // the plugin its database access and costs the operator nothing. The
    // inverse would hand out a pool on the strength of a failed query.
    // `pgAvailable` already implies a URL, but the suite-level skip is not a
    // type narrowing — assert it so the check is a runtime fact rather than a
    // non-null assertion that would silently pass a bad value to `pg`.
    assert.ok(PG_URL, 'probe reported reachable without a URL');
    const broken = new Pool({
      connectionString: PG_URL.replace(/\/[^/]*$/, '/definitely_not_a_db'),
      max: 1,
    });
    const brokenStore = new PostgresPluginSqlGrantStore(broken);
    assert.equal(await brokenStore.get(pluginA), undefined);
    assert.deepEqual(await brokenStore.listAll(), []);
    await broken.end().catch(() => undefined);
  });
});
