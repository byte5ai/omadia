import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemMemoryStore } from '@omadia/memory/dist/filesystem.js';

import { previewMemoryPurge, purgeMemory } from '../src/services/memoryPurge.js';

// ---------------------------------------------------------------------------
// WS3 — Danger-Zone scratch purge helpers. Exercised against a real
// FilesystemMemoryStore in a mkdtemp so the list/delete semantics (recursive
// delete, two-levels-deep list) match production behaviour.
// ---------------------------------------------------------------------------

describe('memoryPurge (scratch helpers)', () => {
  let dir: string;
  let store: FilesystemMemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ws3-purge-'));
    store = new FilesystemMemoryStore(dir);
    await store.createFile('/memories/orchestrators/a/x.md', 'a-content');
    await store.createFile('/memories/orchestrators/b/y.md', 'b-content');
    await store.createFile('/memories/_rules/r.md', 'rule-content');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("axis 'agent' selector 'a' removes only a's subtree", async () => {
    const preview = await previewMemoryPurge(store, 'agent', 'a');
    assert.equal(preview, 1);

    const deleted = await purgeMemory(store, 'agent', 'a');
    assert.equal(deleted, 1);

    assert.equal(await store.fileExists('/memories/orchestrators/a/x.md'), false);
    assert.equal(await store.directoryExists('/memories/orchestrators/a'), false);
    // b + _rules untouched.
    assert.equal(await store.fileExists('/memories/orchestrators/b/y.md'), true);
    assert.equal(await store.fileExists('/memories/_rules/r.md'), true);
  });

  it("axis 'agent' refuses an empty selector", async () => {
    await assert.rejects(
      () => purgeMemory(store, 'agent', ''),
      (err: unknown) =>
        !!err && typeof err === 'object' && (err as { code?: string }).code === 'selector_required',
    );
  });

  it("axis 'all' without reseed removes agents but keeps _rules", async () => {
    const preview = await previewMemoryPurge(store, 'all');
    // orchestrators (parent of a + b) counts once; _rules protected.
    assert.equal(preview, 1);

    const deleted = await purgeMemory(store, 'all');
    assert.equal(deleted, 1);

    assert.equal(await store.fileExists('/memories/orchestrators/a/x.md'), false);
    assert.equal(await store.fileExists('/memories/orchestrators/b/y.md'), false);
    // Seed survives.
    assert.equal(await store.fileExists('/memories/_rules/r.md'), true);
  });

  it("axis 'all' with reseed removes _rules too", async () => {
    const preview = await previewMemoryPurge(store, 'all', undefined, { reseed: true });
    assert.equal(preview, 2); // orchestrators + _rules

    const deleted = await purgeMemory(store, 'all', undefined, { reseed: true });
    assert.equal(deleted, 2);

    assert.equal(await store.fileExists('/memories/orchestrators/a/x.md'), false);
    assert.equal(await store.fileExists('/memories/_rules/r.md'), false);
  });

  it("axis 'user' is a scratch no-op", async () => {
    const preview = await previewMemoryPurge(store, 'user', 'someone');
    assert.equal(preview, 0);

    const deleted = await purgeMemory(store, 'user', 'someone');
    assert.equal(deleted, 0);

    // Everything intact — user purge only touches the Knowledge-Graph.
    assert.equal(await store.fileExists('/memories/orchestrators/a/x.md'), true);
    assert.equal(await store.fileExists('/memories/orchestrators/b/y.md'), true);
    assert.equal(await store.fileExists('/memories/_rules/r.md'), true);
  });
});
