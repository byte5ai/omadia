import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import { PREVIEW_TOKEN_TTL_MS } from '../src/routes/memoryPurge.js';
import type { MemoryPurgeAuditStore } from '../src/services/memoryPurgeAudit.js';
import { seedConversationTurn, seedTeamsIdentity } from './_helpers/conversationFixture.js';
import {
  ADMIN_SESSION,
  TEAM_SELECTOR,
  TEAM_KEY,
  BOB,
  makeHarness,
  call,
  preview,
  previewAndPurge,
  codes,
  assertPreviewMatches,
  turnCount,
} from './_helpers/memoryPurgeHarness.js';

/**
 * HTTP integration test for the Danger-Zone memory-purge router
 * (`createMemoryPurgeRouter`, mounted in prod at
 * `/api/v1/admin/memory/purge`). Drives the REAL router end-to-end over an
 * express `listen(0)` server with a real `InMemoryMemoryStore` (scratch), a
 * real `InMemoryKnowledgeGraph` (MemorableKnowledge + conversation history).
 * The `memory_purge_audit` row on real Postgres is checked in
 * `memoryPurgeRoute.pg.test.ts`; the harness is `_helpers/memoryPurgeHarness.ts`.
 *
 * `requireAuth` is applied at MOUNT time in prod, not inside the router; the
 * harness stands in for it by putting a session on the request, because the
 * router records that session as the purge's actor (#1336).
 */

