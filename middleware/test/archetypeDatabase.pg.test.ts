/**
 * #2088 (spec A §5.10, criterion 37) — the database of an archetype plugin
 * that owns it (its manifest does not require the shared pool), against a
 * real Postgres.
 *
 * Everything asserted here is a property of the SERVER: what a role that
 * logged in may read, what a migration running as another role may reach, who
 * owns a moved table. A fake would have each of them by construction.
 *
 * The kernel side connects as a role that is NOT a superuser: it owns its
 * database and may create roles, which is what a hosted Postgres gives an
 * instance. A superuser would pass every step whether or not the grants this
 * module issues are the ones it needs.
 */

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ServiceNotDeclaredError } from '@omadia/plugin-api';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import {
  ArchetypeDatabaseError,
  archetypeDatabaseNames,
  createArchetypeDatabase,
  ownDatabaseEdges,
  ownsItsDatabase,
  type ArchetypeDatabase,
} from '../src/platform/archetypeDatabase.js';
import {
  createPluginContext,
  type CreatePluginContextOptions,
} from '../src/platform/pluginContext.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import {
  ToolPluginRuntime,
  type ToolPluginRuntimeDeps,
} from '../src/plugins/toolPluginRuntime.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'archetypeDatabase',
  vars: ['PLUGIN_SQL_PG_TEST_URL', 'GRAPH_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const RUN = randomBytes(4).toString('hex');
const PLUGIN = `@k3t${RUN}/arch`;
const SIBLING = `@k3t${RUN}/arch-x`;
const NAMES = archetypeDatabaseNames(PLUGIN);
const LEDGER = `${NAMES.tablePrefix}migrations`;
const SECRET = randomBytes(32);

const FACILITATOR_BLOCK = {
  id: `k3t${RUN}`,
  label: { en: 'Test archetype', de: 'Testarchetyp' },
  label_plural: { en: 'Test archetypes', de: 'Testarchetypen' },
  description: { en: 'An archetype for the database tests.', de: 'Ein Archetyp für die Datenbanktests.' },
  noun: 'a test agent',
  omits: [],
  adds: [],
  requires: [],
};

function withUser(url: string, user: string, password: string, database?: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  if (database) u.pathname = `/${database}`;
  return u.toString();
}

async function codeOf(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).message;
  }
  return undefined;
}

