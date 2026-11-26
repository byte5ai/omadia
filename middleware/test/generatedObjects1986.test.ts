import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import express from 'express';

import {
  createGeneratedObjectsRegistry,
  InMemoryGeneratedObjectStore,
  type GeneratedObjectTurn,
} from '../src/services/generatedObjects.js';
import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { invoke } from './_helpers/httpInvoke.js';
import { makeHarness, previewAndPurge, preview, codes } from './_helpers/memoryPurgeHarness.js';

/**
 * #1986 (ADR-0187) — generated Office/Diagram files are recorded under the
 * producing turn's person and chat and deleted, refcounted, with the chat,
 * the person (memory purge, axis "User") and a full purge.
 */

const BEA = '3c0ffee0-1111-4222-8333-00000000beaa';
const ALI = '3c0ffee0-1111-4222-8333-0000000000a1';

function setup() {
  const store = new InMemoryGeneratedObjectStore();
  let turn: GeneratedObjectTurn | undefined;
  const registry = createGeneratedObjectsRegistry({ store: () => store, currentTurn: () => turn, log: () => {} });
  const deleted: string[] = [];
  registry.registerDeleter('@omadia/plugin-office', (key) => {
    deleted.push(key);
    return Promise.resolve();
  });
  const as = async (t: GeneratedObjectTurn, key: string): Promise<void> => {
    turn = t;
    await registry.record('@omadia/plugin-office', key);
    turn = undefined;
  };
  return { store, registry, deleted, as };
}

describe('#1986 · generated-object registry', () => {
  it('deletes a file once no chat or person references it', async () => {
    const { registry, deleted, as } = setup();
    await as({ ownerOmadiaUserId: BEA, scope: 'chat-1' }, 'documents/t/aaa/weg.xlsx');
    // The same bytes in Ali's chat: one object, two records.
    await as({ ownerOmadiaUserId: ALI, scope: 'chat-2' }, 'documents/t/aaa/weg.xlsx');
    await as({ ownerOmadiaUserId: BEA, scope: 'chat-1' }, 'documents/t/bbb/only-bea.docx');

    assert.deepEqual(await registry.count({ scope: 'chat-1', ownerOmadiaUserId: BEA }), { objects: 1, shared: 1 });
    const first = await registry.release({ scope: 'chat-1', ownerOmadiaUserId: BEA });
    assert.deepEqual(first, { deleted: 1, unreferenced: 1, pending: 0 });
    assert.deepEqual(deleted, ['documents/t/bbb/only-bea.docx']);

    const second = await registry.release({ ownerOmadiaUserId: ALI });
    assert.deepEqual(second, { deleted: 1, unreferenced: 0, pending: 0 });
    assert.deepEqual(deleted, ['documents/t/bbb/only-bea.docx', 'documents/t/aaa/weg.xlsx']);
  });

  it('keeps records pending when the producer is inactive or its delete fails', async () => {
    const store = new InMemoryGeneratedObjectStore();
    const registry = createGeneratedObjectsRegistry({
      store: () => store,
      currentTurn: () => ({ ownerOmadiaUserId: BEA, scope: 'c' }),
      log: () => {},
    });
    await registry.record('@omadia/diagrams', 't/abc.png');
    assert.deepEqual(await registry.release({ all: true }), { deleted: 0, unreferenced: 0, pending: 1 });
    const off = registry.registerDeleter('@omadia/diagrams', () => Promise.reject(new Error('bucket says no')));
    assert.deepEqual(await registry.release({ all: true }), { deleted: 0, unreferenced: 0, pending: 1 });
    off();
    registry.registerDeleter('@omadia/diagrams', () => Promise.resolve());
    assert.deepEqual(await registry.release({ all: true }), { deleted: 1, unreferenced: 0, pending: 0 });
    assert.deepEqual(await store.select({ all: true }), []);
  });

  it('refuses a second deleter for the same producer', () => {
    const { registry } = setup();
    assert.throws(() => registry.registerDeleter('@omadia/plugin-office', () => Promise.resolve()));
  });

  it('records outside a turn without person or chat; only a full purge reaches them', async () => {
    const { registry, deleted } = setup();
    await registry.record('@omadia/plugin-office', 'documents/t/ccc/x.xlsx');
    assert.equal((await registry.release({ ownerOmadiaUserId: BEA })).deleted, 0);
    assert.equal((await registry.release({ all: true })).deleted, 1);
    assert.deepEqual(deleted, ['documents/t/ccc/x.xlsx']);
  });
});

describe('#1986 · chat deletion releases its generated files', () => {
  it('releases the caller\'s records of that chat after the transcript is gone', async () => {
    const calls: Array<[string, string | undefined]> = [];
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = { omadia_user_id: BEA };
      next();
    });
    const store = { delete: () => Promise.resolve() };
    app.use(
      '/api/chat',
      createChatSessionsRouter({
        getStore: () => store as never,
        releaseGenerated: (scope, owner) => {
          calls.push([scope, owner]);
          return Promise.reject(new Error('bucket down'));
        },
      }),
    );
    const res = await invoke(app, 'DELETE', '/api/chat/sessions/chat-1');
    assert.equal(res.status, 200, 'a failed release never fails the delete');
    assert.deepEqual(calls, [['chat-1', BEA]]);
  });
});

describe('#1986 · memory purge releases generated files', () => {
  it('the user axis deletes the person\'s files; the preview counts them', async () => {
    const { registry, deleted, as } = setup();
    const h = await makeHarness({ generatedObjects: registry });
    try {
      const { omadiaUserId } = await h.kg.resolveOrCreateChannelIdentity({ channelKind: 'web', channelUserId: 'acc-bea' });
      await as({ ownerOmadiaUserId: omadiaUserId, scope: 'chat-1' }, 'documents/t/aaa/weg.xlsx');
      await as({ ownerOmadiaUserId: ALI, scope: 'chat-2' }, 'documents/t/ddd/ali.xlsx');
      const p = await preview(h, { axis: 'user', selector: omadiaUserId });
      assert.equal(p.body['generatedFileCount'], 1);
      const r = await previewAndPurge(h, { axis: 'user', selector: omadiaUserId });
      assert.equal(r.body['generatedFilesDeleted'], 1);
      assert.deepEqual(deleted, ['documents/t/aaa/weg.xlsx']);
    } finally {
      await h.close();
    }
  });

  it('axis all deletes every file and warns about pending ones', async () => {
    const store = new InMemoryGeneratedObjectStore();
    const registry = createGeneratedObjectsRegistry({ store: () => store, currentTurn: () => undefined, log: () => {} });
    await registry.record('@omadia/diagrams', 't/abc.png');
    const h = await makeHarness({ generatedObjects: registry });
    try {
      const r = await previewAndPurge(h, { axis: 'all' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body['generatedFilesDeleted'], 0);
      assert.ok(codes(r.body).includes('generated_files_pending'), 'no Diagrams deleter is registered');
    } finally {
      await h.close();
    }
  });
});
