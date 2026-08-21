/**
 * Epic #470 C11 — the plugin-facing half: `ctx.sql.seedLedger`.
 *
 * `pluginMigrationHandoff.pg.test.ts` proves the mechanism. This file proves
 * the WIRING, which is the part that has failed silently in this repo before:
 * a capability declared, typed and documented, but never actually threaded to
 * the consumer, so every test passes against a feature nobody can reach.
 *
 * So each case here goes through `createPluginContext` and asserts on
 * behaviour a plugin author would observe:
 *
 *   - the accessor exists on a granted context and is absent on an ungranted
 *     one, so the `ctx.sql.seedLedger?.()` guard in the plugin is not
 *     decorative;
 *   - core, not the plugin, names the donor ledger;
 *   - a `.js` file adopts the `.sql` row core recorded, matched by stem;
 *   - a witness that is not exactly one boolean is rejected, not coerced;
 *   - a malformed entry list is refused.
 *
 * Fixture names are neutral and suffixed per case: core's decoupling ratchet
 * counts the extracted plugin's identifiers in `middleware/test`, and this
 * suite writes into the REAL core donor ledger, which it must leave exactly as
 * it found it.
 */

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import type {
  LedgerSeedReport,
  SeedLedgerOptions,
} from '@omadia/plugin-api';
import { SqlMigrationError } from '@omadia/plugin-api';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { CORE_MIGRATION_DONOR_LEDGER } from '../src/platform/pluginMigrationHandoff.js';
import {
  createPluginContext,
  type CreatePluginContextOptions,
} from '../src/platform/pluginContext.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import {
  adaptManifestV1,
  type PluginCatalog,
} from '../src/plugins/manifestLoader.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'pluginMigrationHandoffAccessor',
  vars: ['PLUGIN_SQL_PG_TEST_URL', 'GRAPH_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

describe('#470 C11 ctx.sql.seedLedger', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let root: string;
  let suffix: string;
  let pluginId: string;
  let ledger: string;
  let table: string;
  /** The plugin's own file. */
  let file: string;
  /** The name core's migrator would have recorded for the same migration. */
  let donorRow: string;

  before(() => {
    pool = new Pool({ connectionString: PG_URL, max: 4 });
  });

  after(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    pluginId = `@test/adopt-${suffix}`;
    ledger = `plg_test_adopt_${suffix}_mig`;
    table = `c11a_${suffix}`;
    file = `c11a_${suffix}_step.js`;
    donorRow = `c11a_${suffix}_step.sql`;
    root = await mkdtemp(join(tmpdir(), 'c11-accessor-'));
    await mkdir(join(root, 'migrations'));
    await writeFile(
      join(root, 'migrations', file),
      `export default async (client) => { await client.query('CREATE TABLE IF NOT EXISTS ${table} (id int)'); };\n`,
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DROP TABLE IF EXISTS ${ledger}`);
    // The donor here is the REAL core ledger. This suite only ever adds its
    // own suffixed rows and removes exactly those. It never drops the table.
    await pool
      .query(`DELETE FROM ${CORE_MIGRATION_DONOR_LEDGER} WHERE id = $1`, [
        donorRow,
      ])
      .catch(() => undefined);
  });

  function catalogFor(declared: boolean): PluginCatalog {
    const manifest = {
      schema_version: '1',
      identity: {
        id: pluginId,
        name: pluginId,
        version: '1.0.0',
        kind: 'extension',
        domain: 'test.adopt',
      },
      requires: ['graphPool@^1'],
      provides: [],
      permissions: declared ? { sql: { ledger, migrations: 'migrations' } } : {},
    };
    const plugin = adaptManifestV1(manifest);
    assert.ok(plugin, 'fixture manifest must adapt');
    const entries = new Map([
      [
        plugin.id,
        { plugin, manifest, source_path: 'test', source_kind: 'manifest-v1' },
      ],
    ]);
    return {
      get: (id: string) => entries.get(id),
      list: () => [...entries.values()],
    } as unknown as PluginCatalog;
  }

  function makeCtx(opts: {
    declared: boolean;
    granted: boolean;
  }): ReturnType<typeof createPluginContext> {
    const stub = (): (() => void) => (): void => {};
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.provide('graphPool', pool);
    return createPluginContext({
      agentId: pluginId,
      vault: {
        get: async (): Promise<undefined> => undefined,
        listKeys: async (): Promise<string[]> => [],
      },
      registry: { has: () => true, list: () => [], get: () => undefined },
      catalog: catalogFor(opts.declared),
      serviceRegistry,
      sqlGranted: opts.granted,
      packageRoot: root,
      nativeToolRegistry: { register: stub, registerHandler: stub },
      routeRegistry: { register: stub, disposeBySource: () => 0 },
      jobScheduler: { register: stub, stopForPlugin: (): void => {} },
      notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
      uiRouteCatalog: { register: stub, registerNav: stub },
      logger: (): void => {},
    } as unknown as CreatePluginContextOptions);
  }

  /**
   * Narrow `ctx.sql.seedLedger` once, and assert on the way through.
   *
   * The method is OPTIONAL on the contract — that is the whole point of the
   * version guard a plugin writes — so every call site would otherwise need
   * its own `?.`, and a `?.` in a test silently turns a missing method into a
   * skipped assertion. Narrowing here means a core that stopped exposing it
   * fails loudly, once.
   */
  /** The SQL accessor, narrowed. Absent means the grant did not land. */
  function sqlOf(
    ctx: ReturnType<typeof createPluginContext>,
  ): NonNullable<ReturnType<typeof createPluginContext>['sql']> {
    assert.ok(ctx.sql, 'a granted plugin gets the accessor');
    return ctx.sql;
  }

  function seedLedgerOf(
    ctx: ReturnType<typeof createPluginContext>,
  ): (opts: SeedLedgerOptions) => Promise<LedgerSeedReport> {
    const sql = sqlOf(ctx);
    const seed = sql.seedLedger;
    assert.ok(seed, 'and the C11 seedLedger method');
    return seed.bind(sql);
  }

  function witnessSql(): string {
    return `SELECT to_regclass('public.${table}') IS NOT NULL`;
  }

  async function ensureDonorLedger(): Promise<void> {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${CORE_MIGRATION_DONOR_LEDGER} (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
  }

  it('is absent when the operator has not granted permissions.sql', () => {
    const ctx = makeCtx({ declared: true, granted: false });
    assert.equal(
      ctx.sql,
      undefined,
      'the whole accessor goes, not just this method — which is why the plugin guards with `if (ctx.sql)`',
    );
  });

  it('adopts a .sql donor row for a .js file, and the runner then skips it', async () => {
    const ctx = makeCtx({ declared: true, granted: true });
    const seedLedger = seedLedgerOf(ctx);

    await ensureDonorLedger();
    await pool.query(
      `INSERT INTO ${CORE_MIGRATION_DONOR_LEDGER} (id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [donorRow],
    );
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id int)`);

    const report = await seedLedger({
      entries: [{ filename: file, witnessSql: witnessSql() }],
    });

    assert.deepEqual([...report.seeded], [file]);
    assert.deepEqual(
      [...report.donorRecorded],
      [file],
      'the .js file matched the .sql row by stem',
    );
    assert.equal(
      report.donorLedger,
      CORE_MIGRATION_DONOR_LEDGER,
      'the plugin has no field for this — core supplies it',
    );
    assert.equal(report.ledger, ledger);

    // The runner honours the seeded row, checksum guard included.
    const migrated = await sqlOf(ctx).runMigrations();
    assert.deepEqual([...migrated.applied], []);
    assert.deepEqual([...migrated.skipped], [file]);

    // And the donor row survived.
    const still = await pool.query(
      `SELECT 1 FROM ${CORE_MIGRATION_DONOR_LEDGER} WHERE id = $1`,
      [donorRow],
    );
    assert.equal(still.rows.length, 1, 'nothing in the handoff deletes');
  });

  it('does not seed when the witness is false, and the runner then applies the file', async () => {
    const ctx = makeCtx({ declared: true, granted: true });
    const seedLedger = seedLedgerOf(ctx);
    await ensureDonorLedger();
    await pool.query(
      `INSERT INTO ${CORE_MIGRATION_DONOR_LEDGER} (id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [donorRow],
    );

    const report = await seedLedger({
      entries: [{ filename: file, witnessSql: witnessSql() }],
    });
    assert.deepEqual([...report.seeded], []);
    assert.deepEqual([...report.applied], [file]);
    assert.deepEqual(
      [...report.skippedNoWitness],
      [file],
      'core said applied, the catalog disagreed — this is the alarm',
    );

    const migrated = await sqlOf(ctx).runMigrations();
    assert.deepEqual([...migrated.applied], [file]);
  });

  it('dryRun through the accessor writes nothing', async () => {
    const ctx = makeCtx({ declared: true, granted: true });
    const seedLedger = seedLedgerOf(ctx);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id int)`);

    const report = await seedLedger({
      entries: [{ filename: file, witnessSql: witnessSql() }],
      dryRun: true,
    });
    assert.equal(report.dryRun, true);
    assert.deepEqual([...report.seeded], [file]);

    const exists = await pool.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [`public.${ledger}`],
    );
    assert.equal(exists.rows[0]?.present, false, 'not even the ledger DDL');
  });

  it('rejects a witness that is not exactly one boolean', async () => {
    const ctx = makeCtx({ declared: true, granted: true });
    const seedLedger = seedLedgerOf(ctx);

    // `SELECT count(*)` is the tempting wrong witness: 1 for a table that
    // exists, 0 for one that exists but is empty, and a THROW for one that
    // does not. Coercing truthiness would have accepted all three readings.
    await assert.rejects(
      seedLedger({
        entries: [{ filename: file, witnessSql: 'SELECT 1 AS n' }],
      }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /boolean/);
        return true;
      },
    );
  });

  it('refuses a multi-command witness through ctx.sql.seedLedger and leaves the canary intact', async () => {
    const ctx = makeCtx({ declared: true, granted: true });
    const seedLedger = seedLedgerOf(ctx);
    const canary = `c11a_${suffix}_canary`;
    await pool.query(`CREATE TABLE IF NOT EXISTS ${canary} (id int)`);

    await assert.rejects(
      seedLedger({
        entries: [
          {
            filename: file,
            witnessSql: `SELECT true AS ok; COMMIT; DROP TABLE ${canary}`,
          },
        ],
      }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /multiple commands/i);
        return true;
      },
    );

    const canaryExists = await pool.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [`public.${canary}`],
    );
    const ledgerExists = await pool.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [`public.${ledger}`],
    );
    assert.equal(canaryExists.rows[0]?.present, true, 'the canary table survived');
    assert.equal(ledgerExists.rows[0]?.present, false, 'the refused seed left no plugin ledger behind');

    await pool.query(`DROP TABLE IF EXISTS ${canary}`);
  });

  it('rejects an empty entry list, a blank witness, and a duplicated filename', async () => {
    const ctx = makeCtx({ declared: true, granted: true });
    const seedLedger = seedLedgerOf(ctx);

    await assert.rejects(
      seedLedger({ entries: [] }),
      (err: unknown) => err instanceof SqlMigrationError,
    );
    await assert.rejects(
      seedLedger({ entries: [{ filename: file, witnessSql: '   ' }] }),
      (err: unknown) => err instanceof SqlMigrationError,
    );
    await assert.rejects(
      seedLedger({
        entries: [
          { filename: file, witnessSql: witnessSql() },
          { filename: file, witnessSql: 'SELECT false' },
        ],
      }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /twice/);
        return true;
      },
    );
  });

  it('refuses to seed a filename the package does not ship', async () => {
    const ctx = makeCtx({ declared: true, granted: true });
    const seedLedger = seedLedgerOf(ctx);

    await assert.rejects(
      seedLedger({
        entries: [{ filename: 'never_shipped.js', witnessSql: 'SELECT true' }],
      }),
      (err: unknown) => {
        assert.ok(err instanceof SqlMigrationError);
        assert.match(err.message, /never_shipped\.js/);
        return true;
      },
    );
  });
});
