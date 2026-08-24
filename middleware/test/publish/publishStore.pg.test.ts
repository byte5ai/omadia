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

/**
 * How many publishes race for the same app in the concurrency test (#834).
 *
 * The original suite raced two, which reproduced the allocator bug only
 * intermittently — that is precisely why #834 surfaced as a CI flake rather
 * than a red test. Eight makes the pre-fix failure deterministic: against the
 * broken `SELECT … FOR UPDATE`-on-a-missing-row allocator, seven of the eight
 * lose the bare-INSERT race and die on `publish_apps_pkey` (measured, 5/5
 * rounds), so a regression here fails loudly on the first run instead of once
 * every few CI builds.
 */
const CONCURRENT_PUBLISHERS = 8;

describeIf('PostgresPublishStore (#581)', () => {
  let pool: Pool;
  let store: PostgresPublishStore;

  before(async () => {
    // `max` is set explicitly rather than left to node-postgres' default of
    // 10: the concurrency test below needs CONCURRENT_PUBLISHERS real
    // connections in flight at once to exercise the allocator's race, and a
    // pool smaller than that would queue them into an accidental serial run
    // — a test that passes because it never actually raced.
    pool = new Pool({ connectionString: PG_URL, max: CONCURRENT_PUBLISHERS + 4 });
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

  it(`${String(CONCURRENT_PUBLISHERS)} concurrent createVersion calls for one app allocate unique, gapless versions with no unique-violation (#834)`, async () => {
    const appId = `pg-race8-${String(Date.now())}`;

    // Pre-warm the pool. Without this the first callers spend their turn in
    // the TCP/auth handshake and drift apart in time, so the allocations
    // stagger and the race window the test exists to hit is never opened.
    const warm = await Promise.all(Array.from({ length: CONCURRENT_PUBLISHERS }, () => pool.connect()));
    for (const client of warm) client.release();

    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENT_PUBLISHERS }, (_, i) =>
        store.createVersion({
          appId,
          name: 'A',
          entrypoint: `e${String(i)}.js`,
          dirHash: `hash-${String(i)}`,
          sourceScopeKey: 's',
          now: new Date(),
        }),
      ),
    );

    // Report the SQLSTATE rather than just a count: `23505` is the exact
    // signature of #834, and a different code would mean a different bug.
    const rejected = settled.filter((r) => r.status === 'rejected');
    assert.equal(
      rejected.length,
      0,
      `no publish may fail; got ${String(rejected.length)}: ${JSON.stringify(
        rejected.map((r) => {
          const err: unknown = r.reason;
          const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
          const constraint = err instanceof Error ? (err as Error & { constraint?: string }).constraint : undefined;
          return { code: code ?? String(err), constraint };
        }),
      )}`,
    );

    const allocated = settled
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof store.createVersion>>> => r.status === 'fulfilled')
      .map((r) => r.value.version)
      .sort((x, y) => x - y);
    assert.deepEqual(
      allocated,
      Array.from({ length: CONCURRENT_PUBLISHERS }, (_, i) => i + 1),
      'versions must be unique and gapless — 1..N with nothing handed out twice and nothing skipped',
    );

    // Every allocation must also have landed as its own row with its own
    // content hash: a number handed out twice would show up here as a lost
    // row, not just as a duplicate above.
    const rows = await store.listVersions(appId);
    assert.equal(rows.length, CONCURRENT_PUBLISHERS);
    const hashes = new Set(rows.map((r) => r.dirHash));
    assert.equal(hashes.size, CONCURRENT_PUBLISHERS, 'no publish may have been overwritten by another');

    // The counter is left pointing past the last allocation, so the next
    // publish continues the sequence instead of replaying a used number.
    const counter = await pool.query<{ next_version: number }>(`SELECT next_version FROM publish_apps WHERE app_id = $1`, [
      appId,
    ]);
    assert.equal(counter.rows[0]!.next_version, CONCURRENT_PUBLISHERS + 1);
  });

  it('a createVersion whose version insert fails burns no version number — the counter rolls back with it (#834)', async () => {
    const appId = `pg-gap-${String(Date.now())}`;

    // Occupy version 1 behind the store's back, so the allocation succeeds
    // but the `publish_versions` insert that follows it inside the same
    // transaction hits the primary key and forces a ROLLBACK.
    await pool.query(
      `INSERT INTO publish_versions (app_id, version, name, entrypoint, dir_hash, source_scope_key)
       VALUES ($1, 1, 'squatter', 'squat.js', 'squat', 's')`,
      [appId],
    );
    await assert.rejects(() =>
      store.createVersion({ appId, name: 'A', entrypoint: 'x.js', dirHash: 'h1', sourceScopeKey: 's', now: new Date() }),
    );

    // With the allocation held inside the caller's transaction, the rollback
    // takes the counter with it. An allocator that committed the counter
    // separately would leave version 1 consumed and hand out 2 here — a gap,
    // and a version number retired without a row to show for it.
    await pool.query(`DELETE FROM publish_versions WHERE app_id = $1`, [appId]);
    const retried = await store.createVersion({
      appId,
      name: 'A',
      entrypoint: 'x.js',
      dirHash: 'h1',
      sourceScopeKey: 's',
      now: new Date(),
    });
    assert.equal(retried.version, 1);
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
