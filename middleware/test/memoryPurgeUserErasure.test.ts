import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ProcessMemoryService } from '@omadia/plugin-api';

import { seedConversationTurn } from './_helpers/conversationFixture.js';
import {
  ALICE,
  codes,
  makeHarness,
  preview,
  previewAndPurge,
  type Harness,
} from './_helpers/memoryPurgeHarness.js';

/**
 * The memory purge, axis "User", as an erasure (#1840, #1842, #1843,
 * ADR-0186): the selector the admin UI shows finds the person, shared
 * memories stay for their other owners, and the person's datasets,
 * processes and identity nodes go with them.
 */

const ACCOUNT_ID = '3c0ffee0-1111-4222-8333-000000000b0b';

function fakeProcesses(owned: Record<string, number>): ProcessMemoryService & { purged: string[] } {
  const purged: string[] = [];
  return {
    purged,
    write: () => Promise.reject(new Error('unused')),
    edit: () => Promise.reject(new Error('unused')),
    query: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    history: () => Promise.resolve([]),
    countByCreator: (id) => Promise.resolve({ count: owned[id] ?? 0 }),
    purgeByCreator: (id) => {
      purged.push(id);
      return Promise.resolve({ deleted: owned[id] ?? 0 });
    },
  };
}

async function seedPerson(h: Harness): Promise<string> {
  const { omadiaUserId } = await h.kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: ACCOUNT_ID,
    displayName: 'Bea Beispiel',
    email: 'bea@example.com',
    emailVerified: true,
  });
  await h.kg.createMemorableKnowledge({
    kind: 'insight',
    summary: 'Bea alone',
    aclOwners: [omadiaUserId],
    createdBy: 'test',
    palaiaExcerpts: { texts: ['excerpt one', 'excerpt two'], source: 'hint' },
  });
  await h.kg.createMemorableKnowledge({
    kind: 'decision',
    summary: 'Project Dolphin starts in January.',
    aclOwners: [ALICE, omadiaUserId],
    createdBy: 'test',
  });
  await h.kg.ingestDataset({
    ownerOmadiaUserId: omadiaUserId,
    name: 'b-data',
    sourceFileName: 'b.csv',
    columns: [{ name: 'n', type: 'number' }],
    rows: [{ n: 1 }, { n: 2 }],
  });
  return omadiaUserId;
}

