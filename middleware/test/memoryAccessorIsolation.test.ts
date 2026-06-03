/**
 * Per-orchestrator plugin-memory isolation (`createMemoryAccessor`).
 *
 * The SAME plugin invoked under two different Agents must write to two
 * disjoint trees (`/memories/orchestrators/<slug>/plugins/<pluginId>/`), so
 * Orchestrator A never sees Orchestrator B's plugin memory — even for a
 * plugin both Agents enable. Legacy `/memories/agents/<pluginId>/` data stays
 * readable for the default Agent only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemMemoryStore } from '@omadia/memory';

import { createMemoryAccessor } from '../src/platform/memoryAccessor.js';

async function freshStore(): Promise<FilesystemMemoryStore> {
  return new FilesystemMemoryStore(await mkdtemp(join(tmpdir(), 'omadia-acc-')));
}

test('same plugin under two Agents writes to disjoint trees', async () => {
  const store = await freshStore();
  let slug = 'agent-a';
  const acc = createMemoryAccessor({
    pluginId: 'p',
    store,
    resolveAgentSlug: () => slug,
  });

  await acc.writeFile('notes.md', 'A-secret');
  slug = 'agent-b';
  // Agent B does not see Agent A's note at the same relative path.
  assert.equal(await acc.exists('notes.md'), false);
  await acc.writeFile('notes.md', 'B-secret');

  // Physically disjoint.
  assert.equal(
    await store.readFile('/memories/orchestrators/agent-a/plugins/p/notes.md'),
    'A-secret',
  );
  assert.equal(
    await store.readFile('/memories/orchestrators/agent-b/plugins/p/notes.md'),
    'B-secret',
  );

  // Back to A — still sees only its own.
  slug = 'agent-a';
  assert.equal(await acc.readFile('notes.md'), 'A-secret');
});

test('legacy /memories/agents/<plugin>/ data is read-through for default only', async () => {
  const store = await freshStore();
  await store.writeFile('/memories/agents/p/old.md', 'legacy');

  let slug = 'default';
  const acc = createMemoryAccessor({
    pluginId: 'p',
    store,
    resolveAgentSlug: () => slug,
  });
  // Default Agent reads pre-isolation data.
  assert.equal(await acc.exists('old.md'), true);
  assert.equal(await acc.readFile('old.md'), 'legacy');

  // A non-default Agent does NOT get the legacy read-through.
  slug = 'agent-b';
  assert.equal(await acc.exists('old.md'), false);
  await assert.rejects(() => acc.readFile('old.md'));
});

test('outside a turn the accessor falls back to the default Agent tree', async () => {
  const store = await freshStore();
  const acc = createMemoryAccessor({
    pluginId: 'p',
    store,
    resolveAgentSlug: () => undefined, // no turn context
  });
  await acc.writeFile('boot.md', 'x');
  assert.equal(
    await store.readFile('/memories/orchestrators/default/plugins/p/boot.md'),
    'x',
  );
});
