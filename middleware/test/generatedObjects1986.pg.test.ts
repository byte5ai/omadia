/**
 * #1986 (ADR-0187) — the Postgres side of the generated-object registry
 * (migration 0119), against a real Postgres (`GRAPH_PG_TEST_URL`; skipped
 * without one): records per (key, producer, person, chat), refcounted release.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import {
  createGeneratedObjectsRegistry,
  PostgresGeneratedObjectStore,
  type GeneratedObjectTurn,
} from '../src/services/generatedObjects.js';
import { probePgTest } from './_helpers/pgTestDb.js';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'generatedObjects1986',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

after(async () => {
  await pool?.end();
});

describe('#1986 · PostgresGeneratedObjectStore (real PG)', () => {
  it('records, counts and releases by chat, person and all', async (t) => {
    if (!pool) return t.skip('no test database');
    await pool.query('DROP TABLE IF EXISTS generated_objects');
    await pool.query(await readFile(new URL('../migrations/0119_generated_objects.sql', import.meta.url), 'utf8'));
    const store = new PostgresGeneratedObjectStore(pool);
    let turn: GeneratedObjectTurn | undefined;
    const registry = createGeneratedObjectsRegistry({ store: () => store, currentTurn: () => turn, log: () => {} });
    const deleted: string[] = [];
    registry.registerDeleter('office', (key) => {
      deleted.push(key);
      return Promise.resolve();
    });
    const as = async (tt: GeneratedObjectTurn | undefined, key: string): Promise<void> => {
      turn = tt;
      await registry.record('office', key);
    };
    await as({ ownerOmadiaUserId: 'bea', scope: 'c1' }, 'k/shared');
    await as({ ownerOmadiaUserId: 'bea', scope: 'c1' }, 'k/shared'); // same record twice: one row
    await as({ ownerOmadiaUserId: 'ali', scope: 'c2' }, 'k/shared');
    await as({ ownerOmadiaUserId: 'bea', scope: 'c1' }, 'k/bea');
    await as(undefined, 'k/nobody');

    const rows = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM generated_objects');
    assert.equal(rows.rows[0]?.n, '4');
    assert.deepEqual(await registry.count({ scope: 'c1' }), { objects: 1, shared: 1 });

    assert.deepEqual(await registry.release({ scope: 'c1', ownerOmadiaUserId: 'bea' }), {
      deleted: 1,
      unreferenced: 1,
      pending: 0,
    });
    assert.deepEqual(deleted, ['k/bea']);
    assert.deepEqual(await registry.release({ ownerOmadiaUserId: 'ali' }), { deleted: 1, unreferenced: 0, pending: 0 });
    assert.deepEqual(await registry.release({ all: true }), { deleted: 1, unreferenced: 0, pending: 0 });
    assert.deepEqual(deleted.sort(), ['k/bea', 'k/nobody', 'k/shared']);
    const left = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM generated_objects');
    assert.equal(left.rows[0]?.n, '0');
  });
});
