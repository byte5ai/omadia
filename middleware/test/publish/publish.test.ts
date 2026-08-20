import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { publish, rollbackTo, type PublishRuntime } from '../../packages/harness-publish/src/publish.js';
import { InMemoryPublishStore } from '../../packages/harness-publish/src/publishStore.js';
import { PublishEntrypointNotFoundError, PublishVersionNotFoundError } from '../../packages/harness-publish/src/publishManifest.js';

function fakeSandbox(tree: Record<string, string>) {
  return {
    async list(relativePath: string) {
      const norm = relativePath === '.' || relativePath === '' ? '' : `${relativePath}/`;
      const names = new Set<string>();
      for (const p of Object.keys(tree)) {
        if (!p.startsWith(norm)) continue;
        const rest = p.slice(norm.length);
        names.add(rest.includes('/') ? rest.split('/')[0]! : rest);
      }
      if (names.size === 0) return { ok: false as const, reason: 'not_found' as const, detail: 'x' };
      return {
        ok: true as const,
        entries: Array.from(names).map((name) => ({
          name,
          kind: (Object.keys(tree).some((p) => p === `${norm}${name}`) ? 'file' : 'dir') as 'file' | 'dir',
        })),
      };
    },
    async read(relativePath: string) {
      const content = tree[relativePath];
      return content === undefined ? { ok: false as const, reason: 'not_found' as const, detail: 'x' } : { ok: true as const, content };
    },
  };
}

function spyRuntime(): PublishRuntime & { readonly deployCalls: unknown[] } {
  const deployCalls: unknown[] = [];
  return {
    deployCalls,
    async deploy(args) {
      deployCalls.push(args);
    },
  };
}

describe('publish()', () => {
  it('creates version 1 on first publish, deploys it, and points the app at it', async () => {
    const store = new InMemoryPublishStore();
    const runtime = spyRuntime();
    const record = await publish({
      sandbox: fakeSandbox({ 'server.js': 'listen()' }),
      store,
      runtime,
      input: { appId: 'todo', name: 'Todo', entrypoint: 'server.js', dir: '.', sourceScopeKey: 'personal:x' },
    });
    assert.equal(record.version, 1);
    assert.equal(runtime.deployCalls.length, 1);
    assert.equal((await store.getPointer('todo'))!.currentVersion, 1);
  });

  it('a second publish creates version 2 WITHOUT altering version 1s stored record', async () => {
    const store = new InMemoryPublishStore();
    const runtime = spyRuntime();
    const input = { appId: 'todo', name: 'Todo', entrypoint: 'server.js', dir: '.', sourceScopeKey: 'personal:x' };
    await publish({ sandbox: fakeSandbox({ 'server.js': 'v1' }), store, runtime, input });
    const v1Before = await store.getVersion('todo', 1);

    const record2 = await publish({ sandbox: fakeSandbox({ 'server.js': 'v2' }), store, runtime, input });
    assert.equal(record2.version, 2);

    const v1After = await store.getVersion('todo', 1);
    assert.deepEqual(v1After, v1Before, 'republishing must never mutate an earlier version');
    assert.equal((await store.getPointer('todo'))!.currentVersion, 2, 'the pointer moves to the new version');
  });

  it('throws PublishEntrypointNotFoundError when the entrypoint is not in the published tree, and never deploys or advances the pointer', async () => {
    const store = new InMemoryPublishStore();
    const runtime = spyRuntime();
    await assert.rejects(
      () =>
        publish({
          sandbox: fakeSandbox({ 'index.html': '<html></html>' }),
          store,
          runtime,
          input: { appId: 'todo', name: 'Todo', entrypoint: 'server.js', dir: '.', sourceScopeKey: 'personal:x' },
        }),
      PublishEntrypointNotFoundError,
    );
    assert.equal(runtime.deployCalls.length, 0);
    assert.equal(await store.getPointer('todo'), undefined);
  });
});

describe('rollbackTo() — pointer flip only', () => {
  it('rolling back to an earlier version does NOT call PublishRuntime.deploy again', async () => {
    const store = new InMemoryPublishStore();
    const runtime = spyRuntime();
    const input = { appId: 'todo', name: 'Todo', entrypoint: 'server.js', dir: '.', sourceScopeKey: 'personal:x' };
    await publish({ sandbox: fakeSandbox({ 'server.js': 'v1' }), store, runtime, input });
    await publish({ sandbox: fakeSandbox({ 'server.js': 'v2' }), store, runtime, input });
    assert.equal(runtime.deployCalls.length, 2);

    const pointer = await rollbackTo({ store, appId: 'todo', version: 1 });
    assert.equal(pointer.currentVersion, 1);
    assert.equal(runtime.deployCalls.length, 2, 'rollbackTo must trigger NO new build/deploy');
  });

  it('rejects a rollback to a version that was never published', async () => {
    const store = new InMemoryPublishStore();
    await store.createVersion({ appId: 'todo', name: 'Todo', entrypoint: 'x.js', dirHash: 'h', sourceScopeKey: 's', now: new Date() });
    await assert.rejects(() => rollbackTo({ store, appId: 'todo', version: 99 }), PublishVersionNotFoundError);
  });
});
