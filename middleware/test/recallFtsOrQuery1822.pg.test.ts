/**
 * #1822 on the Neon backend, against a real pgvector Postgres (skipped without
 * one): turn and process recall without embeddings build an OR `tsquery` from
 * the message's content terms. A question with extra words finds the stored
 * fact; "ok" recalls nothing; tsquery syntax in the message cannot break the
 * query.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { NeonProcessMemoryStore } from '@omadia/knowledge-graph-neon/dist/processMemoryStore.js';
import type { EmbeddingClient } from '@omadia/plugin-api';
import type { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = `recall-fts-or-${Date.now()}`;
const DIMENSIONS = 768;

/** The write path needs an embedding; any unit vector will do. */
const embedder = {
  async embed(): Promise<number[]> {
    return Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
  },
} as unknown as EmbeddingClient;

let pool: Pool | undefined;
let reachable = false;
const kg = (): NeonKnowledgeGraph => new NeonKnowledgeGraph({ pool: pool!, tenantId: TENANT });

describe('Neon full-text recall · OR over content terms (#1822, real PG)', () => {
  before(async () => {
    const probe = await probePgTest({
      label: 'recallFtsOrQuery1822',
      vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
      requireVector: true,
    });
    if (!probe.reachable) return;
    pool = createNeonPool(probe.url!, 2);
    await runGraphMigrations(pool);
    reachable = true;
    await kg().ingestTurn({
      scope: 'default::chat-a',
      time: '2026-11-20T09:00:00.000Z',
      userMessage:
        'Zur Info für später: Der Testserver Reiher-p11 bekommt seine Sicherheits-Patches immer montags ab 6 Uhr morgens.',
      assistantAnswer: 'Alles klar.',
      entityRefs: [],
    });
    await kg().ingestTurn({
      scope: 'default::chat-b',
      time: '2026-11-20T10:00:00.000Z',
      userMessage: 'Wie ist das Wetter?',
      assistantAnswer: 'ok, sonnig.',
      entityRefs: [],
    });
    const writer = new NeonProcessMemoryStore({
      pool,
      tenantId: TENANT,
      resolveEmbeddingClient: () => embedder,
    });
    const written = await writer.write({
      title: 'Kunde: Rechnungskorrektur anlegen',
      steps: ['Rechnung in Odoo öffnen', 'Gutschrift erzeugen'],
      scope: 'default::chat-a',
    });
    assert.equal(written.ok, true);
  });

  after(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM process_history WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await pool.query('DELETE FROM processes WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await pool.query('DELETE FROM graph_edges WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await pool.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it('searchTurns finds the fact for a question with extra words', async (t) => {
    if (!reachable) return t.skip('no pg');
    const hits = await kg().searchTurns({
      query: 'Wann bekommt der Reiher-p11 seine Sicherheits-Patches?',
      limit: 5,
    });
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.userMessage, /Reiher-p11/);
    assert.ok(hits[0]!.rank > 0);
  });

  it('searchTurns recalls nothing for "ok" and survives tsquery syntax', async (t) => {
    if (!reachable) return t.skip('no pg');
    assert.deepEqual(await kg().searchTurns({ query: 'ok', limit: 5 }), []);
    const hits = await kg().searchTurns({ query: "Reiher-p11 & 'x' | !(:*", limit: 5 });
    assert.equal(hits.length, 1);
  });

  it('process recall without an embedding finds a process on one shared word', async (t) => {
    if (!reachable) return t.skip('no pg');
    const reader = new NeonProcessMemoryStore({
      pool: pool!,
      tenantId: TENANT,
      resolveEmbeddingClient: () => undefined,
    });
    const hits = await reader.query({ query: 'Wie mache ich eine Gutschrift für den Kunden?' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.record.title, 'Kunde: Rechnungskorrektur anlegen');
    assert.deepEqual(await reader.query({ query: 'ok' }), []);
  });
});
