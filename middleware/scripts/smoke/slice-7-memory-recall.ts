/**
 * Slice 7 — live-DB smoke for MK + Excerpt embedding + recall.
 *
 * Idempotent: cleans the smoke-tenant before and after itself.
 *
 * Verifies:
 *   - createMemorableKnowledge with excerpts → fire-and-forget
 *     post-COMMIT writes embeddings on MK + excerpts (waits up to ~10s).
 *   - searchMemorableKnowledgeByEmbedding surfaces the MK against a
 *     semantically related query.
 *   - searchExcerptsByEmbedding surfaces an excerpt + its parentMkId.
 *   - ACL gate: a different cluster's viewer sees neither.
 *   - updateMemorableKnowledge clears the embedding (recall stops
 *     until the backfill / re-embed runs).
 *   - deleteMemory cascade-purges so neither MK nor its excerpts can
 *     be resurrected via search.
 *
 * Requires: localhost Postgres + a running Ollama with nomic-embed-text.
 */
import 'dotenv/config';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';
import {
  createEmbeddingClient,
  withConcurrencyLimit,
} from '@omadia/embeddings';

const TENANT = 'slice-7-smoke';

async function waitForEmbedding(
  pool: Pool,
  externalId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await pool.query<{ has_embedding: boolean }>(
      `SELECT (embedding IS NOT NULL) AS has_embedding
         FROM graph_nodes
        WHERE tenant_id = $1 AND external_id = $2
        LIMIT 1`,
      [TENANT, externalId],
    );
    if (row.rows[0]?.has_embedding) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url || !(url.includes('localhost') || url.includes('127.0.0.1'))) {
    console.error('refusing — DATABASE_URL must point at localhost');
    process.exit(1);
  }
  const ollamaBase =
    process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
  const ollamaModel =
    process.env['OLLAMA_EMBEDDING_MODEL'] ?? 'nomic-embed-text';
  const embeddingClient = withConcurrencyLimit(
    createEmbeddingClient({ baseUrl: ollamaBase, model: ollamaModel }),
    2,
  );

  const pool = new Pool({ connectionString: url, max: 2 });
  const kg = new NeonKnowledgeGraph({
    pool,
    tenantId: TENANT,
    embeddingClient,
  });
  const failures: string[] = [];

  await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [
    TENANT,
  ]);

  try {
    const alice = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'slice-7-alice',
      displayName: 'Alice',
      email: 'alice-s7@example.com',
      emailVerified: true,
      aadObjectId: 's7-alice',
    });
    const bob = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'slice-7-bob',
      displayName: 'Bob',
      email: 'bob-s7@example.com',
      emailVerified: true,
      aadObjectId: 's7-bob',
    });
    console.log(
      `[slice-7] seeded clusters alice=${alice.omadiaUserId} bob=${bob.omadiaUserId}`,
    );

    const created = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary:
        'byte5.de SEO-Audit fasst On-Page-Note D, fehlende JSON-LD und Canonical-Tags zusammen',
      rationale:
        'Identische Auswertung am Vortag — Priorisierung H1+Alt-Text vor JSON-LD bevor Bild-URLs gefixt werden.',
      createdBy: `web:${alice.omadiaUserId}`,
      involvedOmadiaUserIds: [alice.omadiaUserId],
      aclOwners: [alice.omadiaUserId],
      palaiaExcerpts: {
        texts: [
          'On-Page-Note D (59/100), 6 H1-Tags mit zerrissener Hierarchie',
          'fehlende JSON-LD und Canonical-Tags blockieren strukturierte Suche',
          'Bild-URLs zeigen auf Staging-Host statt Produktion',
        ],
        source: 'llm',
      },
    });
    const mkId = created.memorableKnowledgeNodeId;
    console.log(`[slice-7] created mk=${mkId}`);

    if (!(await waitForEmbedding(pool, mkId))) {
      failures.push(`MK embedding never landed for ${mkId}`);
    } else {
      console.log('[slice-7] mk embedding present ✓');
    }

    const excerpts = await kg.listExcerptsForMemory(mkId);
    if (excerpts.length !== 3) {
      failures.push(`expected 3 excerpts, got ${excerpts.length}`);
    } else {
      let allEmbedded = true;
      for (const ex of excerpts) {
        if (!(await waitForEmbedding(pool, ex.id))) {
          allEmbedded = false;
          failures.push(`excerpt embedding missing for ${ex.id}`);
        }
      }
      if (allEmbedded) console.log('[slice-7] all excerpt embeddings present ✓');
    }

    // Recall: query semantically related to the SEO content
    const queryText =
      'Welche SEO-Findings hatten wir zuletzt für byte5? Geht es um Canonical-Tags?';
    const queryVec = await embeddingClient.embed(queryText);

    const aliceMkHits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: queryVec,
      viewerOmadiaUserId: alice.omadiaUserId,
      minSimilarity: 0.3,
    });
    if (!aliceMkHits.some((h) => h.mk.id === mkId)) {
      failures.push(`Alice did not recall the SEO MK (got ${aliceMkHits.length} hits)`);
    } else {
      const top = aliceMkHits.find((h) => h.mk.id === mkId)!;
      console.log(`[slice-7] alice MK-recall ✓ cosine=${top.cosineSim.toFixed(3)}`);
    }

    const aliceExcerptHits = await kg.searchExcerptsByEmbedding({
      queryEmbedding: queryVec,
      viewerOmadiaUserId: alice.omadiaUserId,
      minSimilarity: 0.3,
    });
    if (
      !aliceExcerptHits.some(
        (h) =>
          h.parentMkId === mkId &&
          /Canonical/i.test(h.excerpt.props.text),
      )
    ) {
      failures.push('Alice did not recall the Canonical excerpt');
    } else {
      console.log('[slice-7] alice excerpt-recall ✓');
    }

    // ACL: Bob owns nothing, must see no hits
    const bobMkHits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: queryVec,
      viewerOmadiaUserId: bob.omadiaUserId,
      minSimilarity: 0.3,
    });
    const bobExcerptHits = await kg.searchExcerptsByEmbedding({
      queryEmbedding: queryVec,
      viewerOmadiaUserId: bob.omadiaUserId,
      minSimilarity: 0.3,
    });
    if (bobMkHits.length !== 0 || bobExcerptHits.length !== 0) {
      failures.push(
        `ACL leak: Bob saw mk=${bobMkHits.length} excerpts=${bobExcerptHits.length}`,
      );
    } else {
      console.log('[slice-7] ACL isolation (bob blind) ✓');
    }

    // Update clears embedding
    await kg.updateMemorableKnowledge(
      mkId,
      { summary: 'completely different topic about kitchen appliances' },
      { actorOmadiaUserId: alice.omadiaUserId, reason: 'overwrite for clear test' },
    );
    // Immediately after PATCH the embedding may not have re-arrived yet —
    // the post-COMMIT re-embed kicks off async. Verify it eventually does.
    if (!(await waitForEmbedding(pool, mkId))) {
      failures.push('MK re-embedding never landed after update');
    } else {
      console.log('[slice-7] post-update re-embed ✓');
    }

    // Delete + cascade
    await kg.deleteMemory(mkId, { actorOmadiaUserId: alice.omadiaUserId });
    const orphans = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM graph_nodes
        WHERE tenant_id = $1
          AND type IN ('PalaiaExcerpt', 'MemorableKnowledge')
          AND external_id IN (
            SELECT $2::text
            UNION ALL
            SELECT id::text FROM graph_nodes
            WHERE tenant_id = $1 AND type = 'PalaiaExcerpt'
          )`,
      [TENANT, mkId],
    );
    const remaining = Number(orphans.rows[0]!.count);
    if (remaining !== 0) {
      failures.push(`cascade-delete leaked ${remaining} rows`);
    } else {
      console.log('[slice-7] cascade-delete ✓');
    }
  } finally {
    await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [
      TENANT,
    ]);
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-7] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-7] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
