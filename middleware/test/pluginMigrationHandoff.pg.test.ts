/**
 * Epic #470 C11 — the migration handoff, against a real Postgres.
 *
 * WHY THIS SUITE NEEDS A REAL DATABASE
 * ------------------------------------
 * Every property under test is a property of the SERVER:
 *
 *   - `to_regclass` really returns NULL for an object that is not there, which
 *     is the entire mechanism of a witness.
 *   - A seeded row really makes `runPluginMigrations` skip the file — including
 *     its checksum guard, which is the half a fake would never exercise and the
 *     half that turns a bad seed into an activation failure one boot later.
 *   - `pg_advisory_xact_lock` really serialises two concurrent seeders.
 *   - `ROLLBACK` really un-does the dry run, including the ledger DDL.
 *
 * NAMES ARE DELIBERATELY NEUTRAL. This suite lives in core, and the epic #470
 * extraction rule kept every one of the extracted plugin's identifiers out of
 * `middleware/test` (the ratchet that enforced it was retired in C14). The mechanism is
 * generic — any plugin adopting any core ledger — so the fixture is generic
 * too. The nine REAL witnesses are documented in the epic README under
 * `specs/470-dev-…-plugin/README.md` and shipped by the plugin repo, which
 * is where they belong.
 *
 * Skips cleanly (issue #572: no hardcoded default port) when no test database
 * is configured.
 */

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { SqlMigrationError } from '@omadia/plugin-api';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import {
  migrationStem,
  seedPluginLedgerFromDonor,
  type MigrationWitness,
} from '../src/platform/pluginMigrationHandoff.js';
import { runPluginMigrations } from '../src/platform/pluginMigrations.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'pluginMigrationHandoff',
  vars: ['PLUGIN_SQL_PG_TEST_URL', 'GRAPH_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

/** How many files the fixture ships. Nine, to mirror the real handoff's shape
 *  — the one number about the real case worth carrying into the fixture. */
const FILE_COUNT = 9;

describe('#470 C11 seedPluginLedgerFromDonor', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let dir: string;
  let suffix: string;
  let pluginId: string;
  let ledger: string;
  let donorLedger: string;
  let tables: string[];
  let files: string[];
  let donorFilenames: string[];
  let witnesses: Record<string, MigrationWitness>;

  before(() => {
    pool = new Pool({ connectionString: PG_URL, max: 8 });
  });

  after(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Per-case identity, so cases never share a ledger, a donor or a table and
    // the suite is safe to run concurrently with itself.
    suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    pluginId = `@test/handoff-${suffix}`;
    ledger = `plg_test_handoff_${suffix}_mig`;
    donorLedger = `_c11_donor_${suffix}`;
    dir = await mkdtemp(join(tmpdir(), 'c11-handoff-'));

    tables = [];
    files = [];
    donorFilenames = [];
    witnesses = {};
    for (let i = 1; i <= FILE_COUNT; i += 1) {
      const table = `c11_${suffix}_t${String(i)}`;
      // The plugin ships `.js`; the donor recorded `.sql`. Matching by STEM is
      // the property that makes the handoff work at all for a codegen'd
      // package, so the fixture never lets the two names be equal.
      const file = `000${String(i)}_step.js`;
      const donorFile = `000${String(i)}_step.sql`;
      await writeFile(
        join(dir, file),
        `export default async (client) => { await client.query('CREATE TABLE IF NOT EXISTS ${table} (id int)'); };\n`,
        'utf8',
      );
      tables.push(table);
      files.push(file);
      donorFilenames.push(donorFile);
      witnesses[file] = witnessFor(table);
    }

    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${donorLedger} (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    for (const table of tables) {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await pool.query(`DROP TABLE IF EXISTS ${ledger}`);
    await pool.query(`DROP TABLE IF EXISTS ${donorLedger}`);
  });

  /** A witness that is true exactly when `table` exists. `to_regclass` is used
   *  rather than a `::regclass` cast because the cast THROWS on a missing
   *  object — which is the case the witness exists to detect. */
  function witnessFor(table: string): MigrationWitness {
    return `SELECT to_regclass('public.${table}') IS NOT NULL AS present`;
  }

  async function recordDonorRows(names: readonly string[]): Promise<void> {
    for (const name of names) {
      await pool.query(
        `INSERT INTO ${donorLedger} (id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [name],
      );
    }
  }

  /** Create the schema objects the fixture's migrations would create, without
   *  going through the runner — the "core already applied these" state. */
  async function createObjects(): Promise<void> {
    for (const table of tables) {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id int)`);
    }
  }

  function seed(
    overrides: Partial<Parameters<typeof seedPluginLedgerFromDonor>[0]> = {},
  ): ReturnType<typeof seedPluginLedgerFromDonor> {
    return seedPluginLedgerFromDonor({
      pool,
      pluginId,
      ledger,
      dir,
      donor: { ledgerTable: donorLedger, filenames: files },
      witnesses,
      ...overrides,
    });
  }

  function migrate(): ReturnType<typeof runPluginMigrations> {
    return runPluginMigrations({ pool, pluginId, ledger, dir });
  }

  async function ledgerRowCount(): Promise<number> {
    if (!(await ledgerExists())) return 0;
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${ledger}`,
    );
    return Number(r.rows[0]?.n ?? '0');
  }

  async function ledgerExists(): Promise<boolean> {
    return tableExists(ledger);
  }

  async function tableExists(table: string): Promise<boolean> {
    const r = await pool.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [`public.${table}`],
    );
    return r.rows[0]?.present === true;
  }

  async function rowCount(table: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`,
    );
    return Number(r.rows[0]?.n ?? '0');
  }

  // --- (a) the happy handoff ------------------------------------------------

  it('seeds every file when the donor recorded it AND the schema is there, and the runner then applies none', async () => {
    await recordDonorRows(donorFilenames);
    await createObjects();

    const plan = await seed();

    assert.equal(plan.seeded.length, FILE_COUNT, 'all nine adopt');
    assert.deepEqual([...plan.applied], [], 'nothing left for the runner');
    assert.deepEqual([...plan.skippedNoWitness], []);
    assert.deepEqual([...plan.donorRecorded].sort(), [...files].sort());
    assert.equal(plan.ledger, ledger);
    assert.equal(plan.donorLedger, donorLedger);
    assert.equal(plan.dryRun, false);

    // The real assertion. A seeded row is only worth anything if the runner
    // treats it as applied — including its checksum guard, which throws when
    // the seeded checksum is not the one the runner would compute.
    const report = await migrate();
    assert.deepEqual([...report.applied], [], 'runner applies nothing');
    assert.equal(report.skipped.length, FILE_COUNT, 'runner skips all nine');
  });

  // --- (b) the restore: rows present, tables absent -------------------------

  it('seeds NOTHING when the donor recorded the files but the schema objects are absent', async () => {
    await recordDonorRows(donorFilenames);
    // Deliberately do NOT create the objects: a snapshot restored from before
    // they existed, a rolled-back deploy, an incident drop.

    const plan = await seed();

    assert.deepEqual([...plan.seeded], [], 'a naive seed would write nine rows here');
    assert.equal(plan.applied.length, FILE_COUNT);
    assert.equal(
      plan.skippedNoWitness.length,
      FILE_COUNT,
      'every one of them is a donor row the catalog contradicts',
    );
    assert.equal(plan.donorRecorded.length, FILE_COUNT);

    const report = await migrate();
    assert.equal(report.applied.length, FILE_COUNT, 'the runner repairs the schema');
    for (const table of tables) {
      const r = await pool.query<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS present',
        [`public.${table}`],
      );
      assert.equal(r.rows[0]?.present, true, `${table} exists after the repair`);
    }
  });

  // --- (c) witness without donor row ---------------------------------------

  it('seeds on the witness alone when the donor ledger has no row for the file', async () => {
    await createObjects();
    // No donor rows at all: core's ledger was lost, truncated, or the objects
    // were created by an operator restoring a schema-only dump.

    const plan = await seed();

    assert.equal(plan.seeded.length, FILE_COUNT, 'the catalog is the authority');
    assert.deepEqual([...plan.donorRecorded], [], 'and it agrees with nothing');
    assert.deepEqual([...plan.skippedNoWitness], []);

    const report = await migrate();
    assert.deepEqual([...report.applied], []);
  });

  it('seeds nothing when neither the donor nor the catalog knows the file', async () => {
    const plan = await seed();
    assert.deepEqual([...plan.seeded], []);
    assert.equal(plan.applied.length, FILE_COUNT);
    assert.deepEqual(
      [...plan.skippedNoWitness],
      [],
      'no donor row means no disagreement to report',
    );
  });

  it('never seeds a file that has no witness at all', async () => {
    await recordDonorRows(donorFilenames);
    await createObjects();
    const withoutOne = { ...witnesses };
    delete withoutOne[files[0] as string];

    const plan = await seed({ witnesses: withoutOne });

    assert.equal(plan.seeded.length, FILE_COUNT - 1);
    assert.deepEqual(
      [...plan.applied],
      [files[0]],
      'absence of proof is not proof — the idempotent file runs',
    );
  });

  // --- (d) dryRun writes nothing -------------------------------------------

  it('dryRun returns the plan and writes nothing at all', async () => {
    await recordDonorRows(donorFilenames);
    await createObjects();

    const plan = await seed({ dryRun: true });

    assert.equal(plan.dryRun, true);
    assert.equal(plan.seeded.length, FILE_COUNT, 'the plan is the real plan');
    assert.deepEqual([...plan.applied], []);
    assert.equal(
      await ledgerExists(),
      false,
      'even the CREATE TABLE IF NOT EXISTS is rolled back',
    );

    // And the same call without dryRun still has all nine to do, which is the
    // only way to prove the dry run left no partial state behind.
    const real = await seed();
    assert.equal(real.seeded.length, FILE_COUNT);
    assert.equal(await ledgerRowCount(), FILE_COUNT);
  });

  it('dryRun on an existing ledger leaves its row count unchanged', async () => {
    await recordDonorRows(donorFilenames);
    await createObjects();
    // Seed exactly one file for real, so the dry run below has a non-empty
    // ledger to leave alone AND an `alreadySeeded` entry to report.
    const first = files[0] as string;
    await seed({
      donor: { ledgerTable: donorLedger, filenames: [first] },
      witnesses: { [first]: witnesses[first] as MigrationWitness },
    });
    const rowsBefore = await ledgerRowCount();
    assert.equal(rowsBefore, 1);

    const plan = await seed({ dryRun: true });

    assert.deepEqual([...plan.alreadySeeded], [first]);
    assert.equal(plan.seeded.length, FILE_COUNT - 1);
    assert.equal(await ledgerRowCount(), rowsBefore, 'nothing was written');
  });

  it('refuses a multi-command witness and leaves both the canary and plugin ledger untouched', async () => {
    const first = files[0] as string;
    const canary = `c11_${suffix}_canary_multi`;
    tables.push(canary);
    await recordDonorRows([donorFilenames[0] as string]);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${canary} (id int)`);

    await assert.rejects(
      seed({
        donor: { ledgerTable: donorLedger, filenames: [first] },
        witnesses: {
          [first]: `SELECT true AS ok; COMMIT; DROP TABLE ${canary}`,
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /multiple commands/i);
        return true;
      },
    );

    assert.equal(await tableExists(canary), true, 'the canary survived the refused witness');
    assert.equal(await ledgerExists(), false, 'the plugin ledger DDL did not survive the refusal');
  });

  it('refuses a genuine multi-command witness but still allows a semicolon inside a legal string literal', async () => {
    const first = files[0] as string;
    const canary = `c11_${suffix}_canary_quote`;
    tables.push(canary);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${canary} (id int)`);

    const legalLiteral = await seed({
      donor: { ledgerTable: donorLedger, filenames: [first] },
      witnesses: {
        [first]: "SELECT to_regclass('public.a;b') IS NOT NULL AS present",
      },
    });
    assert.deepEqual([...legalLiteral.seeded], []);
    assert.deepEqual([...legalLiteral.applied], [first]);
    // The ledger TABLE exists after this one: the witness was merely false, so
    // the seed committed normally and its `CREATE TABLE IF NOT EXISTS` stands.
    // Zero ROWS is the claim — a false witness seeds nothing. (The refusal
    // cases below assert the stronger `ledgerExists() === false`, because a
    // refused seed rolls the DDL back too.)
    assert.equal(await ledgerRowCount(), 0, 'a false witness leaves no ledger rows behind');

    await assert.rejects(
      seed({
        donor: { ledgerTable: donorLedger, filenames: [first] },
        witnesses: {
          [first]: `SELECT true AS ok; DROP TABLE ${canary}`,
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /multiple commands/i);
        return true;
      },
    );

    assert.equal(await tableExists(canary), true, 'the hostile semicolon did not reach the canary');
    // The ledger table is standing because the LEGAL-literal seed above
    // committed its DDL, not because this refusal leaked one. What the refusal
    // must not leave behind is a ROW: the multi-command witness never returned
    // a verdict, so nothing may be recorded as applied.
    assert.equal(await ledgerRowCount(), 0, 'the refusal recorded no ledger row');
  });

  it('refuses a witness that tries to write and leaves donor rows unchanged', async () => {
    const first = files[0] as string;
    await recordDonorRows([donorFilenames[0] as string]);
    const before = await rowCount(donorLedger);

    await assert.rejects(
      seed({
        donor: { ledgerTable: donorLedger, filenames: [first] },
        witnesses: {
          [first]: `DELETE FROM ${donorLedger} RETURNING true`,
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /read-only transaction/i);
        return true;
      },
    );

    assert.equal(await rowCount(donorLedger), before, 'the donor ledger row count is unchanged');
    assert.equal(await ledgerExists(), false, 'the failed witness did not leave a plugin ledger behind');
  });

  it('dryRun with a hostile witness leaves nothing behind', async () => {
    const first = files[0] as string;
    const canary = `c11_${suffix}_canary_dry`;
    tables.push(canary);
    await recordDonorRows([donorFilenames[0] as string]);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${canary} (id int)`);

    await assert.rejects(
      seed({
        donor: { ledgerTable: donorLedger, filenames: [first] },
        witnesses: {
          [first]: `SELECT true AS ok; COMMIT; DROP TABLE ${canary}`,
        },
        dryRun: true,
      }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /multiple commands/i);
        return true;
      },
    );

    assert.equal(await tableExists(canary), true, 'the canary survived the dry-run refusal');
    assert.equal(await ledgerExists(), false, 'dryRun still left no ledger behind');
  });

  it('still seeds a legitimate witness through the hardened execution path', async () => {
    const first = files[0] as string;
    await recordDonorRows([donorFilenames[0] as string]);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tables[0] as string} (id int)`);

    const plan = await seed({
      donor: { ledgerTable: donorLedger, filenames: [first] },
      witnesses: { [first]: witnesses[first] as MigrationWitness },
    });

    assert.deepEqual([...plan.seeded], [first]);
    assert.deepEqual([...plan.applied], []);
    assert.equal(await ledgerRowCount(), 1, 'the legitimate witness still seeds one row');
  });

  // --- (e) donor rows are never touched ------------------------------------

  it('leaves the donor ledger byte-for-byte intact — that is the rollback path', async () => {
    await recordDonorRows(donorFilenames);
    await createObjects();
    const snapshot = await pool.query<{ id: string; applied_at: Date }>(
      `SELECT id, applied_at FROM ${donorLedger} ORDER BY id`,
    );

    await seed();

    const afterSeed = await pool.query<{ id: string; applied_at: Date }>(
      `SELECT id, applied_at FROM ${donorLedger} ORDER BY id`,
    );
    assert.deepEqual(
      afterSeed.rows.map((r) => [r.id, r.applied_at.toISOString()]),
      snapshot.rows.map((r) => [r.id, r.applied_at.toISOString()]),
      'core must find its ledger exactly as it left it',
    );
  });

  // --- (f) concurrency ------------------------------------------------------

  it('serialises two concurrent seeders: one seeds, the other reports alreadySeeded', async () => {
    await recordDonorRows(donorFilenames);
    await createObjects();

    const [a, b] = await Promise.all([seed(), seed()]);

    const seededCounts = [a.seeded.length, b.seeded.length].sort((x, y) => x - y);
    const adoptedCounts = [a.alreadySeeded.length, b.alreadySeeded.length].sort(
      (x, y) => x - y,
    );
    assert.deepEqual(
      seededCounts,
      [0, FILE_COUNT],
      'exactly one of them did the work',
    );
    assert.deepEqual(
      adoptedCounts,
      [0, FILE_COUNT],
      'and the other saw it already done',
    );
    assert.equal(await ledgerRowCount(), FILE_COUNT, 'no duplicate rows');
  });

  // --- counter-proof: remove the witness check -----------------------------

  it('COUNTER-PROOF: a donor-row-only seed passes case (b) and leaves the installation broken', async () => {
    await recordDonorRows(donorFilenames);
    // Tables absent — the exact state case (b) covers.

    // The naive implementation this module exists to refuse: copy the donor's
    // rows, skip those files. Written out rather than described, because "the
    // witness is load-bearing" is a claim, and this is the evidence.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${ledger} (filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    const donorRows = await pool.query<{ id: string }>(
      `SELECT id FROM ${donorLedger}`,
    );
    for (const row of donorRows.rows) {
      const file = `${migrationStem(row.id)}.js`;
      await pool.query(
        `INSERT INTO ${ledger} (filename, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [file, 'copied-from-the-donor'],
      );
    }

    // The runner now believes everything is applied…
    const report = await runPluginMigrations({
      pool,
      pluginId,
      ledger,
      dir,
      allowChecksumDrift: true,
    });
    assert.deepEqual([...report.applied], [], 'the naive seed suppressed all nine');

    // …and the schema those files create is not there. This is the green
    // activation whose every request 500s.
    const present = await pool.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [`public.${tables[0] as string}`],
    );
    assert.equal(
      present.rows[0]?.present,
      false,
      'ledger says applied, catalog says absent — the failure the witness prevents',
    );
  });

  // --- guards ---------------------------------------------------------------

  it('refuses a donor ledger inside the kernel-owned plugin namespace', async () => {
    await assert.rejects(
      seed({ donor: { ledgerTable: 'plg_other_plugin_mig', filenames: files } }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /plg_/);
        return true;
      },
    );
  });

  it('refuses a donor identifier that is not in the allowlisted charset', async () => {
    await assert.rejects(
      seed({ donor: { ledgerTable: 'evil"; DROP TABLE x; --', filenames: files } }),
      (err: unknown) => err instanceof SqlMigrationError,
    );
  });

  it('refuses to seed a filename the migrations directory does not ship', async () => {
    await recordDonorRows(donorFilenames);
    await assert.rejects(
      seed({
        donor: { ledgerTable: donorLedger, filenames: [...files, '9999_ghost.js'] },
      }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /9999_ghost\.js/);
        return true;
      },
    );
  });

  it('treats a missing donor ledger as "no donor rows" rather than an error', async () => {
    await pool.query(`DROP TABLE IF EXISTS ${donorLedger}`);
    await createObjects();

    const plan = await seed();

    assert.deepEqual([...plan.donorRecorded], []);
    assert.equal(plan.seeded.length, FILE_COUNT, 'the witness still decides');
  });
});
