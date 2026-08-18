/**
 * #575 — `bindIfAbsent` against a real Postgres.
 *
 * There is exactly one clause in this store that carries a security property:
 * `ON CONFLICT (storage_key) DO NOTHING`. An `UPSERT` there would let a room
 * that was just refused re-bind the handle to itself and read it on the next
 * attempt — the leak the binding exists to prevent, reintroduced by one word.
 *
 * That clause cannot be exercised by a hand-rolled fake: a fake with
 * first-sighting-wins semantics proves only that the *fake* has them. So this
 * suite runs the real class against a real database, including two writers
 * racing on the same key — where DO NOTHING is also what makes a concurrent
 * first sighting safe rather than a primary-key violation.
 *
 * Skips cleanly (issue #572: no hardcoded default port) when no test database
 * is configured.
 */

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { PostgresAttachmentBindingStore } from '../src/audience/postgresAttachmentBindingStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'attachmentBindingStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

/** Migration 0036, applied directly so this suite does not depend on the
 *  multi-orchestrator migrator having run against the test database. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS attachment_scope_bindings (
  storage_key TEXT        PRIMARY KEY,
  scope_kind  TEXT        NOT NULL,
  scope_ref   TEXT        NOT NULL,
  bound_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

describe('#575 PostgresAttachmentBindingStore', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: PostgresAttachmentBindingStore;
  const mark = randomUUID().slice(0, 8);
  const key = `att/${mark}/report.pdf`;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    await pool.query(SCHEMA);
    store = new PostgresAttachmentBindingStore(pool);
  });

  after(async () => {
    await pool.query(`DELETE FROM attachment_scope_bindings WHERE storage_key LIKE $1`, [
      `%${mark}%`,
    ]);
    await pool.end();
  });

  it('returns undefined for a key it has never seen', async () => {
    assert.equal(await store.get(`${key}-unknown`), undefined);
  });

  it('records the minting room and reads it back', async () => {
    await store.bindIfAbsent(key, { scopeKind: 'conversation', scopeRef: 'teams::conv-A' });
    assert.deepEqual(await store.get(key), {
      scopeKind: 'conversation',
      scopeRef: 'teams::conv-A',
    });
  });

  it('does NOT overwrite an existing binding', async () => {
    // The security clause. An UPSERT here would hand the handle to conv-B.
    await store.bindIfAbsent(key, { scopeKind: 'conversation', scopeRef: 'teams::conv-B' });
    assert.deepEqual(await store.get(key), {
      scopeKind: 'conversation',
      scopeRef: 'teams::conv-A',
    });
  });

  it('survives two rooms racing on the same key', async () => {
    // Concurrent first sightings: DO NOTHING makes the loser a no-op instead of
    // a 23505, and exactly one room ends up owning the handle.
    const raced = `att/${mark}/raced.pdf`;
    await Promise.all([
      store.bindIfAbsent(raced, { scopeKind: 'conversation', scopeRef: 'room-1' }),
      store.bindIfAbsent(raced, { scopeKind: 'conversation', scopeRef: 'room-2' }),
      store.bindIfAbsent(raced, { scopeKind: 'conversation', scopeRef: 'room-3' }),
    ]);
    const winner = await store.get(raced);
    assert.ok(winner);
    assert.ok(['room-1', 'room-2', 'room-3'].includes(winner.scopeRef));

    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM attachment_scope_bindings WHERE storage_key = $1`,
      [raced],
    );
    assert.equal(count.rows[0]?.n, '1');
  });
});
