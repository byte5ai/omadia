/**
 * Issue #581 — `PostgresPublishStore` against a real Postgres. Skips
 * cleanly (same convention as `postgresSandboxRegistry.pg.test.ts`) when no
 * test database is configured. Schema is created inline from migration
 * `0045_publish_versions.sql` so this suite does not depend on the
 * multi-orchestrator migrator having run against the test DB.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';

import { probePgTest } from '../_helpers/pgTestDb.js';

import { PostgresPublishStore } from '../../packages/harness-publish/src/postgresPublishStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'postgresPublishStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS publish_versions (
  app_id            TEXT NOT NULL,
  version           INTEGER NOT NULL,
  name              TEXT NOT NULL,
  entrypoint        TEXT NOT NULL,
  dir_hash          TEXT NOT NULL,
  source_scope_key  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, version)
);
CREATE TABLE IF NOT EXISTS publish_apps (
  app_id           TEXT PRIMARY KEY,
  next_version     INTEGER NOT NULL DEFAULT 1,
  current_version  INTEGER,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT publish_apps_current_version_fk
    FOREIGN KEY (app_id, current_version) REFERENCES publish_versions (app_id, version)
);
`;

const describeIf = pgAvailable ? describe : describe.skip;

describeIf('PostgresPublishStore (#581)', () => {
  let pool: Pool;
  let store: PostgresPublishStore;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await pool.query(SCHEMA);
    store = new PostgresPublishStore(pool);
  });

  after(async () => {
    await pool.query('DROP TABLE IF EXISTS publish_apps');
    await pool.query('DROP TABLE IF EXISTS publish_versions');
    await pool.end();
  });

  it('createVersion allocates 1, 2, 3 for repeated publishes to one app', async () => {
    const appId = `pg-alloc-${String(Date.now())}`;
    const v1 = await store.createVersion({ appId, name: 'A', entrypoint: 'x.js', dirHash: 'h1', sourceScopeKey: 's', now: new Date() });
    const v2 = await store.createVersion({ appId, name: 'A', entrypoint: 'x.js', dirHash: 'h2', sourceScopeKey: 's', now: new Date() });
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
  });

  it('concurrent createVersion calls for the same app never collide, and neither version is overwritten', async () => {
    const appId = `pg-race-${String(Date.now())}`;
    const [a, b] = await Promise.all([
      store.createVersion({ appId, name: 'A', entrypoint: 'a.js', dirHash: 'hash-a', sourceScopeKey: 's', now: new Date() }),
      store.createVersion({ appId, name: 'A', entrypoint: 'b.js', dirHash: 'hash-b', sourceScopeKey: 's', now: new Date() }),
    ]);
    assert.notEqual(a.version, b.version);
    const versions = await store.listVersions(appId);
    assert.equal(versions.length, 2);
    const byVersion = new Map(versions.map((v) => [v.version, v]));
    assert.equal(byVersion.get(a.version)!.dirHash, a.dirHash);
    assert.equal(byVersion.get(b.version)!.dirHash, b.dirHash);
  });

  it('the (app_id, version) primary key rejects a direct duplicate insert at the schema level', async () => {
    const appId = `pg-pk-${String(Date.now())}`;
    await store.createVersion({ appId, name: 'A', entrypoint: 'x.js', dirHash: 'h1', sourceScopeKey: 's', now: new Date() });
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO publish_versions (app_id, version, name, entrypoint, dir_hash, source_scope_key) VALUES ($1, 1, 'B', 'y.js', 'h2', 's')`,
        [appId],
      ),
    );
    const stillOriginal = await store.getVersion(appId, 1);
    assert.equal(stillOriginal!.dirHash, 'h1', 'the original version 1 row must be untouched');
  });

  it('setPointer requires the version to already exist (composite FK)', async () => {
    const appId = `pg-fk-${String(Date.now())}`;
    await assert.rejects(() => store.setPointer(appId, 1, new Date()));
  });

  it('rollback: setPointer to an earlier version updates getPointer without touching version rows', async () => {
    const appId = `pg-rollback-${String(Date.now())}`;
    await store.createVersion({ appId, name: 'A', entrypoint: 'x.js', dirHash: 'h1', sourceScopeKey: 's', now: new Date() });
    await store.createVersion({ appId, name: 'A', entrypoint: 'x.js', dirHash: 'h2', sourceScopeKey: 's', now: new Date() });
    await store.setPointer(appId, 2, new Date());
    assert.equal((await store.getPointer(appId))!.currentVersion, 2);

    await store.setPointer(appId, 1, new Date());
    assert.equal((await store.getPointer(appId))!.currentVersion, 1);
    const v1 = await store.getVersion(appId, 1);
    assert.equal(v1!.dirHash, 'h1');
  });
});
