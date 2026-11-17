/**
 * `OrchestratorMemoryNamespacer` — the model-facing `memory` tool sees a
 * private `/memories` root physically backed by
 * `/memories/orchestrators/<slug>/`, while shared namespaces (core, sessions,
 * chat-sessions, brand `_*`) pass through untouched. `list` round-trips paths
 * back into the model's namespace.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemoryStore } from '@omadia/memory';

import { OrchestratorMemoryNamespacer } from '../packages/harness-orchestrator/src/orchestratorMemoryNamespacer.js';

function ns(slug: string): {
  store: InMemoryMemoryStore;
  nsr: OrchestratorMemoryNamespacer;
} {
  const store = new InMemoryMemoryStore();
  return { store, nsr: new OrchestratorMemoryNamespacer(slug, store) };
}

test('model /memories/<x> notes are physically privatized per orchestrator', async () => {
  const { store, nsr } = ns('public');
  await nsr.createFile('/memories/notes.md', 'hi');
  assert.equal(
    await store.readFile('/memories/orchestrators/public/notes.md'),
    'hi',
  );
  // The model still addresses it at the un-namespaced path.
  assert.equal(await nsr.readFile('/memories/notes.md'), 'hi');
  assert.equal(await nsr.fileExists('/memories/notes.md'), true);
});

test('shared namespaces (core, sessions, chat-sessions, _brand) pass through', async () => {
  const { store, nsr } = ns('public');
  await nsr.writeFile('/memories/core/rules.md', 'shared');
  await nsr.writeFile('/memories/_brand/logo.md', 'brand');
  // Physically NOT under the private tree.
  assert.equal(await store.readFile('/memories/core/rules.md'), 'shared');
  assert.equal(await store.readFile('/memories/_brand/logo.md'), 'brand');
});

test('list round-trips entries back into the model namespace', async () => {
  const { nsr } = ns('public');
  await nsr.createFile('/memories/a.md', '1');
  await nsr.createFile('/memories/sub/b.md', '2');
  const entries = await nsr.list('/memories');
  const paths = entries.map((e) => e.virtualPath).sort();
  // The model only ever sees the `/memories` namespace — never the physical
  // `orchestrators/<slug>` prefix — and its files round-trip back out.
  assert.ok(paths.every((p) => p === '/memories' || p.startsWith('/memories/')));
  assert.ok(!paths.some((p) => p.includes('/orchestrators/')));
  assert.ok(paths.includes('/memories/a.md'));
  assert.ok(paths.includes('/memories/sub'));
});

test('two orchestrators do not collide at the same model path', async () => {
  const store = new InMemoryMemoryStore();
  const a = new OrchestratorMemoryNamespacer('a', store);
  const b = new OrchestratorMemoryNamespacer('b', store);
  await a.createFile('/memories/shared-name.md', 'from-a');
  await b.createFile('/memories/shared-name.md', 'from-b');
  assert.equal(await a.readFile('/memories/shared-name.md'), 'from-a');
  assert.equal(await b.readFile('/memories/shared-name.md'), 'from-b');
});

// #1828 — `delete /memories` reached the store as the agent's physical root,
// which the store's own root guard does not recognise, and wiped the tree
// including every plugin's `ctx.memory`.
async function seeded(): Promise<{ store: InMemoryMemoryStore; nsr: OrchestratorMemoryNamespacer }> {
  const { store, nsr } = ns('public');
  await nsr.createFile('/memories/notes/a.md', 'note');
  await store.createFile('/memories/orchestrators/public/plugins/p1/state.json', '{}');
  return { store, nsr };
}

async function assertTreeIntact(store: InMemoryMemoryStore): Promise<void> {
  assert.equal(await store.readFile('/memories/orchestrators/public/notes/a.md'), 'note');
  assert.equal(await store.readFile('/memories/orchestrators/public/plugins/p1/state.json'), '{}');
}

test('delete and rename of the /memories root are refused (#1828)', async () => {
  const { store, nsr } = await seeded();
  for (const root of ['/memories', '/memories/', '/memories//']) {
    await assert.rejects(nsr.delete(root), { name: 'MemoryInvalidPathError', message: /root/ });
  }
  await assert.rejects(nsr.rename('/memories', '/memories/old'), { name: 'MemoryInvalidPathError' });
  await assertTreeIntact(store);
});

test('plugin storage cannot be deleted or moved through the memory tool, without a shield (#1828)', async () => {
  const { store, nsr } = await seeded();
  await assert.rejects(nsr.delete('/memories/plugins'), { name: 'MemoryInvalidPathError', message: /plugin storage/ });
  await assert.rejects(nsr.delete('/memories/plugins/p1/state.json'), { name: 'MemoryInvalidPathError' });
  await assert.rejects(nsr.rename('/memories/plugins/p1', '/memories/moved'), { name: 'MemoryInvalidPathError' });
  await assert.rejects(nsr.rename('/memories/notes/a.md', '/memories/plugins/p1/a.md'), { name: 'MemoryInvalidPathError' });
  await assertTreeIntact(store);
  // Reading and writing plugin storage stay as before.
  assert.equal(await nsr.readFile('/memories/plugins/p1/state.json'), '{}');
  await nsr.writeFile('/memories/plugins/p1/state.json', '{"v":1}');
  // A folder that merely starts with "plugins" is an ordinary note folder.
  await nsr.createFile('/memories/plugins-notes/x.md', 'x');
  await nsr.delete('/memories/plugins-notes');
  // Ordinary notes and folders are still deleted and renamed.
  await nsr.rename('/memories/notes', '/memories/archive');
  await nsr.delete('/memories/archive');
  assert.equal(await store.fileExists('/memories/orchestrators/public/archive/a.md'), false);
});