describe('memory purge, axis "User", as an erasure', () => {
  it('#1840 — the account id the admin UI shows resolves to the person', async () => {
    const processes = fakeProcesses({});
    const h = await makeHarness({ processMemory: () => processes });
    try {
      const person = await seedPerson(h);
      processes.countByCreator = (id) => Promise.resolve({ count: id === person ? 2 : 0 });
      const res = await preview(h, { axis: 'user', selector: ACCOUNT_ID });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body['resolvedUser'], { omadiaUserId: person, via: 'account_id' });
      assert.ok(codes(res.body).includes('user_selector_resolved'));
      assert.equal(res.body['kgCount'], 1, 'only the entry Bea owns alone is deleted');
      assert.equal(res.body['kgDeownedCount'], 1, 'the shared entry only loses Bea');
      assert.equal(res.body['kgExcerptCount'], 2);
      assert.equal(res.body['datasetCount'], 1);
      assert.equal(res.body['processCount'], 2);
      assert.equal(res.body['identityCount'], 2, 'User node + web ChannelIdentity');
    } finally {
      await h.close();
    }
  });

  it('#1842/#1843 — shared memory stays for its other owners; data and identity go', async () => {
    const processes = fakeProcesses({});
    const h = await makeHarness({ processMemory: () => processes });
    try {
      const person = await seedPerson(h);
      const r = await previewAndPurge(h, { axis: 'user', selector: person });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body['kgDeleted'], 1);
      assert.equal(r.body['kgDeowned'], 1);
      assert.equal(r.body['kgExcerptsDeleted'], 2);
      assert.equal(r.body['datasetsDeleted'], 1);
      assert.equal(r.body['identityDeleted'], 2);
      assert.deepEqual(processes.purged, [person]);

      // Alice still owns the seeded "A" and now the shared entry alone.
      const alice = await h.kg.countMemorableKnowledge({ tenantId: 'default', aclOwner: ALICE });
      assert.equal(alice.count, 2);
      assert.equal((await h.kg.listOwnerlessMemorableKnowledge()).length, 0, 'nothing became owner-less');
      const remaining = await h.kg.countMemorableKnowledge({ tenantId: 'default', aclOwner: person });
      assert.equal(remaining.count + (remaining.deowned ?? 0), 0, 'Bea owns nothing any more');
      assert.equal(await h.kg.listDatasets({ ownerOmadiaUserId: person }).then((d) => d.length), 0);
      assert.equal((await h.kg.countUserIdentity(person)).count, 0);
      assert.equal(await h.kg.findOmadiaUserIdByChannelIdentity('web', ACCOUNT_ID), null);
    } finally {
      await h.close();
    }
  });

  it('#2279 — memory a Teams turn promoted under the AAD object id goes with the person', async () => {
    const h = await makeHarness();
    try {
      const aad = 'aad0aad0-2279-4222-8333-000000002279';
      const { omadiaUserId: person } = await h.kg.resolveOrCreateChannelIdentity({
        channelKind: 'teams',
        channelUserId: '29:teams-bea',
        aadObjectId: aad,
        displayName: 'Bea Beispiel',
      });
      // Teams auto-promotion owns a memory by the raw channel id (the AAD id).
      const alone = await h.kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'Bea alone, from Teams',
        aclOwners: [aad],
        createdBy: 'test',
        palaiaExcerpts: { texts: ['teams excerpt'], source: 'hint' },
      });
      const shared = await h.kg.createMemorableKnowledge({
        kind: 'decision',
        summary: 'Teams room: Dolphin starts in January.',
        aclOwners: [ALICE, aad],
        createdBy: 'test',
      });
      const before = await preview(h, { axis: 'user', selector: person });
      assert.equal(before.status, 200, JSON.stringify(before.body));
      assert.equal(before.body['kgCount'], 1, 'the entry owned by the AAD id alone');
      assert.equal(before.body['kgDeownedCount'], 1);
      assert.equal(before.body['kgExcerptCount'], 1);

      const r = await previewAndPurge(h, { axis: 'user', selector: person });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body['kgDeleted'], 1);
      assert.equal(r.body['kgDeowned'], 1);
      assert.equal(r.body['kgExcerptsDeleted'], 1);
      assert.equal(await h.kg.getMemorableKnowledge(alone.memorableKnowledgeNodeId), null);
      const kept = await h.kg.getMemorableKnowledge(shared.memorableKnowledgeNodeId, ALICE);
      assert.deepEqual(kept?.props['acl_owners'], [ALICE], 'Alice keeps it, the AAD id is gone');
    } finally {
      await h.close();
    }
  });

  it('#1843 — a channel-only user is found by the "<channel>~<id>" selector', async () => {
    const h = await makeHarness();
    try {
      const { omadiaUserId } = await h.kg.resolveOrCreateChannelIdentity({
        channelKind: 'telegram',
        channelUserId: '4711',
        displayName: 'Tele Gram',
      });
      await seedConversationTurn(h.kg, {
        scope: 'fallback::telegram-4711',
        time: '2026-11-01T10:00:00Z',
        userId: 'telegram:4711',
        tag: 't1',
      });
      const res = await preview(h, { axis: 'user', selector: 'telegram~4711' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body['resolvedUser'], { omadiaUserId, via: 'channel_identity' });
      assert.ok((res.body['conversationCount'] as number) > 0, 'the channel turns are selected');
      assert.equal(res.body['identityCount'], 2);
      assert.ok(codes(res.body).includes('user_layers_unsupported'), 'no process store in this harness');
    } finally {
      await h.close();
    }
  });

  it('#1840 — a uuid nobody has is reported, not shown as "nothing to delete"', async () => {
    const h = await makeHarness();
    try {
      const res = await preview(h, { axis: 'user', selector: '9e9e9e9e-1111-4222-8333-444455556666' });
      assert.equal(res.status, 200);
      assert.ok(codes(res.body).includes('user_unknown'));
    } finally {
      await h.close();
    }
  });
});