describe('#2088 archetype plugin database', { skip: !pgAvailable }, () => {
  const adminRole = `k3t_admin_${RUN}`;
  const plainRole = `k3t_plain_${RUN}`;
  const database = `k3t_db_${RUN}`;
  const adminPassword = randomBytes(18).toString('base64url');
  let superuser: Pool;
  let admin: Pool;
  let adminUrl: string;
  let db: ArchetypeDatabase;
  let root: string;
  const logs: string[] = [];

  before(async () => {
    superuser = new Pool({ connectionString: PG_URL, max: 2 });
    await superuser.query(`CREATE ROLE ${adminRole} LOGIN PASSWORD '${adminPassword}' CREATEROLE`);
    await superuser.query(`CREATE ROLE ${plainRole} LOGIN PASSWORD '${adminPassword}'`);
    await superuser.query(`CREATE DATABASE ${database} OWNER ${adminRole}`);
    adminUrl = withUser(PG_URL as string, adminRole, adminPassword, database);
    admin = new Pool({ connectionString: adminUrl, max: 4 });
    // What the kernel has in `public`: its own tables, and a plugin's tables
    // from the time it still ran on the shared pool.
    await admin.query(`
      CREATE TABLE agents (id serial PRIMARY KEY, slug text NOT NULL);
      INSERT INTO agents (slug) VALUES ('mira');
      CREATE TABLE plugin_sql_grants (plugin_id text PRIMARY KEY, ledger text NOT NULL);
      INSERT INTO plugin_sql_grants VALUES ('${PLUGIN}', '${LEDGER}'), ('${SIBLING}', 'x');
      CREATE TABLE ${LEDGER} (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE ${NAMES.tablePrefix}things (id serial PRIMARY KEY, label text NOT NULL);
      CREATE INDEX ${NAMES.tablePrefix}things_label ON ${NAMES.tablePrefix}things (label);
      INSERT INTO ${NAMES.tablePrefix}things (label) VALUES ('before the move');
      CREATE TABLE ${NAMES.tablePrefix}x_other (id int);
    `);
    root = await mkdtemp(join(tmpdir(), 'k3-arch-'));
    await mkdir(join(root, 'migrations'));
    await writeFile(
      join(root, 'migrations', '0001_things.sql'),
      `CREATE TABLE IF NOT EXISTS ${NAMES.tablePrefix}things (id serial PRIMARY KEY, label text NOT NULL);
       CREATE TABLE ${NAMES.tablePrefix}votes (id bigserial PRIMARY KEY, thing_id int NOT NULL REFERENCES ${NAMES.tablePrefix}things (id), choice text NOT NULL);`,
    );
    db = createArchetypeDatabase({
      adminPool: () => admin,
      connectionString: adminUrl,
      secret: SECRET,
      log: (m) => void logs.push(m),
    });
  });

  after(async () => {
    await db?.closeAll();
    await admin?.end();
    await rm(root, { recursive: true, force: true });
    await superuser.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [NAMES.runtimeRole, NAMES.migrationRole, plainRole, adminRole]) {
      await superuser.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await superuser.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    await superuser.end();
  });

  /** `requiresPool`: the manifest of a version that still runs on the shared
   *  pool. Without it the plugin owns its database. */
  function catalog(opts: { requiresPool?: boolean } = {}): PluginCatalog {
    const manifest = {
      schema_version: '1',
      identity: { id: PLUGIN, kind: 'archetype', domain: 'test.k3', name: 'K3', version: '1.0.0' },
      ...(opts.requiresPool ? { requires: ['graphPool@^1'] } : {}),
      archetype: FACILITATOR_BLOCK,
      permissions: { sql: { ledger: LEDGER, migrations: 'migrations' } },
    };
    const plugin = adaptManifestV1(manifest);
    assert.ok(plugin, 'fixture manifest must adapt');
    const entries = new Map([[plugin.id, { plugin, manifest, source_path: 'test', source_kind: 'manifest-v1' }]]);
    return { get: (id: string) => entries.get(id), list: () => [...entries.values()] } as unknown as PluginCatalog;
  }

  async function context(
    withDatabase: boolean,
    opts: { requiresPool?: boolean } = {},
  ): Promise<ReturnType<typeof createPluginContext>> {
    const stub = (): (() => void) => (): void => {};
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.provide('graphPool', admin);
    return createPluginContext({
      agentId: PLUGIN,
      vault: { get: async (): Promise<undefined> => undefined, listKeys: async (): Promise<string[]> => [] },
      registry: { has: () => true, list: () => [], get: () => undefined },
      catalog: catalog(opts),
      serviceRegistry,
      sqlGranted: true,
      packageRoot: root,
      ...(withDatabase ? { archetypeDatabase: await db.ensure(PLUGIN) } : {}),
      nativeToolRegistry: { register: stub, registerHandler: stub },
      routeRegistry: { register: stub, disposeBySource: () => 0 },
      jobScheduler: { register: stub, stopForPlugin: (): void => {} },
      notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
      uiRouteCatalog: { register: stub, registerNav: stub },
      logger: (): void => {},
    } as unknown as CreatePluginContextOptions);
  }

  it('moves the plugin\'s tables out of public once, with their rows, and leaves a sibling plugin\'s alone', async () => {
    const first = await db.ensure(PLUGIN);
    assert.deepEqual([...first.moved].sort(), [LEDGER, `${NAMES.tablePrefix}things`].sort());
    assert.equal(first.schema, NAMES.schema);

    const where = await admin.query<{ nspname: string; relname: string; owner: string }>(
      `SELECT n.nspname, c.relname, r.rolname AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.relkind = 'r' AND c.relname LIKE $1 ORDER BY c.relname`,
      [`${NAMES.tablePrefix}%`],
    );
    assert.deepEqual(where.rows, [
      { nspname: NAMES.schema, relname: LEDGER, owner: NAMES.migrationRole },
      { nspname: NAMES.schema, relname: `${NAMES.tablePrefix}things`, owner: NAMES.migrationRole },
      // `@…/arch-x` holds a grant: a table under ITS prefix is not this plugin's.
      { nspname: 'public', relname: `${NAMES.tablePrefix}x_other`, owner: adminRole },
    ]);

    const rows = await first.sql.query<{ label: string }>(`SELECT label FROM ${NAMES.tablePrefix}things`);
    assert.deepEqual(rows.rows, [{ label: 'before the move' }]);

    const second = await db.ensure(PLUGIN);
    assert.deepEqual(second.moved, []);
  });

  it('logs the plugin in as its own role, with its schema as search_path, and that role reaches nothing of the kernel', async () => {
    const { sql } = await db.ensure(PLUGIN);
    const who = await sql.query<{ cu: string; su: string; sp: string }>(
      "SELECT current_user AS cu, session_user AS su, current_setting('search_path') AS sp",
    );
    assert.deepEqual(who.rows[0], { cu: NAMES.runtimeRole, su: NAMES.runtimeRole, sp: NAMES.schema });

    const DENIED = '42501';
    assert.equal(await codeOf(() => sql.query('SELECT * FROM public.agents')), DENIED);
    assert.equal(await codeOf(() => sql.query("INSERT INTO public.agents (slug) VALUES ('x')")), DENIED);
    assert.equal(await codeOf(() => sql.query('SELECT * FROM public.plugin_sql_grants')), DENIED);
    assert.equal(await codeOf(() => sql.query(`SELECT * FROM public.${NAMES.tablePrefix}x_other`)), DENIED);
    assert.equal(await codeOf(() => sql.query('CREATE TABLE public.k3_escape (id int)')), DENIED);
    // No DDL in its own schema either: structure belongs to the migrations.
    assert.equal(await codeOf(() => sql.query('CREATE TABLE k3_escape (id int)')), DENIED);
    assert.equal(await codeOf(() => sql.query(`DROP TABLE ${NAMES.tablePrefix}things`)), DENIED);
    // It cannot become anyone else.
    assert.equal(await codeOf(() => sql.query(`SET ROLE ${adminRole}`)), DENIED);
    assert.equal(await codeOf(() => sql.query(`SET ROLE ${NAMES.migrationRole}`)), DENIED);
    // The same from inside a transaction, where the kernel sets the path.
    assert.equal(
      await codeOf(() => sql.transaction((tx) => tx.query('SELECT * FROM public.agents'))),
      DENIED,
    );
  });

  it('runs migrations as the migration role in the schema; the runtime role writes the tables but not the ledger', async () => {
    const ctx = await context(true);
    assert.ok(ctx.sql?.query && ctx.sql.transaction, 'an archetype plugin gets query and transaction');
    assert.equal(ctx.sql.schema, NAMES.schema);
    assert.equal(ctx.sql.seedLedger, undefined, 'no access to the core ledger');

    const report = await ctx.sql.runMigrations();
    assert.deepEqual(report.applied, ['0001_things.sql']);
    assert.deepEqual((await ctx.sql.runMigrations()).applied, []);

    const votes = await admin.query<{ nspname: string; owner: string }>(
      `SELECT n.nspname, r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner WHERE c.relname = $1`,
      [`${NAMES.tablePrefix}votes`],
    );
    assert.deepEqual(votes.rows, [{ nspname: NAMES.schema, owner: NAMES.migrationRole }]);

    // Moved table (serial sequence included) and new table, as the runtime role.
    const thing = await ctx.sql.query<{ id: number }>(
      `INSERT INTO ${NAMES.tablePrefix}things (label) VALUES ('after the move') RETURNING id`,
    );
    const inserted = await ctx.sql.query(
      `INSERT INTO ${NAMES.tablePrefix}votes (thing_id, choice) VALUES ($1, 'yes')`,
      [thing.rows[0]?.id],
    );
    assert.equal(inserted.rowCount, 1);

    assert.equal((await ctx.sql.query(`SELECT filename FROM ${LEDGER}`)).rowCount, 1);
    assert.equal(await codeOf(() => ctx.sql!.query!(`DELETE FROM ${LEDGER}`)), '42501');
    assert.equal(
      await codeOf(() => ctx.sql!.query!(`INSERT INTO ${LEDGER} (filename, checksum) VALUES ('9999_fake.sql', 'x')`)),
      '42501',
    );
  });

  it('a migration cannot reach kernel tables, and its failure leaves nothing behind', async () => {
    const dir = join(root, 'hostile');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '0001_reach.sql'),
      `CREATE TABLE ${NAMES.tablePrefix}loot AS SELECT * FROM public.agents;`,
    );
    const ctx = await context(true);
    assert.equal(await codeOf(() => ctx.sql!.runMigrations({ dir: 'hostile' })), '42501');
    await writeFile(join(dir, '0001_reach.sql'), `RESET ROLE; RESET search_path; DELETE FROM public.agents;`);
    assert.equal(await codeOf(() => ctx.sql!.runMigrations({ dir: 'hostile' })), '42501');
    assert.equal((await admin.query('SELECT 1 FROM agents')).rowCount, 1);
    assert.equal((await admin.query(`SELECT to_regclass('${NAMES.schema}.${NAMES.tablePrefix}loot') AS t`)).rows[0].t, null);
  });

  it('a plugin that owns its database has no way to the shared pool; without its database it has no ctx.sql', async () => {
    for (const withDatabase of [true, false]) {
      const ctx = await context(withDatabase);
      // It does not declare the pool, so asking for it is a manifest error.
      assert.throws(() => ctx.services.get('graphPool'), ServiceNotDeclaredError);
      if (!withDatabase) assert.equal(ctx.sql, undefined, 'no database of its own means no ctx.sql, not the pool');
    }
  });

  it('a version that still requires graphPool keeps the shared pool and gets no query or transaction', async () => {
    const ctx = await context(false, { requiresPool: true });
    const pool = ctx.services.get<{ query: (text: string) => Promise<{ rows: { cu: string }[] }> }>('graphPool');
    assert.ok(pool, 'the shared pool, as before');
    assert.equal((await pool.query('SELECT current_user AS cu')).rows[0]?.cu, adminRole);
    assert.ok(ctx.sql, 'ctx.sql for its migrations, as before');
    assert.equal(ctx.sql.schema, undefined);
    assert.equal(ctx.sql.query, undefined);
    assert.equal(ctx.sql.transaction, undefined);
  });

  it('commits a transaction, rolls one back on a throw, and refuses a statement after it ended', async () => {
    const { sql } = await db.ensure(PLUGIN);
    const table = `${NAMES.tablePrefix}things`;
    const count = async (label: string): Promise<number> =>
      (await sql.query(`SELECT 1 FROM ${table} WHERE label = $1`, [label])).rowCount;

    let leaked: { query: (text: string) => Promise<unknown> } | undefined;
    const value = await sql.transaction(async (tx) => {
      leaked = tx;
      await tx.query(`INSERT INTO ${table} (label) VALUES ('committed')`);
      const path = await tx.query<{ sp: string }>("SELECT current_setting('search_path') AS sp");
      return path.rows[0]?.sp;
    });
    assert.equal(value, NAMES.schema);
    assert.equal(await count('committed'), 1);
    await assert.rejects(() => leaked!.query('SELECT 1'), /transaction has ended/);

    await assert.rejects(
      () =>
        sql.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${table} (label) VALUES ('rolled back')`);
          throw new Error('stop');
        }),
      /stop/,
    );
    assert.equal(await count('rolled back'), 0);
  });

  it('is idempotent, also when two replicas set the database up at the same moment', async () => {
    const other = createArchetypeDatabase({ adminPool: () => admin, connectionString: adminUrl, secret: SECRET });
    try {
      const [a, b] = await Promise.all([db.ensure(PLUGIN), other.ensure(PLUGIN)]);
      assert.equal(a.runtimeRole, b.runtimeRole);
      assert.equal((await b.sql.query('SELECT 1 AS one')).rowCount, 1);
    } finally {
      await other.closeAll();
    }
  });

  it('sets the derived password again when the role\'s password no longer matches (kernel secret changed)', async () => {
    await admin.query(`ALTER ROLE ${NAMES.runtimeRole} PASSWORD '${randomBytes(18).toString('base64url')}'`);
    logs.length = 0;
    const { sql } = await db.ensure(PLUGIN);
    assert.equal((await sql.query('SELECT 1')).rowCount, 1);
    assert.ok(logs.some((l) => l.includes(`password of ${NAMES.runtimeRole} refused`)));
    assert.ok(!logs.join('\n').includes('A1-'), 'no password in a log line');
  });

  it('fails closed when a plugin role holds a right outside its schema', async () => {
    await admin.query(`GRANT SELECT ON agents TO ${NAMES.runtimeRole}`);
    try {
      await assert.rejects(
        () => db.ensure(PLUGIN),
        (err: unknown) =>
          err instanceof ArchetypeDatabaseError &&
          err.code === 'not_isolated' &&
          err.message.includes('public.agents'),
      );
    } finally {
      await admin.query(`REVOKE SELECT ON agents FROM ${NAMES.runtimeRole}`);
    }
    await db.ensure(PLUGIN);
  });

  it('says what the administrator has to run when the kernel\'s user may not create roles', async () => {
    const plain = new Pool({ connectionString: withUser(PG_URL as string, plainRole, adminPassword, database), max: 1 });
    const limited = createArchetypeDatabase({
      adminPool: () => plain,
      connectionString: adminUrl,
      secret: SECRET,
    });
    try {
      await assert.rejects(
        () => limited.ensure(`@k3t${RUN}/other`),
        (err: unknown) =>
          err instanceof ArchetypeDatabaseError &&
          err.code === 'cannot_create_roles' &&
          /CREATEROLE/.test(err.message),
      );
      const roles = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
        archetypeDatabaseNames(`@k3t${RUN}/other`).runtimeRole,
      ]);
      assert.equal(roles.rowCount, 0, 'nothing half-created');
    } finally {
      await limited.closeAll();
      await plain.end();
    }
  });

  it('the runtime sets the database up before activate(), migrates as the migration role, and closes the pool on deactivate', async () => {
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(
      join(root, 'dist', 'plugin.js'),
      `export async function activate(ctx) {
         const out = (globalThis.__k3 = { query: ctx.sql?.query });
         out.schema = ctx.sql?.schema;
         out.who = (await ctx.sql.query('SELECT current_user AS cu')).rows[0].cu;
         out.votes = (await ctx.sql.query('SELECT count(*)::int AS n FROM ${NAMES.tablePrefix}votes')).rows[0].n;
         try { ctx.services.get('graphPool'); out.pool = 'given'; } catch (err) { out.pool = err.name; }
         return { close: async () => {} };
       }\n`,
    );
    const stub = (): (() => void) => (): void => {};
    const serviceRegistry = new ServiceRegistry();
    serviceRegistry.provide('graphPool', admin);
    const runtimeLogs: string[] = [];
    const base = catalog();
    const entry = base.get(PLUGIN) as unknown as { manifest: Record<string, unknown> };
    const manifest = { ...entry.manifest, lifecycle: { entry: 'dist/plugin.js' } };
    const plugin = adaptManifestV1(manifest);
    assert.ok(plugin);
    const runtime = new ToolPluginRuntime({
      catalog: {
        get: (id: string) => (id === PLUGIN ? { plugin, manifest, source_path: 'test', source_kind: 'manifest-v1' } : undefined),
        list: () => [],
      },
      registry: { get: () => ({ status: 'active' }) },
      vault: { get: async (): Promise<undefined> => undefined, listKeys: async (): Promise<string[]> => [] },
      uploadedStore: {
        get: (id: string) => (id === PLUGIN ? { id, path: root } : undefined),
        list: () => [{ id: PLUGIN, path: root }],
      },
      serviceRegistry,
      nativeToolRegistry: { register: stub, registerHandler: stub, unregisterBySource: (): string[] => [] },
      pluginRouteRegistry: { register: stub, disposeBySource: () => 0 },
      notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
      uiRouteCatalog: { register: stub, registerNav: stub, disposeBySource: () => 0 },
      jobScheduler: { register: stub, stopForPlugin: (): void => {} },
      sqlGrantStore: { get: async (): Promise<{ ledger: string }> => ({ ledger: LEDGER }) },
      archetypeDatabase: db,
      log: (msg: string): void => void runtimeLogs.push(msg),
    } as unknown as ToolPluginRuntimeDeps);

    await runtime.activate(PLUGIN);
    const seen = (globalThis as unknown as { __k3: Record<string, unknown> }).__k3;
    assert.equal(seen['schema'], NAMES.schema);
    assert.equal(seen['who'], NAMES.runtimeRole);
    assert.equal(typeof seen['votes'], 'number', 'the migrated table exists before activate() runs');
    assert.equal(seen['pool'], 'ServiceNotDeclaredError');
    assert.ok(runtimeLogs.some((l) => l.includes(`database is schema '${NAMES.schema}' as role '${NAMES.runtimeRole}'`)));

    await runtime.deactivate(PLUGIN);
    await assert.rejects(
      () => (seen['query'] as (text: string) => Promise<unknown>)('SELECT 1'),
      /after calling end on the pool/,
    );
    const kept = await admin.query<{ t: string | null }>(
      `SELECT to_regclass('${NAMES.schema}.${NAMES.tablePrefix}things')::text AS t`,
    );
    assert.notEqual(kept.rows[0]?.t, null, 'deactivation keeps the schema and its tables');
    const again = await db.ensure(PLUGIN);
    assert.ok((await again.sql.query(`SELECT 1 FROM ${NAMES.tablePrefix}things`)).rowCount > 0, 'and their rows');
  });

  it('answers no_database without a pool', async () => {
    const none = createArchetypeDatabase({ adminPool: () => undefined, connectionString: undefined, secret: SECRET });
    await assert.rejects(
      () => none.ensure(PLUGIN),
      (err: unknown) => err instanceof ArchetypeDatabaseError && err.code === 'no_database',
    );
  });
});

describe('#2088 which plugin owns its database', () => {
  it('an archetype plugin that asks for no pool; every other plugin keeps what it has', () => {
    assert.equal(ownsItsDatabase({ kind: 'archetype' }), true);
    assert.equal(ownsItsDatabase({ kind: 'archetype', requires: ['facilitation.followup@^1'] }), true);
    assert.equal(ownsItsDatabase({ kind: 'archetype', requires: ['graphPool@^1'] }), false);
    assert.equal(ownsItsDatabase({ kind: 'archetype', requires: ['graphPool'] }), false);
    assert.equal(ownsItsDatabase({ kind: 'archetype', optional_requires: ['graphPool@^1'] }), false);
    for (const kind of ['extension', 'tool', 'integration', 'agent', 'channel']) {
      assert.equal(ownsItsDatabase({ kind }), false, kind);
    }
  });
});

describe('#2088 boot order of a plugin that owns its database', () => {
  const plugins: Record<string, Parameters<typeof ownsItsDatabase>[0] & { provides?: string[]; permissions_summary?: { sql?: unknown } }> = {
    kg: { kind: 'extension', provides: ['graphPool@1', 'knowledgeGraph@1'] },
    own: { kind: 'archetype', permissions_summary: { sql: { ledger: 'x' } } },
    ownNoSql: { kind: 'archetype', permissions_summary: {} },
    shared: { kind: 'archetype', requires: ['graphPool@^1'], permissions_summary: { sql: { ledger: 'y' } } },
    tool: { kind: 'tool', permissions_summary: { sql: { ledger: 'z' } } },
  };

  it('puts it after the plugin that publishes the pool; nobody else gets an edge', () => {
    assert.deepEqual(ownDatabaseEdges(Object.keys(plugins), (id) => plugins[id]), [{ from: 'kg', to: 'own' }]);
  });

  it('adds nothing when no installed plugin publishes the pool', () => {
    assert.deepEqual(ownDatabaseEdges(['own', 'tool'], (id) => plugins[id]), []);
  });
});

describe('#2088 archetype database names', () => {
  it('derives schema and roles from the plugin id and stays inside the identifier limit', () => {
    assert.deepEqual(archetypeDatabaseNames('@omadia/agent-facilitator'), {
      schema: 'plg_omadia_agent_facilitator',
      runtimeRole: 'omadia_plg_omadia_agent_facilitator_rt',
      migrationRole: 'omadia_plg_omadia_agent_facilitator_mig',
      tablePrefix: 'plg_omadia_agent_facilitator_',
    });
    const long = (tail: string): string => `@acme/${'a-very-long-plugin-name-'.repeat(3)}${tail}`;
    const a = archetypeDatabaseNames(long('one'));
    const b = archetypeDatabaseNames(long('two'));
    for (const name of [a.schema, a.runtimeRole, a.migrationRole]) {
      assert.ok(name.length <= 63 && /^[a-z][a-z0-9_]*$/.test(name), name);
    }
    assert.notEqual(a.runtimeRole, b.runtimeRole);
    assert.notEqual(a.schema, b.schema);
    assert.ok(a.runtimeRole.endsWith('_rt') && a.migrationRole.endsWith('_mig'));
  });
});
