/**
 * The embedded Postgres, for real: initdb and postgres from the engine in
 * node_modules (`@embedded-postgres/<platform>`), started through
 * `startEmbeddedDb()` in the Electron fake's throwaway data dir.
 *
 * The regression this pins: the cluster was initialised with `-A trust`, so
 * any local process, of any OS user, could open a loopback connection as the
 * bootstrap superuser without a password, and the kernel's own DSN was that
 * superuser. With SCRAM rules in pg_hba.conf the server's verdict no longer
 * depends on who the client is: a client without the password is refused,
 * whichever OS account it runs under, and the DSN the kernel gets names a
 * role that cannot run `COPY ... TO PROGRAM`.
 *
 * Skipped when the engine is not installed or when running as root (initdb
 * refuses root). The dev engine ships no pgvector, so the assertions about it
 * run only where `vector.control` was staged in. The desktop-apps workflow
 * runs this file with OMADIA_EMBEDDED_PG_IT=require after staging pgvector:
 * there a missing engine or a missing pgvector fails instead of skipping.
 */
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

import { startEmbeddedDb, stopEmbeddedDb, type EmbeddedDb } from '../src/embeddedDb.ts';
import { secretsFile, setDataDirOverride } from '../src/paths.ts';
import { __resetSecretsCacheForTests } from '../src/secrets.ts';
import { findFreePort } from '../src/ports.ts';
import { onLog } from '../src/log.ts';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const nativeDir = path.join(desktopDir, 'node_modules', '@embedded-postgres', engine, 'native');
const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);
const initdb = path.join(nativeDir, 'bin', exe('initdb'));
const postgresBin = path.join(nativeDir, 'bin', exe('postgres'));
const vectorShipped = [
  path.join(nativeDir, 'share', 'postgresql', 'extension', 'vector.control'),
  path.join(nativeDir, 'share', 'extension', 'vector.control'),
].some((file) => fs.existsSync(file));
const graphInitSql = path.resolve(
  desktopDir,
  '..',
  'middleware/packages/harness-knowledge-graph-neon/src/migrations/0001_graph_init.sql',
);

const required = process.env['OMADIA_EMBEDDED_PG_IT'] === 'require';

function unavailable(): string | null {
  if (!fs.existsSync(initdb) || !fs.existsSync(postgresBin)) return `no embedded Postgres engine at ${nativeDir}`;
  if (process.getuid?.() === 0) return 'initdb refuses to run as root';
  return null;
}

interface StoredCredentials {
  superuserPassword: string;
  kernelPassword: string;
}

/** The fake has no OS encryption and is unpackaged, so the blob is plaintext JSON. */
function storedCredentials(): StoredCredentials {
  const blob = JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) as { embeddedDb?: StoredCredentials };
  assert.ok(blob.embeddedDb, 'secrets.enc holds the database credentials');
  return blob.embeddedDb;
}

