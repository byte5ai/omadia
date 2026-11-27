/**
 * Memory-ACL plan, step 5 — lifecycle invariants on Neon, the jobs that age,
 * replay, merge and erase memory: the decay sweep (on rows aged 90 days, the
 * fake clock), the transcript backfill, auto-merge and a user purge
 * (ADR-0186). Around each, access must not widen without an ACL audit row
 * (`lifecycle.ts`). A replay must keep each turn's owners, user and Privacy
 * Shield flag; a user purge must remove what the person owned alone from
 * every tenant table and their member-notes trees, and de-own shared entries
 * with a `shrink` audit row. The former gaps #2278/#2279 are regular tests since their fixes landed.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import express from 'express';

import { InMemoryMemoryStore } from '@omadia/memory';
import { backfillGraph, createMergeCandidateDetector } from '@omadia/orchestrator-extras';
import { runDecaySweep } from '@omadia/knowledge-graph-neon/dist/decayJob.js';
import type { EmbeddingClient } from '@omadia/plugin-api';

import { createMemoryPurgeRouter } from '../../src/routes/memoryPurge.js';
import { invoke } from '../_helpers/httpInvoke.js';
import { ADMIN_SESSION } from '../_helpers/memoryPurgeHarness.js';
import { canariesIn } from './aclContract.js';
import { guarded, pool, widenedBy, world } from './lifecycle.js';
import { axis, mkGroup, readBack, scratchPath } from './seed.js';
import { USERS } from './world.js';

/** What the user purge widened; asserted by its own test (#2278). */
let purgeWidening: string[] | undefined;
/** Rows of memories alice owned alone still there after the purge (#2279). */
const purgeMemoryLeft: string[] = [];
let purgeRan = false;

