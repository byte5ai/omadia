import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { InMemoryMemoryStore } from '@omadia/memory';
import { memoryContextKey } from '@omadia/channel-sdk';

import { previewMemoryPurge, purgeMemory } from '../src/services/memoryPurge.js';

// ---------------------------------------------------------------------------
// WS3 — Danger-Zone scratch purge helpers. Exercised against an
// InMemoryMemoryStore so the list/delete semantics (recursive delete,
// two-levels-deep list) match production behaviour.
//
// Pollution guard (known full-suite bug): every store is built per-test in
// `beforeEach`. No module-level fixtures, nothing shared with another file.
// ---------------------------------------------------------------------------

/** The Teams team id used across the context cases — deliberately a REAL-shaped
 *  id with `:` and `@` in it, so the selector genuinely has to be normalised. */
const TEAM_NATIVE_ID = '19:team-alpha@thread.tacv2';
const TEAM_SELECTOR = `teams~${TEAM_NATIVE_ID}`;
const TEAM_KEY = memoryContextKey('teams', TEAM_NATIVE_ID);
const OTHER_TEAM_KEY = memoryContextKey('teams', '19:team-beta@thread.tacv2');

describe('memoryPurge (scratch helpers)', () => {
  let store: InMemoryMemoryStore;

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    await store.createFile('/memories/orchestrators/a/x.md', 'a-content');
    await store.createFile('/memories/orchestrators/b/y.md', 'b-content');
    await store.createFile('/memories/_rules/r.md', 'rule-content');
  });

  /** Seed the context forest: team ALPHA is shared by agents a + b, team BETA
   *  and a channel/user tree exist alongside it as the "must survive" control
   *  group. */
  async function seedContexts(): Promise<void> {
    await store.createFile(
      `/memories/contexts/a/team/${TEAM_KEY}/note.md`,
      'a-team-alpha',
    );
    await store.createFile(
      `/memories/contexts/b/team/${TEAM_KEY}/note.md`,
      'b-team-alpha',
    );
    await store.createFile(
      `/memories/contexts/a/team/${OTHER_TEAM_KEY}/note.md`,
      'a-team-beta',
    );
    await store.createFile(
      `/memories/contexts/a/channel/${TEAM_KEY}/note.md`,
      'a-channel-same-key',
    );
    await store.createFile(
      `/memories/contexts/a/user/teams~u-1/note.md`,
      'a-user',
    );
  }

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

  it("axis 'user' with no context forest at all deletes nothing", async () => {
    // No `/memories/contexts` exists in this fixture. `list` throws on a
    // missing directory, so this asserts the existence probe, not just a count.
    const preview = await previewMemoryPurge(store, 'user', 'teams~someone');
    assert.equal(preview, 0);

    const deleted = await purgeMemory(store, 'user', 'teams~someone');
    assert.equal(deleted, 0);

    assert.equal(await store.fileExists('/memories/orchestrators/a/x.md'), true);
    assert.equal(await store.fileExists('/memories/orchestrators/b/y.md'), true);
    assert.equal(await store.fileExists('/memories/_rules/r.md'), true);
  });

  // -------------------------------------------------------------------------
  // Chat-context axes (design §7 / test plan item 7). The isolation axis is
  // agent × context, so a context purge crosses agents and a context key is
  // never allowed to leak into a neighbouring axis or a neighbouring key.
  // -------------------------------------------------------------------------

  it("axis 'team' deletes the context tree across EVERY agent", async () => {
    await seedContexts();

    // Two agents hold team ALPHA → two targets, not one.
    const preview = await previewMemoryPurge(store, 'team', TEAM_SELECTOR);
    assert.equal(preview, 2);

    const deleted = await purgeMemory(store, 'team', TEAM_SELECTOR);
    assert.equal(deleted, 2, 'preview and execute agree by construction');

    assert.equal(
      await store.directoryExists(`/memories/contexts/a/team/${TEAM_KEY}`),
      false,
    );
    assert.equal(
      await store.directoryExists(`/memories/contexts/b/team/${TEAM_KEY}`),
      false,
    );

    // Neighbour key, neighbour axis, agent tree and seed all survive.
    assert.equal(
      await store.fileExists(
        `/memories/contexts/a/team/${OTHER_TEAM_KEY}/note.md`,
      ),
      true,
      'a different team is a different partition',
    );
    assert.equal(
      await store.fileExists(`/memories/contexts/a/channel/${TEAM_KEY}/note.md`),
      true,
      'the same key under a different axis is a different partition',
    );
    assert.equal(await store.fileExists('/memories/orchestrators/a/x.md'), true);
    assert.equal(await store.fileExists('/memories/_rules/r.md'), true);
  });

  it("axis 'team' resolves a raw native id and an already-derived ctxKey alike", async () => {
    await seedContexts();

    // A double-prefixed key is NOT the same partition — normalising is
    // injective, so a mistyped selector cannot land on someone else's tree.
    assert.equal(
      await previewMemoryPurge(store, 'team', `teams~${TEAM_KEY}`),
      0,
      'teams~teams~… is a different key, not a lenient match',
    );

    // The key an operator copies out of the memory browser round-trips:
    // `memoryContextKey` is idempotent on an already-safe id.
    assert.equal(await previewMemoryPurge(store, 'team', TEAM_KEY), 2);
    assert.equal(await previewMemoryPurge(store, 'team', TEAM_SELECTOR), 2);

    assert.equal(await purgeMemory(store, 'team', TEAM_KEY), 2);
    assert.equal(
      await store.directoryExists(`/memories/contexts/a/team/${TEAM_KEY}`),
      false,
    );
  });

  it("axis 'channel' and 'user' address their own axis only", async () => {
    await seedContexts();

    assert.equal(await purgeMemory(store, 'channel', TEAM_SELECTOR), 1);
    assert.equal(
      await store.fileExists(`/memories/contexts/a/team/${TEAM_KEY}/note.md`),
      true,
      "the team tree survives a channel purge with the same key",
    );

    assert.equal(await purgeMemory(store, 'user', 'teams~u-1'), 1);
    assert.equal(
      await store.directoryExists('/memories/contexts/a/user/teams~u-1'),
      false,
    );
  });

  it('context axes refuse an empty selector', async () => {
    await seedContexts();
    for (const axis of ['team', 'channel', 'user'] as const) {
      await assert.rejects(
        () => purgeMemory(store, axis, '   '),
        (err: unknown) =>
          !!err &&
          typeof err === 'object' &&
          (err as { code?: string }).code === 'selector_required',
        `${axis} must not purge on an empty selector`,
      );
    }
  });

  it("axis 'agent' takes the agent's whole context forest with it", async () => {
    await seedContexts();

    // /memories/orchestrators/a + /memories/contexts/a.
    const preview = await previewMemoryPurge(store, 'agent', 'a');
    assert.equal(preview, 2);
    assert.equal(await purgeMemory(store, 'agent', 'a'), 2);

    assert.equal(await store.directoryExists('/memories/contexts/a'), false);
    assert.equal(
      await store.directoryExists('/memories/orchestrators/a'),
      false,
    );
    // Agent b keeps both of its trees — including its half of team ALPHA.
    assert.equal(
      await store.fileExists(`/memories/contexts/b/team/${TEAM_KEY}/note.md`),
      true,
    );
    assert.equal(await store.fileExists('/memories/orchestrators/b/y.md'), true);
  });

  it("axis 'all' sweeps contexts up without naming it", async () => {
    await seedContexts();

    // orchestrators + contexts; _rules still protected.
    const preview = await previewMemoryPurge(store, 'all');
    assert.equal(preview, 2);
    assert.equal(await purgeMemory(store, 'all'), 2);

    assert.equal(await store.directoryExists('/memories/contexts'), false);
    assert.equal(await store.directoryExists('/memories/orchestrators'), false);
    assert.equal(await store.fileExists('/memories/_rules/r.md'), true);
  });
});
