/**
 * #1540 — stored-process provenance in the Neon store, against a real
 * pgvector Postgres (`GRAPH_PG_TEST_URL`; skipped without one): the
 * `unprotected` column from migration 0035, sticky edits, the shielded query
 * filter and the duplicate branch.
 */
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { NeonProcessMemoryStore } from '@omadia/knowledge-graph-neon/dist/processMemoryStore.js';
import type { EmbeddingClient } from '@omadia/plugin-api';

import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = 'process-provenance-1540';

/** One-hot vectors per topic (orthogonal, so never a duplicate); the query
 *  `beide` points between both topics and matches both. */
const embedder: EmbeddingClient = {
  async embed(text: string) {
    const v = Array.from({ length: 768 }, () => 0);
    if (text === 'beide') {
      v[1] = 1;
      v[2] = 1;
    } else {
      v[text.includes('Mahnung') ? 1 : 2] = 1;
    }
    return v;
  },
} as unknown as EmbeddingClient;

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'processProvenancePg1540',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM process_history WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM processes WHERE tenant_id = $1', [TENANT]);
  await pool.end();
});

describe('#1540 · NeonProcessMemoryStore provenance (real PG)', () => {
  it('stores, keeps and filters the unprotected flag', async (t) => {
    if (!pool) return t.skip('no test database');
    await runGraphMigrations(pool);
    await pool.query('DELETE FROM process_history WHERE tenant_id = $1', [TENANT]);
    await pool.query('DELETE FROM processes WHERE tenant_id = $1', [TENANT]);
    const store = new NeonProcessMemoryStore({
      pool,
      tenantId: TENANT,
      resolveEmbeddingClient: () => embedder,
    });

    const open = await store.write({
      title: 'Kunde: Mahnung an Anita Oliver',
      steps: ['Mail an anita.oliver@example-kunde.de'],
      scope: 's',
      unprotected: true,
    });
    const guarded = await store.write({ title: 'Backend: Deploy to staging', steps: ['deploy'], scope: 's' });
    assert.ok(open.ok && guarded.ok);
    assert.equal(open.record.unprotected, true);
    assert.equal(guarded.record.unprotected, undefined);
    assert.equal((await store.get(open.record.id))?.unprotected, true);

    const titles = async (excludeUnprotected: boolean) =>
      (await store.query({ query: 'beide', limit: 10, excludeUnprotected }))
        .map((h) => h.record.title)
        .sort();
    assert.deepEqual(await titles(false), ['Backend: Deploy to staging', 'Kunde: Mahnung an Anita Oliver']);
    assert.deepEqual(await titles(true), ['Backend: Deploy to staging']);

    // Sticky: a protected edit keeps the flag, an unprotected edit sets it.
    const kept = await store.edit({ id: open.record.id, visibility: 'team' });
    assert.ok(kept.ok && kept.record.unprotected === true);
    const set = await store.edit({ id: guarded.record.id, visibility: 'team', unprotected: true });
    assert.ok(set.ok && set.record.unprotected === true);

    // The duplicate branch reports the conflicting process's provenance.
    const dup = await store.write({ title: 'Kunde: Mahnung erneut', steps: ['x'], scope: 's' });
    assert.equal(dup.ok, false);
    assert.ok(!dup.ok && dup.reason === 'duplicate' && dup.conflictingUnprotected === true);
  });
});
