import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryPublishStore } from '../../packages/harness-publish/src/publishStore.js';

/**
 * Issue #581 — `PublishStore` invariants: every version is immutable once
 * created, and `setPointer` never touches the version rows.
 */
describe('InMemoryPublishStore.createVersion — immutability', () => {
  it('allocates version 1, then 2, then 3 for repeated publishes to the same app', async () => {
    const store = new InMemoryPublishStore();
    const v1 = await store.createVersion({
      appId: 'todo-app',
      name: 'Todo',
      entrypoint: 'server.js',
      dirHash: 'hash-a',
      sourceScopeKey: 'personal:x',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const v2 = await store.createVersion({
      appId: 'todo-app',
      name: 'Todo',
      entrypoint: 'server.js',
      dirHash: 'hash-b',
      sourceScopeKey: 'personal:x',
      now: new Date('2026-01-02T00:00:00Z'),
    });
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
  });

  it('a second app gets its own version sequence starting at 1', async () => {
    const store = new InMemoryPublishStore();
    await store.createVersion({
      appId: 'app-a',
      name: 'A',
      entrypoint: 'a.js',
      dirHash: 'h',
      sourceScopeKey: 's',
      now: new Date(),
    });
    const bFirst = await store.createVersion({
      appId: 'app-b',
      name: 'B',
      entrypoint: 'b.js',
      dirHash: 'h',
      sourceScopeKey: 's',
      now: new Date(),
    });
    assert.equal(bFirst.version, 1);
  });

  it('concurrent publishes to the same app never collide on a version number, and neither version is lost or overwritten', async () => {
    const store = new InMemoryPublishStore();
    const now = new Date();
    const [a, b] = await Promise.all([
      store.createVersion({
        appId: 'race-app',
        name: 'Race',
        entrypoint: 'a.js',
        dirHash: 'hash-a',
        sourceScopeKey: 's',
        now,
      }),
      store.createVersion({
        appId: 'race-app',
        name: 'Race',
        entrypoint: 'b.js',
        dirHash: 'hash-b',
        sourceScopeKey: 's',
        now,
      }),
    ]);
    assert.notEqual(a.version, b.version, 'concurrent publishes must not receive the same version number');

    const all = await store.listVersions('race-app');
    assert.equal(all.length, 2);
    const stored = new Map(all.map((v) => [v.version, v]));
    assert.equal(stored.get(a.version)!.dirHash, a.dirHash, "version a's content must be exactly what was published as version a");
    assert.equal(stored.get(b.version)!.dirHash, b.dirHash, "version b's content must be exactly what was published as version b");
  });

  it('PublishStore has no update/delete method — TypeScript proves this at compile time', () => {
    const store: import('../../packages/harness-publish/src/publishStore.js').PublishStore = new InMemoryPublishStore();
    // @ts-expect-error — updateVersion must not exist on the PublishStore contract
    assert.equal(typeof store.updateVersion, 'undefined');
    // @ts-expect-error — deleteVersion must not exist on the PublishStore contract
    assert.equal(typeof store.deleteVersion, 'undefined');
  });
});

describe('InMemoryPublishStore — pointer is the only mutable state', () => {
  it('setPointer does not appear in listVersions and does not change any version record', async () => {
    const store = new InMemoryPublishStore();
    const v1 = await store.createVersion({
      appId: 'app',
      name: 'App',
      entrypoint: 'x.js',
      dirHash: 'hash-1',
      sourceScopeKey: 's',
      now: new Date(),
    });
    await store.setPointer('app', v1.version, new Date());
    const versionAfter = await store.getVersion('app', v1.version);
    assert.deepEqual(versionAfter, v1, 'setPointer must never mutate a version record');
  });

  it('getPointer reflects the most recent setPointer call, and rollback (an earlier version) is a valid target', async () => {
    const store = new InMemoryPublishStore();
    await store.createVersion({ appId: 'app', name: 'App', entrypoint: 'x.js', dirHash: 'h1', sourceScopeKey: 's', now: new Date() });
    await store.createVersion({ appId: 'app', name: 'App', entrypoint: 'x.js', dirHash: 'h2', sourceScopeKey: 's', now: new Date() });
    await store.setPointer('app', 2, new Date());
    assert.equal((await store.getPointer('app'))!.currentVersion, 2);

    await store.setPointer('app', 1, new Date());
    assert.equal((await store.getPointer('app'))!.currentVersion, 1);
  });

  it('getPointer is undefined for an app that has never had a pointer set', async () => {
    const store = new InMemoryPublishStore();
    assert.equal(await store.getPointer('never-published'), undefined);
  });
});