function hbaRules(dataDir: string): string[] {
  return fs
    .readFileSync(path.join(dataDir, 'pg_hba.conf'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

type Attempt = { ok: true } | { ok: false; code: string | undefined; message: string };

/** One connection attempt; `password` undefined means the client has none. */
async function attempt(port: number, user: string, password: string | undefined, database: string): Promise<Attempt> {
  const client = new pg.Client({ host: '127.0.0.1', port, user, password, database, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    return { ok: true };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code, message: (err as Error).message };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Nobody gets in without the password: not the superuser, not the kernel role.
 * pg refuses SCRAM without a password on the client side, so the passwordless
 * cases accept either refusal; a wrong password must be the server's 28P01.
 */
async function assertPasswordsRequired(port: number, dataDir: string): Promise<void> {
  for (const [user, database] of [
    ['omadia', 'postgres'],
    ['omadia_kernel', 'omadia'],
  ] as const) {
    const passwordless = await attempt(port, user, undefined, database);
    assert.equal(passwordless.ok, false, `${user} must not connect without a password`);
    const wrong = await attempt(port, user, 'synthetic-wrong-password', database);
    assert.equal(wrong.ok, false, `${user} must not connect with a wrong password`);
    assert.equal(wrong.ok ? undefined : wrong.code, '28P01', `${user}: wrong password → 28P01`);
  }
  const rules = hbaRules(dataDir);
  assert.ok(rules.length > 0);
  assert.deepEqual(
    rules.filter((line) => line.split(/\s+/).includes('trust')),
    [],
    'pg_hba.conf has no trust rule',
  );
}

/** What the kernel can and cannot do with the DSN it is handed. */
async function assertKernelRole(db: EmbeddedDb): Promise<void> {
  const creds = storedCredentials();
  const url = new URL(db.databaseUrl);
  assert.equal(url.username, 'omadia_kernel');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(decodeURIComponent(url.password), creds.kernelPassword);
  assert.ok(!db.databaseUrl.includes(creds.superuserPassword), 'the bootstrap password never leaves the shell');

  const kernel = new pg.Client({ connectionString: db.databaseUrl });
  await kernel.connect();
  try {
    const role = await kernel.query('SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user');
    assert.deepEqual(role.rows, [{ rolsuper: false, rolcreaterole: false, rolcreatedb: false }]);
    await assert.rejects(kernel.query("COPY (SELECT 1) TO PROGRAM 'true'"), (err: { code?: string }) => err.code === '42501');
    // PG15+: CREATE on `public` comes from the implicit pg_database_owner membership.
    await kernel.query('CREATE TABLE IF NOT EXISTS public.kernel_probe (id int)');
    // Pre-created by the shell, so the kernel's IF NOT EXISTS short-circuits.
    await kernel.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    if (vectorShipped) {
      // The kernel's first graph migration, as the kernel: pgvector is not a
      // trusted extension, so this works only because the shell created it.
      await kernel.query(fs.readFileSync(graphInitSql, 'utf8'));
    }
    const extensions = await kernel.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'vector') ORDER BY extname",
    );
    assert.deepEqual(
      extensions.rows.map((row: { extname: string }) => row.extname),
      vectorShipped ? ['pg_trgm', 'vector'] : ['pg_trgm'],
    );
  } finally {
    await kernel.end();
  }
}

/** A Postgres started by hand, the way the trust-era build ran it. */
async function startByHand(dataDir: string): Promise<{ proc: ChildProcess; port: number }> {
  const port = await findFreePort('127.0.0.1');
  const proc = spawn(
    postgresBin,
    ['-D', dataDir, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories='],
    { cwd: nativeDir, stdio: 'ignore' },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await attempt(port, 'omadia', undefined, 'postgres')).ok) return { proc, port };
    await delay(200);
  }
  proc.kill('SIGKILL');
  throw new Error('the hand-started Postgres did not come up');
}

async function stopByHand(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, 'exit');
  proc.kill('SIGINT');
  await exited;
}

async function runAs(port: number, database: string, sql: string, password?: string): Promise<pg.QueryResult> {
  const client = new pg.Client({ host: '127.0.0.1', port, user: 'omadia', password, database });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

/** What a trust-era kernel, running as the bootstrap superuser, left behind. */
const TRUST_ERA_OBJECTS = `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE TABLE legacy_items (id BIGSERIAL PRIMARY KEY, label TEXT NOT NULL);
  CREATE INDEX legacy_items_label_trgm ON legacy_items USING GIN (label gin_trgm_ops);
  CREATE TABLE legacy_events (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, item BIGINT REFERENCES legacy_items (id));
  CREATE SEQUENCE legacy_counter;
  CREATE VIEW legacy_labels AS SELECT label FROM legacy_items;
  CREATE MATERIALIZED VIEW legacy_counts AS SELECT count(*) AS n FROM legacy_items;
  CREATE TYPE legacy_state AS ENUM ('a', 'b');
  CREATE TYPE legacy_pair AS (x INT, y INT);
  CREATE TYPE legacy_span AS RANGE (subtype = int4);
  CREATE DOMAIN legacy_label AS TEXT CHECK (VALUE <> '');
  CREATE FUNCTION legacy_touch() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  CREATE TRIGGER legacy_items_touch BEFORE UPDATE ON legacy_items FOR EACH ROW EXECUTE FUNCTION legacy_touch();
  CREATE AGGREGATE legacy_sum (int4) (SFUNC = int4pl, STYPE = int4);
  CREATE SCHEMA legacy_schema;
  CREATE TABLE legacy_schema.nested (id INT);
  CREATE TABLE legacy_parts (id INT, part INT) PARTITION BY RANGE (part);
  CREATE TABLE legacy_parts_low PARTITION OF legacy_parts FOR VALUES FROM (0) TO (10);
`;

/** Objects in the kernel database still owned by the bootstrap superuser (extension members aside). */
const OWNED_BY_BOOTSTRAP = `
  WITH boot AS (SELECT 'omadia'::regrole::oid AS oid),
  sys AS (
    SELECT oid FROM pg_namespace
    WHERE nspname IN ('pg_catalog', 'information_schema') OR nspname LIKE 'pg\\_toast%' OR nspname LIKE 'pg\\_temp%'
  ),
  ext AS (SELECT classid, objid FROM pg_depend WHERE deptype = 'e')
  SELECT 'relation' AS kind, c.oid::regclass::text AS name FROM pg_class c
   WHERE c.relowner = (SELECT oid FROM boot) AND c.relnamespace NOT IN (SELECT oid FROM sys)
     AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_class'::regclass AND ext.objid = c.oid)
  UNION ALL
  SELECT 'routine', p.oid::regprocedure::text FROM pg_proc p
   WHERE p.proowner = (SELECT oid FROM boot) AND p.pronamespace NOT IN (SELECT oid FROM sys)
     AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_proc'::regclass AND ext.objid = p.oid)
  UNION ALL
  SELECT 'type', t.oid::regtype::text FROM pg_type t
   WHERE t.typowner = (SELECT oid FROM boot) AND t.typnamespace NOT IN (SELECT oid FROM sys)
     AND t.typtype IN ('b', 'c', 'd', 'e', 'r')
     AND (t.typrelid = 0 OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
     AND NOT EXISTS (SELECT 1 FROM pg_type a WHERE a.typarray = t.oid)
     AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_type'::regclass AND ext.objid = t.oid)
  UNION ALL
  SELECT 'schema', n.nspname::text FROM pg_namespace n
   WHERE n.nspowner = (SELECT oid FROM boot) AND n.oid NOT IN (SELECT oid FROM sys)
     AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_namespace'::regclass AND ext.objid = n.oid)
`;

const skip = required ? false : (unavailable() ?? false);

describe('embedded Postgres authentication (real engine)', { skip, timeout: 240_000 }, () => {
  const logLines: string[] = [];
  const scratch: string[] = [];
  let firstDsn = '';
  let handStarted: ChildProcess | null = null;

  before(() => {
    if (required) {
      assert.equal(unavailable(), null, 'OMADIA_EMBEDDED_PG_IT=require');
      assert.ok(vectorShipped, `OMADIA_EMBEDDED_PG_IT=require, but ${nativeDir} has no pgvector staged`);
    }
    // `embeddedDb.ts` is compiled to CommonJS and finds the dev engine via
    // `__dirname`, which the ESM test loader does not define (see
    // supervisorKernelEnv.test.mts); give it the answer dist/ would have.
    (globalThis as { __dirname?: string }).__dirname = path.join(desktopDir, 'dist');
    // A password from the environment or a ~/.pgpass must not stand in for
    // "no password" in the passwordless attempts below.
    delete process.env['PGPASSWORD'];
    process.env['PGPASSFILE'] = path.join(os.tmpdir(), 'omadia-no-such-pgpass');
    onLog((level, message) => logLines.push(`${level} ${message}`));
  });

  after(async () => {
    await stopEmbeddedDb();
    if (handStarted !== null) await stopByHand(handStarted);
    for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh install requires passwords and hands the kernel a restricted role', async () => {
    const db = await startEmbeddedDb();
    const dataDir = path.join(path.dirname(secretsFile()), 'pgdata');
    await assertPasswordsRequired(db.port, dataDir);
    await assertKernelRole(db);
    firstDsn = db.databaseUrl;
  });

  it('a restart keeps the credentials and needs no migration', async () => {
    assert.ok(await stopEmbeddedDb());
    logLines.length = 0;
    const db = await startEmbeddedDb();
    assert.equal(db.databaseUrl, firstDsn);
    assert.deepEqual(
      logLines.filter((line) => line.startsWith('WARN') && line.includes('[db]')),
      [],
      'a normal start neither migrates nor re-provisions',
    );
  });

  it('lost credentials are re-provisioned through a logged loopback trust window', async () => {
    const previous = storedCredentials();
    assert.ok(await stopEmbeddedDb());
    for (const file of [secretsFile(), `${secretsFile()}.bak`]) fs.rmSync(file, { force: true });
    __resetSecretsCacheForTests();
    logLines.length = 0;

    const db = await startEmbeddedDb();
    const current = storedCredentials();
    assert.notEqual(current.kernelPassword, previous.kernelPassword);
    assert.ok(
      logLines.some((line) => line.startsWith('WARN') && line.includes('trust window')),
      `the window is logged at warn:\n${logLines.join('\n')}`,
    );
    const dataDir = path.join(path.dirname(secretsFile()), 'pgdata');
    await assertPasswordsRequired(db.port, dataDir);
    assert.equal((await attempt(db.port, 'omadia_kernel', previous.kernelPassword, 'omadia')).ok, false);
    assert.equal((await attempt(db.port, 'omadia', previous.superuserPassword, 'postgres')).ok, false);
    await assertKernelRole(db);
  });

  it('a trust-era cluster is migrated on its first start', async () => {
    assert.ok(await stopEmbeddedDb());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-trust-era-'));
    scratch.push(root);
    setDataDirOverride(root);
    __resetSecretsCacheForTests();
    // The blob as a trust-era install left it: kernel keys, no database credentials.
    const syntheticKey = (fill: number): string => Buffer.alloc(32, fill).toString('base64');
    fs.writeFileSync(
      path.join(root, 'secrets.enc'),
      JSON.stringify({ vaultKey: syntheticKey(1), credentialKeychainKey: syntheticKey(2), providerKeys: {} }),
      { mode: 0o600 },
    );
    const dataDir = path.join(root, 'pgdata');
    execFileSync(initdb, ['-D', dataDir, '-U', 'omadia', '-A', 'trust', '-E', 'UTF8', '--locale=C'], { stdio: 'pipe' });
    const legacy = await startByHand(dataDir);
    handStarted = legacy.proc;
    await runAs(legacy.port, 'postgres', 'CREATE DATABASE omadia OWNER omadia');
    await runAs(legacy.port, 'omadia', TRUST_ERA_OBJECTS);
    if (vectorShipped) {
      await runAs(legacy.port, 'omadia', 'CREATE EXTENSION vector; CREATE TABLE legacy_vectors (v vector(3))');
    }
    await stopByHand(legacy.proc);
    handStarted = null;

    const db = await startEmbeddedDb();
    await assertPasswordsRequired(db.port, dataDir);
    await assertKernelRole(db);
    // A rollback to a build from before this change connects with exactly this
    // passwordless DSN. It is refused; the pre-update snapshot is the way back.
    const rollback = await attempt(db.port, 'omadia', undefined, 'omadia');
    assert.equal(rollback.ok, false, 'a pre-change build cannot connect to a migrated cluster');

    const creds = storedCredentials();
    const leftovers = await runAs(db.port, 'omadia', OWNED_BY_BOOTSTRAP, creds.superuserPassword);
    assert.deepEqual(leftovers.rows, [], 'nothing the kernel uses is still owned by the superuser');

    // Owning is what the kernel's later migrations need: alter, not just read.
    const kernel = new pg.Client({ connectionString: db.databaseUrl });
    await kernel.connect();
    try {
      await kernel.query('ALTER TABLE legacy_items ADD COLUMN note TEXT');
      await kernel.query("INSERT INTO legacy_items (label) VALUES ('synthetic')");
      await kernel.query('INSERT INTO legacy_events (item) SELECT id FROM legacy_items');
      await kernel.query("SELECT nextval('legacy_counter')");
      await kernel.query('REFRESH MATERIALIZED VIEW legacy_counts');
      await kernel.query("ALTER TYPE legacy_state ADD VALUE 'c'");
      await kernel.query('ALTER DOMAIN legacy_label SET NOT NULL');
      await kernel.query('CREATE OR REPLACE FUNCTION legacy_touch() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
      await kernel.query('CREATE TABLE legacy_schema.more (id INT)');
      // Recurses into every partition, so it needs to own each of them.
      await kernel.query('ALTER TABLE legacy_parts ADD COLUMN extra INT');
      await kernel.query('SELECT legacy_sum(id) FROM legacy_events');
    } finally {
      await kernel.end();
    }
  });

  it('an unreadable secrets file stops the start before a cluster exists', async () => {
    assert.ok(await stopEmbeddedDb());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-unreadable-'));
    scratch.push(root);
    setDataDirOverride(root);
    __resetSecretsCacheForTests();
    fs.writeFileSync(path.join(root, 'secrets.enc'), '{"vaultKey": "trunc', { mode: 0o600 });

    await assert.rejects(startEmbeddedDb(), (err: { code?: string }) => err.code === 'secrets_unreadable');
    assert.equal(
      fs.existsSync(path.join(root, 'pgdata', 'PG_VERSION')),
      false,
      'no cluster is created before its credentials are durable',
    );
  });
});
