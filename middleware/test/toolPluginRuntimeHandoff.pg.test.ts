/**
 * Epic #470 C15 — core runs the declared ledger handoff BEFORE its own
 * pre-activate migration runner.
 *
 * WHAT WENT WRONG (gap G7 of the 2026-08-21 acceptance run)
 * --------------------------------------------------------
 * C11 gave a plugin `ctx.sql.seedLedger` and documented it as "call this
 * before `runMigrations`". But core runs the plugin's migrations ITSELF,
 * before `activate()` — deliberately, so "the tables exist" is an invariant
 * activate() can rely on (C7). So on the one upgrade C11 was built for the
 * plugin's own call always arrived second, every ledger row was already
 * written, and the handoff could only ever report `alreadySeeded`.
 *
 * Nothing failed. The log read `0 seeded, 9 already seeded`, which is
 * indistinguishable from a healthy re-run — and `skippedNoWitness`, the one
 * alarm C11 exists to raise, could never fire.
 *
 * WHY THESE TESTS LOOK LIKE THIS
 * ------------------------------
 * The defect was ORDER, so asserting the outcome is not enough: a run that
 * seeds nothing and applies everything reaches a correct database too. Each
 * case therefore records the order the two steps ran in and asserts on it, and
 * `no-witness` asserts on the WARN — the output an operator actually sees.
 *
 * The suite drives the real `ToolPluginRuntime.activate()` against a real
 * on-disk package and a real Postgres, because the failure being fixed is a
 * WIRING failure: every unit of this was already correct and tested in
 * isolation. `pluginMigrationHandoffAccessor.pg.test.ts` was green while the
 * feature it covers was unreachable in production.
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

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { CORE_MIGRATION_DONOR_LEDGER } from '../src/platform/pluginMigrationHandoff.js';
import { PluginHandoffPlanError } from '../src/platform/pluginHandoffPlan.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import {
  adaptManifestV1,
  type PluginCatalog,
} from '../src/plugins/manifestLoader.js';
import {
  ToolPluginRuntime,
  type ToolPluginRuntimeDeps,
} from '../src/plugins/toolPluginRuntime.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'toolPluginRuntimeHandoff',
  vars: ['PLUGIN_SQL_PG_TEST_URL', 'GRAPH_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

/** How many migration files the fixture package ships. */
const FILE_COUNT = 3;

