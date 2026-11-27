/**
 * #2296 / ADR-0295 — process ids carry nothing of the title.
 *
 * Neon migration 0040 rewrites every `process:<scope>:<slug>` id to
 * `process:<uuid>` (history rows follow) and keeps the old one in
 * `legacy_id`; the store resolves either form, and new writes get an opaque
 * id. Real Postgres (pgvector).
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { NeonProcessMemoryStore } from '@omadia/knowledge-graph-neon/dist/processMemoryStore.js';
import type { EmbeddingClient } from '@omadia/plugin-api';

import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = 'w31-opaque-process-ids';
const OPAQUE = /^process:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages/harness-knowledge-graph-neon/src/migrations/0040_process_opaque_ids.sql',
);

const embedder: EmbeddingClient = {
  async embed(text: string) {
    const v = Array.from({ length: 768 }, () => 0);
    v[text.length % 768] = 1;
    return v;
  },
} as unknown as EmbeddingClient;

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'processOpaqueIds',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

async function wipe(p: Pool): Promise<void> {
  await p.query('DELETE FROM process_history WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM processes WHERE tenant_id = $1', [TENANT]);
}

after(async () => {
  if (!pool) return;
  await wipe(pool);
  await pool.end();
});

describe('#2296 · opaque process ids (real PG)', () => {
  it('rewrites a legacy id, keeps it resolvable, and history follows', async (t) => {
    if (!pool) return t.skip('no test database');
    await runGraphMigrations(pool);
    await wipe(pool);
    const legacy = 'process:hr::chat:kunde-rechnung-an-hans-mueller-acme-de';
    // A row as an install before 0040 holds it: slug id, no legacy_id.
    await pool.query(
      `INSERT INTO processes (id, tenant_id, scope, title, steps, visibility, version)
       VALUES ($1, $2, 'hr::chat', 'Kunde: Rechnung an hans.mueller@acme.de', '["Senden"]'::jsonb, 'team', 2)`,
      [legacy, TENANT],
    );
    await pool.query(
      `INSERT INTO process_history (id, tenant_id, version, title, steps, visibility)
       VALUES ($1, $2, 1, 'Kunde: Rechnung', '["Senden"]'::jsonb, 'team')`,
      [legacy, TENANT],
    );

    await pool.query(readFileSync(MIGRATION, 'utf8'));
    // Idempotent: a second run changes nothing.
    const first = await pool.query<{ id: string; legacy_id: string }>(
      'SELECT id, legacy_id FROM processes WHERE tenant_id = $1',
      [TENANT],
    );
    await pool.query(readFileSync(MIGRATION, 'utf8'));
    const second = await pool.query<{ id: string }>('SELECT id FROM processes WHERE tenant_id = $1', [TENANT]);
    assert.equal(second.rows[0]?.id, first.rows[0]?.id);

    const row = first.rows[0];
    assert.ok(row);
    assert.match(row.id, OPAQUE);
    assert.ok(!row.id.includes('mueller'), 'nothing of the title in the id');
    assert.equal(row.legacy_id, legacy);

    const store = new NeonProcessMemoryStore({ pool, tenantId: TENANT, resolveEmbeddingClient: () => embedder });
    const byOld = await store.get(legacy);
    assert.equal(byOld?.id, row.id);
    assert.equal(byOld?.legacyId, legacy);
    assert.equal((await store.get(row.id))?.id, row.id);
    const history = await store.history(legacy);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.id, row.id);

    const edited = await store.edit({ id: legacy, visibility: 'private' });
    assert.equal(edited.ok, true);
    if (!edited.ok) throw new Error('unreachable');
    assert.equal(edited.record.id, row.id);
    assert.equal(edited.record.visibility, 'private');
  });

  it('rekeyLegacyIds re-keys a slug id an older build wrote after 0040', async (t) => {
    if (!pool) return t.skip('no test database');
    await runGraphMigrations(pool);
    await wipe(pool);
    await pool.query(
      `INSERT INTO processes (id, tenant_id, scope, title, steps, visibility)
       VALUES ('process:s:late-write', $1, 's', 'Ops: Late write', '["x"]'::jsonb, 'team')`,
      [TENANT],
    );
    const store = new NeonProcessMemoryStore({ pool, tenantId: TENANT, resolveEmbeddingClient: () => embedder });
    assert.equal(await store.rekeyLegacyIds(), 1);
    assert.equal(await store.rekeyLegacyIds(), 0);
    const rec = await store.get('process:s:late-write');
    assert.match(rec?.id ?? '', OPAQUE);
  });

  it('a new write gets an opaque id', async (t) => {
    if (!pool) return t.skip('no test database');
    await runGraphMigrations(pool);
    await wipe(pool);
    const store = new NeonProcessMemoryStore({ pool, tenantId: TENANT, resolveEmbeddingClient: () => embedder });
    const written = await store.write({
      title: 'Finance: Send the invoice to hans.mueller@acme.de',
      steps: ['Open the invoice', 'Send it'],
      scope: 'finance::chat',
    });
    assert.equal(written.ok, true);
    if (!written.ok) throw new Error('unreachable');
    assert.match(written.record.id, OPAQUE);
    assert.equal(written.record.legacyId, undefined);
  });
});