describe('memory lifecycle invariants on Neon: jobs that age, merge and erase memory (memory-ACL plan step 5)', () => {
  it('the decay sweep on 90-day-old rows changes nobody\'s access', async (t) => {
    const n = world();
    if (!n) return t.skip('no test database');
    await guarded(n, 'decay sweep', async () => {
      // The fake clock: the whole tenant is 90 days older.
      await pool!.query(
        `UPDATE graph_nodes SET created_at = created_at - interval '90 days',
                accessed_at = accessed_at - interval '90 days'
          WHERE tenant_id = $1`,
        [n.tenants.main],
      );
      const stats = await runDecaySweep({
        pool: pool!,
        tenantId: n.tenants.main,
        lambda: 0.05,
        hotToWarmScoreThreshold: 0.5,
        hotToWarmIdleDays: 7,
        warmToColdScoreThreshold: 0.2,
        warmToColdIdleDays: 30,
        doneTaskTtlHours: 24,
        log: () => undefined,
      });
      assert.ok(stats.decayUpdated > 0, 'the sweep reached the turns');
    });
  });

  it('a transcript backfill keeps each turn\'s owners, user and Privacy Shield flag', async (t) => {
    const n = world();
    if (!n) return t.skip('no test database');
    type Row = { external_id: string; scope: string; user_id: string | null; owners: unknown; unprotected: unknown };
    const read = async (): Promise<Map<string, Row>> => {
      const res = await pool!.query<Row>(
        `SELECT external_id, scope, user_id, properties->'owners' AS owners,
                properties->'unprotected' AS unprotected
           FROM graph_nodes WHERE tenant_id = $1 AND type = 'Turn'`,
        [n.tenants.main],
      );
      return new Map(res.rows.map((r) => [r.external_id, r]));
    };
    const beforeRows = await read();
    // The transcripts a SessionLogger would have written for these turns.
    const store = new InMemoryMemoryStore();
    const files = new Map<string, string>();
    for (const r of beforeRows.values()) {
      const time = r.external_id.slice(`turn:${r.scope}:`.length);
      const path = `/memories/sessions/${r.scope}/${time.slice(0, 10)}.md`;
      files.set(
        path,
        `${files.get(path) ?? '# Session\n\n'}### ${time.slice(11, -1)}Z\n\n**User:**\n\nNochmal\n\n**Assistant:**\n\nNotiert.\n\n---\n\n`,
      );
    }
    for (const [path, body] of files) await store.createFile(path, body);
    let turns = 0;
    await guarded(n, 'backfill', async () => {
      turns = (await backfillGraph(store, n.seeded.stores.main.graph)).turns;
    });
    assert.ok(turns >= beforeRows.size, `replayed ${String(turns)} of ${String(beforeRows.size)} turns`);
    const afterRows = await read();
    const changed: string[] = [];
    for (const [id, b] of beforeRows) {
      const a = afterRows.get(id);
      if (JSON.stringify([a?.user_id, a?.owners, a?.unprotected]) !== JSON.stringify([b.user_id, b.owners, b.unprotected])) {
        changed.push(id);
      }
    }
    assert.equal(afterRows.size, beforeRows.size, 'a replay wrote new turns instead of the same ones');
    assert.deepEqual(changed, [], 'a replay changed who owns a turn');
  });

  it('auto-merge removes duplicates without widening access', async (t) => {
    const n = world();
    if (!n) return t.skip('no test database');
    const mks = n.seeded.world.byStore['memorable-knowledge'].filter((x) => x.tenant === 'main');
    const byCanary = new Map(mks.map((x) => [x.canary, x]));
    // The world's embedding: one axis per (owners × visibility) group.
    const embeddingClient = {
      async embed(text: string) {
        const item = byCanary.get(canariesIn(text)[0] ?? '');
        return item ? axis(mkGroup(item)) : axis(599);
      },
    } as unknown as EmbeddingClient;
    const detector = createMergeCandidateDetector({
      graph: n.seeded.stores.main.graph,
      embeddingClient,
      autoMergeThreshold: 0.9,
      minSimilarity: 0.9,
      // The whole group shares one axis; scan all of it so the copy is seen.
      topK: 1000,
      log: () => undefined,
    });
    const count = async (): Promise<number> =>
      Number((await pool!.query<{ c: string }>(
        `SELECT count(*) AS c FROM graph_nodes WHERE tenant_id = $1 AND type = 'MemorableKnowledge'`,
        [n.tenants.main],
      )).rows[0]!.c);
    const sources = mks.filter((x) => x.authorship === 'conversation' && x.provenance === 'protected');
    // ADR-0190: only a machine-made copy with the same text is retired; the
    // world's group mates differ in their canary and stay open pairs. Give
    // each source such a copy (same owners, visibility and agent, same axis).
    const graph = n.seeded.stores.main.graph;
    for (const mk of sources) {
      const id = n.seeded.location.get(mk.canary)!;
      const row = (await pool!.query<{ properties: Record<string, unknown>; visibility: string | null }>(
        `SELECT properties, visibility FROM graph_nodes WHERE tenant_id = $1 AND external_id = $2`,
        [n.tenants.main, id],
      )).rows[0]!;
      const p = row.properties;
      const owners = Array.isArray(p['acl_owners']) ? (p['acl_owners'] as string[]) : [];
      const copy = await graph.createMemorableKnowledge({
        kind: p['kind'] as 'reference',
        summary: String(p['summary']),
        createdBy: String(p['created_by']),
        ...(owners.length > 0 ? { aclOwners: owners } : {}),
        ...(row.visibility ? { visibility: row.visibility as 'private' } : {}),
        ...(typeof p['origin_agent'] === 'string' ? { originAgent: p['origin_agent'] } : {}),
      });
      await pool!.query(
        `UPDATE graph_nodes SET embedding = $3::vector WHERE tenant_id = $1 AND external_id = $2`,
        [n.tenants.main, copy.memorableKnowledgeNodeId, `[${axis(mkGroup(mk)).join(',')}]`],
      );
    }
    const beforeCount = await count();
    await guarded(n, 'auto-merge', async () => {
      // Sources: one memory per owners × visibility × agent; their duplicates
      // are searched among all of them.
      for (const mk of sources) {
        const id = n.seeded.location.get(mk.canary)!;
        if (await graph.getMemorableKnowledge(id)) await detector.detectFor(id);
      }
    });
    // Positive control: duplicates were found and retired.
    assert.ok((await count()) < beforeCount, 'auto-merge retired nothing; the check proved nothing');
  });

  it('a user purge erases what the person owned alone, everywhere, and de-owns the rest (ADR-0186)', async (t) => {
    const n = world();
    if (!n) return t.skip('no test database');
    const tenant = n.tenants.main;
    const alice = [n.seeded.users.main.alice, USERS.alice];
    const mkRows = (
      await pool!.query<{ external_id: string; summary: string; owners: unknown }>(
        `SELECT external_id, properties->>'summary' AS summary, properties->'acl_owners' AS owners
           FROM graph_nodes WHERE tenant_id = $1 AND type = 'MemorableKnowledge'`,
        [tenant],
      )
    ).rows.map((r) => ({ ...r, owners: Array.isArray(r.owners) ? (r.owners as string[]) : [] }));
    const excerptOf = new Map(n.seeded.world.byStore.excerpt.map((e) => [e.parent.canary, e.canary]));
    const alone = mkRows.filter((r) => r.owners.length > 0 && r.owners.every((o) => alice.includes(o)));
    const shared = mkRows.filter((r) => r.owners.some((o) => alice.includes(o)) && !r.owners.every((o) => alice.includes(o)));
    const memoryCanaries = new Set(alone.flatMap((r) => {
      const c = canariesIn(r.summary)[0]!;
      return excerptOf.has(c) ? [c, excerptOf.get(c)!] : [c];
    }));
    const goneCanaries = [...memoryCanaries];
    const datasets = n.seeded.world.byStore.dataset.filter((d) => d.tenant === 'main' && d.owner === 'alice');
    goneCanaries.push(...datasets.map((d) => d.canary));
    const datasetIds = datasets.map((d) => n.seeded.location.get(d.canary)!);
    const notes = n.seeded.world.byStore.scratch.filter(
      (s) => s.tenant === 'main' && s.tier === 'members' && s.owners!.includes('alice'),
    );
    assert.ok(alone.length > 0 && shared.length > 0 && datasets.length > 0 && notes.length > 0, 'the world has something to purge');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = ADMIN_SESSION;
      next();
    });
    app.use('/purge', createMemoryPurgeRouter({
      store: n.seeded.stores.main.memory,
      knowledgeGraph: n.seeded.stores.main.graph,
      tenantId: tenant,
    }));
    const selector = n.seeded.users.main.alice;
    purgeWidening = await widenedBy(n, async () => {
      const preview = await invoke(app, 'POST', '/purge/preview', { json: { axis: 'user', selector } });
      assert.equal(preview.status, 200, preview.text);
      const token = (JSON.parse(preview.text) as { previewToken: string }).previewToken;
      const res = await invoke(app, 'DELETE', '/purge', {
        json: { axis: 'user', selector, confirm: selector, previewToken: token },
      });
      assert.equal(res.status, 200, res.text);
    });

    // Gone from every row of this tenant, in every table that has a tenant.
    const tables = (
      await pool!.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND column_name = 'tenant_id'`,
      )
    ).rows.map((r) => r.table_name);
    const patterns = goneCanaries.map((c) => `%${c}%`);
    const found: string[] = [];
    for (const table of tables) {
      const res = await pool!.query<{ row: string }>(
        `SELECT x::text AS row FROM "${table}" x WHERE x.tenant_id::text = $1 AND x::text LIKE ANY($2)`,
        [tenant, patterns],
      );
      for (const r of res.rows) {
        for (const c of canariesIn(r.row).filter((x) => goneCanaries.includes(x))) {
          (memoryCanaries.has(c) ? purgeMemoryLeft : found).push(`${table}: ${c}`);
        }
      }
    }
    const rows = await pool!.query('SELECT 1 FROM dataset_rows WHERE dataset_id = ANY($1::uuid[])', [datasetIds]);
    if ((rows.rowCount ?? 0) > 0) found.push(`dataset_rows: ${String(rows.rowCount)} rows of alice's datasets`);
    for (const note of notes) {
      if ((await readBack(n.seeded, note)) !== undefined) found.push(`${scratchPath(note, n.seeded.users)}: ${note.canary}`);
    }
    assert.deepEqual(found, [], 'the purge left datasets or member notes of alice');
    // Positive control for the purge tests below: the scan does find memory rows.
    assert.ok(goneCanaries.length > found.length, 'nothing to look for');

    const graph = n.seeded.stores.main.graph;
    const kept: string[] = [];
    for (const r of shared) {
      const node = await graph.getMemorableKnowledge(r.external_id);
      if (!node) {
        kept.push(`${r.external_id}: shared entry deleted`);
        continue;
      }
      const owners = (node.props['acl_owners'] as string[] | undefined) ?? [];
      if (owners.includes(selector)) kept.push(`${r.external_id}: still owned by alice's omadia id`);
      const audit = await graph.listMemoryAclAudit(r.external_id);
      if (!audit.some((a) => a.action === 'shrink')) kept.push(`${r.external_id}: no shrink row`);
    }
    assert.deepEqual(kept, [], 'shared entries are de-owned with an audit row, never deleted');
    purgeRan = true;
  });

  it(
    'a user purge erases the memories the person owned alone, in every id form',
    (t) => {
      if (!purgeRan) return t.skip('the purge did not run');
      assert.deepEqual(purgeMemoryLeft.slice(0, 30), [], `the purge left ${String(purgeMemoryLeft.length)} memory rows alice owned alone`);
    },
  );

  it(
    'a user purge widens nobody\'s access',
    (t) => {
      if (!purgeWidening) return t.skip('the purge did not run');
      assert.deepEqual(purgeWidening.slice(0, 30), [], `user purge widened access without an ACL audit row (${String(purgeWidening.length)})`);
    },
  );
});