describe('#470 C15 pre-activate ledger handoff', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let root: string;
  let suffix: string;
  let pluginId: string;
  let ledger: string;
  /** The plugin's own migration filenames, in order. */
  let files: string[];
  /** The tables those files create. */
  let tables: string[];
  /** The names core's migrator recorded for the same migrations. */
  let donorRows: string[];
  /** Every log line the runtime emitted during the case. */
  let logs: string[];

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
    logs = [];
    files = [];
    tables = [];
    donorRows = [];

    root = await mkdtemp(join(tmpdir(), 'c15-runtime-'));
    await mkdir(join(root, 'migrations'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });

    for (let i = 1; i <= FILE_COUNT; i++) {
      const step = String(i).padStart(4, '0');
      const table = `c15_${suffix}_${step}`;
      const file = `${step}_step_${suffix}.js`;
      files.push(file);
      tables.push(table);
      // Core's migrator would have shipped the same migration as `.sql`; the
      // extracted plugin re-emits it as `.js`. The handoff matches by stem,
      // so the fixture has to reproduce that skew or it proves nothing.
      donorRows.push(`${step}_step_${suffix}.sql`);
      await writeFile(
        join(root, 'migrations', file),
        `export default async (client) => { await client.query('CREATE TABLE IF NOT EXISTS ${table} (id int)'); };\n`,
        'utf8',
      );
    }

    // A plugin whose activate() does nothing. The handoff under test happens
    // BEFORE this runs, which is the entire point.
    await writeFile(
      join(root, 'dist', 'plugin.js'),
      'export async function activate() { return { close: async () => {} }; }\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    for (const table of tables) {
      await pool.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    }
    await pool.query(`DROP TABLE IF EXISTS ${ledger}`).catch(() => undefined);
    // The donor here is the REAL core ledger. This suite only ever adds its
    // own suffixed rows and removes exactly those. It never drops the table.
    for (const row of donorRows) {
      await pool
        .query(`DELETE FROM ${CORE_MIGRATION_DONOR_LEDGER} WHERE id = $1`, [row])
        .catch(() => undefined);
    }
  });

  function witnessFor(table: string): string {
    return `SELECT to_regclass('public.${table}') IS NOT NULL`;
  }

  async function writeHandoffPlan(
    body: unknown = {
      entries: files.map((file, i) => ({
        filename: file,
        witnessSql: witnessFor(tables[i] as string),
      })),
    },
  ): Promise<void> {
    await writeFile(
      join(root, 'handoff-plan.json'),
      typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      'utf8',
    );
  }

  async function ensureDonorLedger(): Promise<void> {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${CORE_MIGRATION_DONOR_LEDGER} (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
  }

  /** The state a core-to-plugin upgrade starts from: core ran these. */
  async function seedDonorRows(): Promise<void> {
    await ensureDonorLedger();
    for (const row of donorRows) {
      await pool.query(
        `INSERT INTO ${CORE_MIGRATION_DONOR_LEDGER} (id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [row],
      );
    }
  }

  /** ...and left these tables behind. */
  async function createDonorTables(): Promise<void> {
    for (const table of tables) {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id int)`);
    }
  }

  function catalogFor(sqlPermission: Record<string, unknown>): PluginCatalog {
    const manifest = {
      schema_version: '1',
      identity: {
        id: pluginId,
        name: pluginId,
        version: '1.0.0',
        kind: 'extension',
        domain: 'test.adopt',
      },
      lifecycle: { entry: 'dist/plugin.js' },
      requires: ['graphPool@^1'],
      provides: [],
      permissions: { sql: sqlPermission },
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

  function runtimeFor(sqlPermission: Record<string, unknown>): ToolPluginRuntime {
    const stub = (): (() => void) => (): void => {};
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.provide('graphPool', pool);
    const deps = {
      catalog: catalogFor(sqlPermission),
      registry: { get: () => ({ status: 'active' }) },
      vault: {
        get: async (): Promise<undefined> => undefined,
        listKeys: async (): Promise<string[]> => [],
      },
      uploadedStore: {
        get: (id: string) => (id === pluginId ? { id, path: root } : undefined),
        list: () => [{ id: pluginId, path: root }],
      },
      serviceRegistry,
      nativeToolRegistry: { register: stub, registerHandler: stub },
      pluginRouteRegistry: { register: stub, disposeBySource: () => 0 },
      notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
      uiRouteCatalog: { register: stub, registerNav: stub },
      jobScheduler: { register: stub, stopForPlugin: (): void => {} },
      // The operator granted exactly the ledger the manifest declares.
      sqlGrantStore: {
        get: async (): Promise<{ ledger: string }> => ({ ledger }),
      },
      log: (msg: string): void => {
        logs.push(msg);
      },
    } as unknown as ToolPluginRuntimeDeps;
    return new ToolPluginRuntime(deps);
  }

  /**
   * Which of the two steps logged first.
   *
   * This is the assertion the old code could not pass. Reading the database
   * afterwards cannot tell the two orderings apart — both end with the tables
   * present and the ledger full.
   */
  function stepOrder(): string[] {
    const order: string[] = [];
    for (const line of logs) {
      // The WARN also says "ledger handoff" — it is the same step reporting a
      // second time, not a second step. Counting it would make the order read
      // `handoff, handoff, migrations` and quietly weaken every assertion
      // here into "a handoff happened at some point".
      if (line.includes('WARN')) continue;
      if (line.includes('ledger handoff')) order.push('handoff');
      else if (line.includes('migration(s) to ledger')) order.push('migrations');
    }
    return order;
  }

  function handoffLine(): string {
    const line = logs.find(
      (l) => l.includes('ledger handoff') && !l.includes('WARN'),
    );
    assert.ok(line, `no handoff line in:\n${logs.join('\n')}`);
    return line;
  }

  async function ledgerRows(): Promise<string[]> {
    // `filename` is the plugin ledger's primary key — see `pluginLedgerDdl`,
    // which is exported precisely so the runner and the seeder cannot drift.
    const res = await pool.query<{ filename: string }>(
      `SELECT filename FROM ${ledger} ORDER BY filename`,
    );
    return res.rows.map((r) => r.filename);
  }

  it('seeds from the donor and leaves the runner nothing to do', async () => {
    // The upgrade C11 was built for: core's rows AND core's tables are there.
    await seedDonorRows();
    await createDonorTables();
    await writeHandoffPlan();

    await runtimeFor({ ledger, migrations: 'migrations', handoff: 'handoff-plan.json' }).activate(
      pluginId,
    );

    assert.deepEqual(
      stepOrder(),
      ['handoff'],
      'the handoff ran, and the runner then had nothing to log — the runner only logs when it applies',
    );
    assert.match(handoffLine(), new RegExp(`${String(FILE_COUNT)} seeded`));
    assert.match(handoffLine(), /0 left for the migration runner/);
    assert.deepEqual(
      await ledgerRows(),
      [...files].sort(),
      'every file is recorded as applied without having been re-applied',
    );

    const donor = await pool.query(
      `SELECT id FROM ${CORE_MIGRATION_DONOR_LEDGER} WHERE id = ANY($1::text[])`,
      [donorRows],
    );
    assert.equal(
      donor.rows.length,
      FILE_COUNT,
      'nothing in the handoff deletes — those rows are the rollback path',
    );
  });

  it('runs the handoff BEFORE the migration runner', async () => {
    // Same donor rows, but the tables are gone. Both steps have work to do,
    // so both log — which is the only configuration where the ORDER is
    // directly observable.
    await seedDonorRows();
    await writeHandoffPlan();

    await runtimeFor({ ledger, migrations: 'migrations', handoff: 'handoff-plan.json' }).activate(
      pluginId,
    );

    assert.deepEqual(
      stepOrder(),
      ['handoff', 'migrations'],
      'inverted here is the whole bug: the runner writes the ledger rows the handoff was meant to decide on',
    );
  });

  it('raises the skippedNoWitness alarm when the rows are there and the schema is not', async () => {
    // A restore from an older snapshot, a rolled-back deploy, a dropped table.
    // Donor rows present, schema objects absent. This is the one output C11
    // was built to produce and the one G7 made unreachable.
    await seedDonorRows();
    await writeHandoffPlan();

    await runtimeFor({ ledger, migrations: 'migrations', handoff: 'handoff-plan.json' }).activate(
      pluginId,
    );

    assert.match(handoffLine(), /0 seeded/);
    assert.match(
      handoffLine(),
      new RegExp(`${String(FILE_COUNT)} left for the migration runner`),
    );

    const warn = logs.find((l) => l.includes('WARN') && l.includes('witness'));
    assert.ok(warn, `no witness WARN in:\n${logs.join('\n')}`);
    for (const file of files) {
      assert.ok(
        warn.includes(file),
        `the WARN must name '${file}' — a count alone does not tell an operator where to look`,
      );
    }

    // And the runner then repaired it, which is what makes the alarm safe to
    // be a warning rather than a refusal.
    assert.deepEqual(stepOrder(), ['handoff', 'migrations']);
    assert.deepEqual(await ledgerRows(), [...files].sort());
    for (const table of tables) {
      const exists = await pool.query<{ ok: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS ok`,
        [`public.${table}`],
      );
      assert.equal(exists.rows[0]?.ok, true, `${table} was repaired by the runner`);
    }
  });

  it('changes nothing for a plugin that declares no handoff', async () => {
    await seedDonorRows();
    await createDonorTables();
    await writeHandoffPlan();

    // The plan file is present on disk and is deliberately ignored: what
    // switches the step on is the MANIFEST, not the presence of a file.
    await runtimeFor({ ledger, migrations: 'migrations' }).activate(pluginId);

    assert.deepEqual(
      stepOrder(),
      ['migrations'],
      'no handoff step, and the runner behaves exactly as it did before C15',
    );
    assert.deepEqual(await ledgerRows(), [...files].sort());
  });

  it('refuses activation when the declared plan is malformed', async () => {
    await seedDonorRows();
    await createDonorTables();
    await writeHandoffPlan({ entries: [{ filename: files[0] }] });

    const err = await runtimeFor({
      ledger,
      migrations: 'migrations',
      handoff: 'handoff-plan.json',
    })
      .activate(pluginId)
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    assert.ok(
      err instanceof PluginHandoffPlanError,
      `expected a PluginHandoffPlanError, got ${String(err)}`,
    );
    assert.equal(err.reason, 'malformed');
    assert.deepEqual(
      stepOrder(),
      [],
      'a plugin whose handoff cannot be read does not get its migrations run either — ' +
        'core would otherwise write the ledger rows the refused plan was meant to decide on, ' +
        'which is exactly the state the plan existed to avoid',
    );
  });

  it('refuses activation when the declared plan escapes the package root', async () => {
    await seedDonorRows();
    const err = await runtimeFor({
      ledger,
      migrations: 'migrations',
      handoff: '../handoff-plan.json',
    })
      .activate(pluginId)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(err instanceof PluginHandoffPlanError, `got ${String(err)}`);
    assert.equal(err.reason, 'escapes-package-root');
  });

  it('writes nothing when the plan asks for a dry run', async () => {
    await seedDonorRows();
    await createDonorTables();
    await writeHandoffPlan({
      dryRun: true,
      entries: files.map((file, i) => ({
        filename: file,
        witnessSql: witnessFor(tables[i] as string),
      })),
    });

    await runtimeFor({ ledger, migrations: 'migrations', handoff: 'handoff-plan.json' }).activate(
      pluginId,
    );

    assert.match(handoffLine(), /dry run/);
    assert.deepEqual(
      stepOrder(),
      ['handoff', 'migrations'],
      'a dry run reports and writes nothing, so the runner still applies every file',
    );
  });
});