describe('memory-purge router (HTTP, end-to-end)', () => {
  describe('agent axis', () => {
    it('preview counts the agent trees, its MemorableKnowledge and its conversation history', async () => {
      const h = await makeHarness();
      try {
        const res = await preview(h, { axis: 'agent', selector: 'a' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        // Targets, not files: `/memories/orchestrators/a` + `/memories/contexts/a`.
        assert.equal(res.body['scratchCount'], 2);
        assert.equal(res.body['kgCount'], 1);
        // Two turns of agent a, 8 nodes each, plus their shared Session.
        assert.equal(res.body['conversationCount'], 17);
        assert.equal(typeof res.body['previewToken'], 'string');
        assert.equal(await h.store.fileExists('/memories/orchestrators/a/x.md'), true);
      } finally {
        await h.close();
      }
    });

    it('delete removes exactly the previewed nodes — turns included — and leaves agent b alone (#1334)', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);

        assert.equal(await turnCount(h.kg, 'a::teams::group'), 0, "a's turns are gone");
        assert.equal(await turnCount(h.kg, 'b::web::chat'), 1, "b's turns survive");
        assert.equal((await h.kg.countConversationHistory({ tenantId: 'default' })).count, 9);
        assert.equal(await h.store.directoryExists('/memories/contexts/a'), false);
        assert.equal(await h.store.fileExists(`/memories/contexts/b/team/${TEAM_KEY}/n.md`), true);
        assert.equal(await h.store.fileExists('/memories/orchestrators/b/y.md'), true);
        assert.equal(await h.store.fileExists('/memories/_rules/r.md'), true);
        assert.equal((await h.kg.countMemorableKnowledge({ tenantId: 'default', originAgent: 'b' })).count, 1);
        assert.equal((await h.kg.countMemorableKnowledge({ tenantId: 'default', originAgent: 'a' })).count, 0);

        const again = await preview(h, { axis: 'all' });
        assert.equal(again.body['conversationCount'], 9, 'the remaining history is still counted');
      } finally {
        await h.close();
      }
    });
  });

  describe('user axis', () => {
    it("an omadia user id removes that user's turns, keeps the other speaker's in the same chat", async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'user', selector: BOB });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);
        // Bob's two turns (8 nodes each) + the b session he alone spoke in.
        assert.equal(r.body['conversationDeleted'], 17);
        assert.equal(r.body['kgDeleted'], 1);

        assert.equal(await turnCount(h.kg, 'a::teams::group'), 1, "Alice's turn and the group session stay");
        assert.equal(await turnCount(h.kg, 'b::web::chat'), 0);
      } finally {
        await h.close();
      }
    });

    it("a Teams user's turns go although they store the AAD id, not the omadia id", async () => {
      const h = await makeHarness();
      try {
        const aad = '3c9d6a10-aaaa-4bbb-8ccc-0000000ca401';
        const carol = await seedTeamsIdentity(h.kg, aad);
        await seedConversationTurn(h.kg, {
          scope: 'a::teams::dm-carol',
          time: '2026-10-02T09:00:00Z',
          userId: aad,
          runUserId: carol,
          tag: 'carol',
        });
        const r = await previewAndPurge(h, { axis: 'user', selector: carol });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);
        assert.equal(r.body['conversationDeleted'], 9);
        assert.equal(await turnCount(h.kg, 'a::teams::dm-carol'), 0);
        assert.equal(await turnCount(h.kg, 'a::teams::group'), 2);
      } finally {
        await h.close();
      }
    });

    it('a context key purges the scratch tree and names the KG half that matched nothing', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'user', selector: 'teams~u-1' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body['scratchDeleted'], 1);
        assert.equal(r.body['kgDeleted'], 0);
        assert.equal(r.body['conversationDeleted'], 0);
        assert.deepEqual(codes(r.preview), ['user_axis_scratch_only', 'audit_unavailable']);
        assert.equal(await h.store.fileExists('/memories/contexts/a/user/teams~u-1/n.md'), false);
      } finally {
        await h.close();
      }
    });

    it('a selector without a channel type is refused with the explanation in `message`', async () => {
      const h = await makeHarness();
      try {
        for (const axis of ['team', 'channel', 'user'] as const) {
          const res = await preview(h, { axis, selector: 'Tom123' });
          assert.equal(res.status, 400, `${axis}: ${JSON.stringify(res.body)}`);
          assert.equal(res.body['error'], 'invalid_selector');
          assert.match(String(res.body['message']), /<channelType>~<id>/);
        }
      } finally {
        await h.close();
      }
    });
  });

  describe('team / channel axes', () => {
    it('warn with a translatable code that the KG is not modelled', async () => {
      const h = await makeHarness();
      try {
        const res = await preview(h, { axis: 'team', selector: TEAM_KEY });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body['scratchCount'], 2, 'one tree per agent');
        assert.equal(res.body['kgCount'], 0);
        assert.equal(res.body['conversationCount'], 0);
        assert.deepEqual(res.body['warnings'], [
          { code: 'kg_not_modelled', params: { axis: 'team' } },
          { code: 'audit_unavailable' },
        ]);
        assert.equal(res.body['warning'], undefined, 'no finished English sentence any more');
      } finally {
        await h.close();
      }
    });

    it('delete purges the context tree across agents and leaves the KG alone', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'team', selector: TEAM_SELECTOR });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);
        assert.equal(r.body['scratchDeleted'], 2);
        assert.equal(await h.store.directoryExists(`/memories/contexts/a/team/${TEAM_KEY}`), false);
        assert.equal(await h.store.directoryExists(`/memories/contexts/b/team/${TEAM_KEY}`), false);
        assert.equal(await h.store.fileExists('/memories/contexts/a/user/teams~u-1/n.md'), true);
        assert.equal((await h.kg.countMemorableKnowledge({ tenantId: 'default' })).count, 2);
      } finally {
        await h.close();
      }
    });
  });

  describe('everything axis', () => {
    it('removes scratch, MemorableKnowledge and all conversation history; protected entries stay', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'all' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);
        assert.equal(r.body['conversationDeleted'], 26);
        assert.equal((await h.kg.countConversationHistory({ tenantId: 'default' })).count, 0);
        assert.equal(await h.store.fileExists('/memories/orchestrators/a/x.md'), false);
        assert.equal(await h.store.directoryExists('/memories/contexts'), false);
        for (const kept of ['_rules/r.md', 'chat-sessions/u1/tabs.json', 'sessions/scope-1/log.md', 'ui-prefs/u1.json']) {
          assert.equal(await h.store.fileExists(`/memories/${kept}`), true, kept);
        }
      } finally {
        await h.close();
      }
    });

    it('re-seed resets the bundled entries, writes them back, and keeps user data (#1335)', async () => {
      const seedDir = await mkdtemp(path.join(tmpdir(), 'purge-route-seed-'));
      await mkdir(path.join(seedDir, '_rules'));
      await writeFile(path.join(seedDir, '_rules', 'smart-cards.md'), 'bundled rule');
      const h = await makeHarness({ seedDir });
      try {
        const plain = await preview(h, { axis: 'all' });
        const withReseed = await preview(h, { axis: 'all', reseed: true });
        assert.equal(
          withReseed.body['scratchCount'],
          Number(plain.body['scratchCount']) + 1,
          'the preview counts the re-seeded entry',
        );
        assert.deepEqual(withReseed.body['reseedEntries'], ['_rules']);

        const r = await previewAndPurge(h, { axis: 'all', reseed: true });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);
        assert.equal(r.body['reseededFiles'], 1);
        assert.equal(await h.store.fileExists('/memories/_rules/r.md'), false, 'runtime rule reset');
        assert.equal(await h.store.readFile('/memories/_rules/smart-cards.md'), 'bundled rule');
        for (const kept of [
          'chat-sessions/u1/tabs.json',
          'sessions/scope-1/log.md',
          '_brand/logo.md',
          'core/kernel.md',
          'ui-prefs/u1.json',
        ]) {
          assert.equal(await h.store.fileExists(`/memories/${kept}`), true, `${kept} survives a re-seed`);
        }
      } finally {
        await h.close();
        await rm(seedDir, { recursive: true, force: true });
      }
    });

    it('a preview without re-seed does not arm a re-seed delete', async () => {
      const h = await makeHarness({ seedDir: '/nonexistent' });
      try {
        const p = await preview(h, { axis: 'all' });
        const res = await call(h.baseUrl, 'DELETE', {
          axis: 'all',
          confirm: 'DELETE ALL MEMORY',
          reseed: true,
          previewToken: p.body['previewToken'],
        });
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(res.body['error'], 'preview_required');
      } finally {
        await h.close();
      }
    });
  });

  describe('safeguards (#1336)', () => {
    it('wrong confirmation → 400 confirmation_mismatch, nothing deleted', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' }, 'WRONG');
        assert.equal(r.status, 400);
        assert.equal(r.body['error'], 'confirmation_mismatch');
        assert.equal(await h.store.directoryExists('/memories/orchestrators/a'), true);
      } finally {
        await h.close();
      }
    });

    it('type-to-confirm guards the TYPED selector, not the derived ctxKey', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'team', selector: TEAM_SELECTOR }, TEAM_KEY);
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.equal(r.body['error'], 'confirmation_mismatch');
        assert.equal(await h.store.directoryExists(`/memories/contexts/a/team/${TEAM_KEY}`), true);
      } finally {
        await h.close();
      }
    });

    it('a delete without a preview is refused', async () => {
      const h = await makeHarness();
      try {
        const res = await call(h.baseUrl, 'DELETE', { axis: 'agent', selector: 'a', confirm: 'a' });
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(res.body['error'], 'preview_required');
        assert.equal(await h.store.directoryExists('/memories/orchestrators/a'), true);
      } finally {
        await h.close();
      }
    });

    it("a preview token only arms its own selection, once, and expires", async () => {
      let now = 1_000_000;
      const h = await makeHarness({ now: () => now });
      try {
        const pa = await preview(h, { axis: 'agent', selector: 'a' });
        const wrong = await call(h.baseUrl, 'DELETE', {
          axis: 'agent',
          selector: 'b',
          confirm: 'b',
          previewToken: pa.body['previewToken'],
        });
        assert.equal(wrong.status, 409, 'token for agent a does not arm agent b');

        const ok = await call(h.baseUrl, 'DELETE', {
          axis: 'agent',
          selector: 'a',
          confirm: 'a',
          previewToken: pa.body['previewToken'],
        });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        const reuse = await call(h.baseUrl, 'DELETE', {
          axis: 'agent',
          selector: 'a',
          confirm: 'a',
          previewToken: pa.body['previewToken'],
        });
        assert.equal(reuse.status, 409, 'single use');

        const pb = await preview(h, { axis: 'agent', selector: 'b' });
        now += PREVIEW_TOKEN_TTL_MS + 1;
        const late = await call(h.baseUrl, 'DELETE', {
          axis: 'agent',
          selector: 'b',
          confirm: 'b',
          previewToken: pb.body['previewToken'],
        });
        assert.equal(late.status, 409, 'expired');
        assert.equal(await h.store.directoryExists('/memories/orchestrators/b'), true);
      } finally {
        await h.close();
      }
    });

    it('without a session actor the purge is refused', async () => {
      const h = await makeHarness({}, null);
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 401, JSON.stringify(r.body));
        assert.equal(await h.store.directoryExists('/memories/orchestrators/a'), true);
      } finally {
        await h.close();
      }
    });

    it('a failed audit write refuses the purge before anything is deleted', async () => {
      const auditStore: MemoryPurgeAuditStore = {
        recordStart: () => Promise.reject(new Error('db down')),
        recordOutcome: () => Promise.resolve(),
      };
      const h = await makeHarness({ auditStore });
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 500, JSON.stringify(r.body));
        assert.equal(r.body['error'], 'audit_write_failed');
        assert.equal(await h.store.directoryExists('/memories/orchestrators/a'), true);
        assert.equal(await turnCount(h.kg, 'a::teams::group'), 2);
      } finally {
        await h.close();
      }
    });

    it('records the session actor and the outcome; a failed outcome write is reported', async () => {
      const starts: unknown[] = [];
      const outcomes: unknown[] = [];
      let failOutcome = false;
      const auditStore: MemoryPurgeAuditStore = {
        recordStart: (entry) => {
          starts.push(entry);
          return Promise.resolve('audit-1');
        },
        recordOutcome: (id, outcome) => {
          if (failOutcome) return Promise.reject(new Error('db down'));
          outcomes.push({ id, outcome });
          return Promise.resolve();
        },
      };
      const h = await makeHarness({ auditStore });
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body['auditId'], 'audit-1');
        assert.deepEqual(codes(r.body), []);
        assert.deepEqual(starts, [
          {
            actor: { id: ADMIN_SESSION.uid, email: ADMIN_SESSION.email },
            axis: 'agent',
            selector: 'a',
            reseed: false,
            planned: { scratch: 2, kg: 1, conversation: 17, kgDeowned: 0, kgExcerpts: 0, datasets: 0, processes: 0, identity: 0, reseedEntries: [] },
          },
        ]);
        assert.deepEqual(outcomes, [
          { id: 'audit-1', outcome: { status: 'completed', deleted: { scratch: 2, kg: 1, conversation: 17, kgDeowned: 0, kgExcerpts: 0, datasets: 0, processes: 0, identity: 0 } } },
        ]);

        failOutcome = true;
        const r2 = await previewAndPurge(h, { axis: 'agent', selector: 'b' });
        assert.equal(r2.status, 200, JSON.stringify(r2.body));
        assert.deepEqual(r2.body['warnings'], [
          { code: 'audit_update_failed', params: { auditId: 'audit-1' } },
        ]);
      } finally {
        await h.close();
      }
    });

    it('a KG provider without the history primitives is reported, not counted as empty', async () => {
      const h = await makeHarness();
      try {
        // A third-party provider that predates plugin-api 1.32.0.
        const kg = h.kg as unknown as Record<string, unknown>;
        kg['countConversationHistory'] = undefined;
        kg['purgeConversationHistory'] = undefined;
        const res = await preview(h, { axis: 'agent', selector: 'a' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body['conversationCount'], 0);
        assert.deepEqual(codes(res.body), ['kg_history_unsupported', 'audit_unavailable']);
      } finally {
        await h.close();
      }
    });

    it('a purge that fails part-way records what is already gone', async () => {
      const outcomes: unknown[] = [];
      const auditStore: MemoryPurgeAuditStore = {
        recordStart: () => Promise.resolve('audit-2'),
        recordOutcome: (_id, outcome) => {
          outcomes.push(outcome);
          return Promise.resolve();
        },
      };
      const h = await makeHarness({ auditStore });
      try {
        (h.kg as unknown as Record<string, unknown>)['purgeConversationHistory'] = () =>
          Promise.reject(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 500, JSON.stringify(r.body));
        assert.equal(r.body['error'], 'memory_purge_failed', 'a driver code is not surfaced');
        assert.deepEqual(outcomes, [
          {
            status: 'failed',
            deleted: { scratch: 2, kg: 1, conversation: 0, kgDeowned: 0, kgExcerpts: 0, datasets: 0, processes: 0, identity: 0 },
            error: 'connection reset',
          },
        ]);
      } finally {
        await h.close();
      }
    });

    it('without an audit store the response says the purge was not recorded', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(codes(r.body), ['audit_unavailable']);
        assert.equal(r.body['auditId'], undefined);
      } finally {
        await h.close();
      }
    });
  });
});
