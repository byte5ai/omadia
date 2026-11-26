import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import express from 'express';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { InMemoryMemoryStore } from '@omadia/memory';

import type { AdminAuditLog, AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { createMemoryOwnerlessRouter } from '../src/routes/memoryOwnerless.js';
import { readRuleFiles } from '../src/services/durableRulesSync.js';
import { invoke } from './_helpers/httpInvoke.js';

/**
 * #1829 / #1831 (ADR-0185) — `/api/v1/admin/memory/ownerless`: an operator
 * lists and deletes memorable knowledge nobody owns; owned memory stays
 * out of reach, and the delete is audited first.
 */

const SESSION = {
  sub: 'admin@example.com',
  email: 'admin@example.com',
  uid: '5d2e7a90-2222-4333-8444-a55566667777',
  omadia_user_id: '0b6f2c1e-1111-4222-8333-944455556666',
};

function harness(opts: { session?: boolean; auditFails?: boolean } = {}) {
  const kg = new InMemoryKnowledgeGraph();
  const audits: AuditEntryInput[] = [];
  const adminAudit = {
    async record(entry: AuditEntryInput): Promise<void> {
      if (opts.auditFails) throw new Error('db down');
      audits.push(entry);
    },
  } as unknown as AdminAuditLog;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.session !== false) (req as unknown as { session: unknown }).session = SESSION;
    next();
  });
  app.use('/o', createMemoryOwnerlessRouter({ knowledgeGraph: kg, adminAudit }));
  return { kg, app, audits };
}

async function seed(kg: InMemoryKnowledgeGraph): Promise<{ ownerless: string; owned: string }> {
  const ownerless = await kg.createMemorableKnowledge({
    kind: 'reference',
    summary: 'seeded rule',
    rationale: 'source-memory-path: /memories/_rules/wetter.md\n\nSonnig',
    createdBy: 'system:rules-hook',
    aclOwners: [],
    manuallyAuthored: true,
  });
  const owned = await kg.createMemorableKnowledge({
    kind: 'insight',
    summary: 'mine',
    createdBy: 'user',
    aclOwners: [SESSION.omadia_user_id],
  });
  return { ownerless: ownerless.memorableKnowledgeNodeId, owned: owned.memorableKnowledgeNodeId };
}

describe('#1829 · owner-less memory admin route', () => {
  it('lists only owner-less entries, marking rules', async () => {
    const h = harness();
    const ids = await seed(h.kg);
    const res = await invoke(h.app, 'GET', '/o');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text) as { supported: boolean; items: Array<{ id: string; isRule: boolean }> };
    assert.equal(body.supported, true);
    assert.deepEqual(body.items.map((i) => [i.id, i.isRule]), [[ids.ownerless, true]]);
  });

  it('deletes an owner-less entry after writing the audit row', async () => {
    const h = harness();
    const ids = await seed(h.kg);
    const res = await invoke(h.app, 'DELETE', `/o/${encodeURIComponent(ids.ownerless)}`, { json: { reason: 'stale rule' } });
    assert.equal(res.status, 204, res.text);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0]!.action, 'memory.ownerless_delete');
    assert.deepEqual(h.audits[0]!.actor, { id: SESSION.uid, email: SESSION.email });
    assert.equal((await h.kg.listOwnerlessMemorableKnowledge()).length, 0);
    const trail = await h.kg.listMemoryAclAudit(ids.ownerless);
    assert.equal(trail[0]?.actorOmadiaUserId, SESSION.omadia_user_id);
    assert.equal(trail[0]?.reason, 'stale rule');
  });

  it('refuses an owned entry with 409 and a missing one with 404', async () => {
    const h = harness();
    const ids = await seed(h.kg);
    assert.equal((await invoke(h.app, 'DELETE', `/o/${encodeURIComponent(ids.owned)}`)).status, 409);
    assert.notEqual(await h.kg.getMemorableKnowledge(ids.owned, SESSION.omadia_user_id), null);
    assert.equal((await invoke(h.app, 'DELETE', '/o/mk%3Anope')).status, 404);
  });

  it('does not delete when the audit row cannot be written, or without a session', async () => {
    const failing = harness({ auditFails: true });
    const ids = await seed(failing.kg);
    assert.equal((await invoke(failing.app, 'DELETE', `/o/${encodeURIComponent(ids.ownerless)}`)).status, 500);
    assert.equal((await failing.kg.listOwnerlessMemorableKnowledge()).length, 1);

    const anon = harness({ session: false });
    const ids2 = await seed(anon.kg);
    assert.equal((await invoke(anon.app, 'DELETE', `/o/${encodeURIComponent(ids2.ownerless)}`)).status, 401);
  });
});

describe('#1831 · readRuleFiles', () => {
  it('reads every file below /memories/_rules, nested ones too', async () => {
    const store = new InMemoryMemoryStore();
    await store.createFile('/memories/_rules/a.md', 'A');
    await store.createFile('/memories/_rules/deep/er/b.md', 'B');
    await store.createFile('/memories/core/x.md', 'not a rule');
    const files = (await readRuleFiles(store)).sort((x, y) => x.virtualPath.localeCompare(y.virtualPath));
    assert.deepEqual(files, [
      { virtualPath: '/memories/_rules/a.md', content: 'A' },
      { virtualPath: '/memories/_rules/deep/er/b.md', content: 'B' },
    ]);
    assert.deepEqual(await readRuleFiles(new InMemoryMemoryStore()), []);
  });
});
