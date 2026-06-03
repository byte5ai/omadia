/**
 * `OrchestratorMemoryNamespacer` — the model-facing `memory` tool sees a
 * private `/memories` root physically backed by
 * `/memories/orchestrators/<slug>/`, while shared namespaces (core, sessions,
 * chat-sessions, brand `_*`) pass through untouched. `list` round-trips paths
 * back into the model's namespace.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemMemoryStore } from '@omadia/memory';

import { OrchestratorMemoryNamespacer } from '../packages/harness-orchestrator/src/orchestratorMemoryNamespacer.js';

async function ns(slug: string): Promise<{
  store: FilesystemMemoryStore;
  nsr: OrchestratorMemoryNamespacer;
}> {
  const store = new FilesystemMemoryStore(
    await mkdtemp(join(tmpdir(), 'omadia-nsr-')),
  );
  return { store, nsr: new OrchestratorMemoryNamespacer(slug, store) };
}

test('model /memories/<x> notes are physically privatized per orchestrator', async () => {
  const { store, nsr } = await ns('public');
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
  const { store, nsr } = await ns('public');
  await nsr.writeFile('/memories/core/rules.md', 'shared');
  await nsr.writeFile('/memories/_brand/logo.md', 'brand');
  // Physically NOT under the private tree.
  assert.equal(await store.readFile('/memories/core/rules.md'), 'shared');
  assert.equal(await store.readFile('/memories/_brand/logo.md'), 'brand');
});

test('list round-trips entries back into the model namespace', async () => {
  const { nsr } = await ns('public');
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
  const store = new FilesystemMemoryStore(
    await mkdtemp(join(tmpdir(), 'omadia-nsr-')),
  );
  const a = new OrchestratorMemoryNamespacer('a', store);
  const b = new OrchestratorMemoryNamespacer('b', store);
  await a.createFile('/memories/shared-name.md', 'from-a');
  await b.createFile('/memories/shared-name.md', 'from-b');
  assert.equal(await a.readFile('/memories/shared-name.md'), 'from-a');
  assert.equal(await b.readFile('/memories/shared-name.md'), 'from-b');
});
