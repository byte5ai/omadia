/**
 * Memory-ACL plan, step 5 — lifecycle invariants on Neon, the jobs that write
 * memory: identity resolution, turn promotion, bulk promotion, the scratch
 * reaper and owner removal. Around each, access must not widen without an ACL
 * audit row, and what a job creates is readable only as the oracle allows
 * (`lifecycle.ts`). Decay, backfill, auto-merge and the user purge are in
 * `lifecycleCleanup.pg.test.ts`; random operation sequences and scope-key
 * injectivity in `lifecycleInvariants.test.ts`.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createBulkPromotionService,
  createScratchPromotionReaper,
  promoteTurnIfSignificant,
} from '@omadia/orchestrator-extras';

import { assertOracleBounds, guarded, mkShape, pool, reaperPath, run, world } from './lifecycle.js';
import { AGENTS, USERS, USER_KEYS, presentIn } from './world.js';

describe('memory lifecycle invariants on Neon: jobs that write memory (memory-ACL plan step 5)', () => {
  it('identity resolution merges only a verified e-mail, and only inside the tenant', async (t) => {
    const n = world();
    if (!n) return t.skip('no test database');
    const email = `lifecycle-${run}@example.test`;
    await guarded(n, 'identity resolution', async () => {
      const main = n.seeded.stores.main.graph;
      const first = await main.resolveOrCreateChannelIdentity({
        channelKind: 'slack', channelUserId: `s-${run}`, email, emailVerified: true,
      });
      const unverified = await main.resolveOrCreateChannelIdentity({
        channelKind: 'telegram', channelUserId: `t-${run}`, email, emailVerified: false,
      });
      const verified = await main.resolveOrCreateChannelIdentity({
        channelKind: 'discord', channelUserId: `d-${run}`, email, emailVerified: true,
      });
      const otherTenant = await n.seeded.stores.other.graph.resolveOrCreateChannelIdentity({
        channelKind: 'slack', channelUserId: `s-${run}`, email, emailVerified: true,
      });
      // Positive control: a verified e-mail does join the cluster.
      assert.equal(verified.omadiaUserId, first.omadiaUserId, 'a verified e-mail joins the cluster');
      assert.notEqual(unverified.omadiaUserId, first.omadiaUserId, 'an unverified e-mail never merges');
      assert.notEqual(otherTenant.omadiaUserId, first.omadiaUserId, 'clusters never cross tenants');
      for (const u of USER_KEYS) {
        assert.notEqual(n.seeded.users.main[u], first.omadiaUserId, `${u} was merged into a stranger`);
      }
    });
  });

  it('promoting a room turn: the memory belongs to the people present, nobody else reads it', async (t) => {
    const n = world();
    if (!n) return t.skip('no test database');
    const turn = n.seeded.world.byStore.turn.find(
      (x) => x.tenant === 'main' && x.agent === 'atlas' && x.context === 'room1' &&
        x.owners === 'present' && !x.tailOnly && !x.unprotected,
    )!;
    const turnId = n.seeded.location.get(turn.canary)!;
    const present = presentIn(turn.context, turn.sender);
    let mkId: string | undefined;
    await guarded(n, 'turn promotion', async () => {
      await pool!.query(
        `UPDATE graph_nodes SET significance = 0.9 WHERE tenant_id = $1 AND external_id = $2`,
        [n.tenants.main, turnId],
      );
      const res = await promoteTurnIfSignificant({
        pool: pool!,
        tenantId: n.tenants.main,
        kg: n.seeded.stores.main.graph,
        turnId,
        userId: n.seeded.users.main[turn.sender],
        threshold: 0.7,
        owners: present.map((u) => n.seeded.users.main[u]).sort(),
        originAgent: AGENTS.atlas,
        fallbackAssistantAnswer: 'Gelernt.',
        log: () => undefined,
      });
      assert.equal(res.reason, 'promoted');
      mkId = res.mkId;
    });
    const allowed = await assertOracleBounds(n, mkId!, mkShape('CANARY-PROMO-00001Z', present, 'atlas'));
    assert.ok(allowed > 0, 'nobody reads the promoted memory; the check proved nothing');
  });

  it('bulk promotion: each memory belongs to its turn\'s user only', async (t) => {
    const n = world();
    if (!n) return t.skip('no test database');
    const turn = n.seeded.world.byStore.turn.find(
      (x) => x.tenant === 'main' && x.agent === 'boreas' && x.context === 'web' &&
        x.sender === 'bob' && !x.tailOnly && !x.unprotected,
    )!;
    const turnId = n.seeded.location.get(turn.canary)!;
    const since = new Date(Date.now() - 1000);
    await guarded(n, 'bulk promotion', async () => {
      await pool!.query(
        `UPDATE graph_nodes SET significance = 0.9 WHERE tenant_id = $1 AND external_id = $2`,
        [n.tenants.main, turnId],
      );
      const res = await createBulkPromotionService({
        pool: pool!,
        tenantId: n.tenants.main,
        kg: n.seeded.stores.main.graph,
        // Scores one unscored turn low; the promote phase is what is under test.
        scorer: { score: async () => ({ score: 0.1 }) },
        log: () => undefined,
      }).run({ threshold: 0.7, scoreLimit: 1 });
      assert.ok(res.promotePhase.promoted >= 1, JSON.stringify(res));
    });
    const rows = await pool!.query<{ external_id: string }>(
      `SELECT mk.external_id FROM graph_nodes mk
         JOIN graph_edges e ON e.from_node = mk.id AND e.type = 'DERIVED_FROM'
         JOIN graph_nodes t ON t.id = e.to_node
        WHERE mk.tenant_id = $1 AND mk.type = 'MemorableKnowledge' AND t.external_id = $2
          AND mk.created_at >= $3`,
      [n.tenants.main, turnId, since],
    );
    assert.equal(rows.rowCount, 1, 'bulk promotion wrote one memory for the turn');
    // Bulk promotion stamps no origin agent.
    const allowed = await assertOracleBounds(n, rows.rows[0]!.external_id, mkShape('CANARY-BULK-00001Z', ['bob'], 'none'));
    assert.ok(allowed > 0, 'nobody reads the promoted memory; the check proved nothing');
  });

  it('the scratch reaper: promoted scratch has no owner and nobody reads it', async (t) => {
    const n = world();
    if (!n) return t.skip('no test database');
    const canary = 'CANARY-REAP-00001Z';
    const content = `Notiz ${canary} mit genug Inhalt fuer eine Promotion`;
    await pool!.query(
      `INSERT INTO memory_files (virtual_path, content, size_bytes, created_at, updated_at)
       VALUES ($1, $2, $3, now() - interval '3 days', now() - interval '3 days')`,
      [reaperPath, content, Buffer.byteLength(content)],
    );
    await guarded(n, 'scratch reaper', async () => {
      const reaper = createScratchPromotionReaper({
        pool: pool!,
        tenantId: n.tenants.main,
        kg: n.seeded.stores.main.graph,
        scorer: { score: async () => ({ score: 0.95 }) },
        threshold: 0.7,
        ageMs: 24 * 3_600_000,
        intervalMs: 60_000,
        defaultVisibility: 'private',
        log: () => undefined,
      });
      const res = await reaper.runOnce({ agentSlug: AGENTS.atlas, limit: 50 });
      assert.ok(res.promoted >= 1, JSON.stringify(res));
    });
    const row = await pool!.query<{ external_id: string }>(
      `SELECT external_id FROM graph_nodes
        WHERE tenant_id = $1 AND type = 'MemorableKnowledge' AND properties->>'summary' LIKE $2`,
      [n.tenants.main, `%${canary}%`],
    );
    assert.equal(row.rowCount, 1, 'the scratch note became one memory');
    const gone = await pool!.query('SELECT 1 FROM memory_files WHERE virtual_path = $1', [reaperPath]);
    assert.equal(gone.rowCount, 0, 'promoted scratch leaves memory_files');
    await assertOracleBounds(n, row.rows[0]!.external_id, mkShape(canary, [], 'atlas'));
  });

  it('owner removal narrows access and writes a shrink row', async (t) => {
    const n = world();
    if (!n) return t.skip('no test database');
    const mk = n.seeded.world.byStore['memorable-knowledge'].find(
      (x) => x.tenant === 'main' && x.visibility === 'private' && x.owners !== 'absent' &&
        x.owners.length === 2 && x.owners.includes('alice') && x.owners.includes('bob'),
    )!;
    const id = n.seeded.location.get(mk.canary)!;
    const graph = n.seeded.stores.main.graph;
    const actor = { actorOmadiaUserId: n.seeded.users.main.alice };
    assert.ok(await graph.getMemorableKnowledge(id, n.seeded.users.main.bob), 'bob reads it before');
    await guarded(n, 'owner removal', async () => {
      // Owners are stored in both id forms (seed.ts); remove both.
      await graph.removeOwner(id, n.seeded.users.main.bob, actor);
      await graph.removeOwner(id, USERS.bob, actor);
    });
    assert.equal(await graph.getMemorableKnowledge(id, n.seeded.users.main.bob), null, 'bob no longer reads it');
    const audit = await graph.listMemoryAclAudit(id);
    assert.equal(audit.filter((a) => a.action === 'shrink').length, 2);
  });
});
