import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';

describe('DraftStore', () => {
  let tmp: string;
  let dbPath: string;
  let store: DraftStore;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'draft-store-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (store) await store.close();
    dbPath = join(tmp, `drafts-${String(Date.now())}-${String(Math.random())}.db`);
    store = new DraftStore({ dbPath });
    await store.open();
  });

  it('creates a draft with default skeleton + default model', async () => {
    const draft = await store.create('alice@example.com', 'My Weather Agent');
    assert.equal(draft.name, 'My Weather Agent');
    assert.equal(draft.userEmail, 'alice@example.com');
    assert.equal(draft.status, 'draft');
    // 2026-05-06: codegen-default ist Opus 4.7, preview-default Sonnet 4.6
    // (Cost-Split — siehe modelRegistry.ts).
    assert.equal(draft.codegenModel, 'opus');
    assert.equal(draft.previewModel, 'sonnet');
    assert.equal(draft.installedAgentId, null);
    assert.deepEqual(draft.transcript, []);
    assert.deepEqual(draft.previewTranscript, []);
    assert.equal(draft.spec.version, '0.1.0');
  });

  it('falls back to "Neuer Agent" on blank names', async () => {
    const a = await store.create('alice@example.com', '');
    const b = await store.create('alice@example.com', '   ');
    assert.equal(a.name, 'Neuer Agent');
    assert.equal(b.name, 'Neuer Agent');
  });

  it('isolates drafts between users', async () => {
    const alice = await store.create('alice@example.com', 'A');
    const bob = await store.create('bob@example.com', 'B');

    assert.equal(
      await store.load('bob@example.com', alice.id),
      null,
      'bob must not read alice',
    );
    assert.equal(
      await store.load('alice@example.com', bob.id),
      null,
      'alice must not read bob',
    );

    const aliceList = await store.list('alice@example.com');
    assert.equal(aliceList.length, 1);
    assert.equal(aliceList[0]?.id, alice.id);
  });

  it('updates only provided fields and bumps updated_at', async () => {
    const draft = await store.create('a@x', 'Initial');
    const createdAt = draft.updatedAt;
    await new Promise((r) => setTimeout(r, 5));

    const patched = await store.update('a@x', draft.id, {
      name: 'Renamed',
      codegenModel: 'opus',
    });
    assert.ok(patched, 'patched draft should be returned');
    assert.equal(patched.name, 'Renamed');
    assert.equal(patched.codegenModel, 'opus');
    assert.equal(patched.previewModel, 'sonnet', 'untouched field stays');
    assert.ok(
      patched.updatedAt > createdAt,
      'updatedAt must advance on mutation',
    );
  });

  it('soft-delete hides drafts from list + load, restore brings them back', async () => {
    const draft = await store.create('a@x', 'Soft');
    const ok = await store.softDelete('a@x', draft.id);
    assert.equal(ok, true);

    assert.equal(await store.load('a@x', draft.id), null);
    assert.equal((await store.list('a@x')).length, 0);

    const deletedList = await store.list('a@x', { scope: 'deleted' });
    assert.equal(deletedList.length, 1);
    assert.equal(deletedList[0]?.id, draft.id);

    const restored = await store.restore('a@x', draft.id);
    assert.equal(restored, true);
    assert.ok(await store.load('a@x', draft.id));
  });

  it('update fails for soft-deleted drafts', async () => {
    const draft = await store.create('a@x', 'Soft');
    await store.softDelete('a@x', draft.id);
    const result = await store.update('a@x', draft.id, { name: 'Nope' });
    assert.equal(result, null);
  });

  it('count reflects active-only by default', async () => {
    await store.create('a@x', 'One');
    const two = await store.create('a@x', 'Two');
    await store.create('a@x', 'Three');
    await store.softDelete('a@x', two.id);

    assert.equal(await store.count('a@x'), 2);
    assert.equal(await store.count('a@x', { scope: 'all' }), 3);
  });

  it('list filter by status returns only matches', async () => {
    const a = await store.create('a@x', 'A');
    const b = await store.create('a@x', 'B');
    await store.update('a@x', a.id, {
      status: 'installed',
      installedAgentId: 'de.byte5.agent.weather',
    });

    const installed = await store.list('a@x', { status: 'installed' });
    assert.equal(installed.length, 1);
    assert.equal(installed[0]?.id, a.id);
    assert.equal(installed[0]?.installedAgentId, 'de.byte5.agent.weather');

    const drafts = await store.list('a@x', { status: 'draft' });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.id, b.id);
  });

  it('persists across open/close cycles', async () => {
    const draft = await store.create('a@x', 'Persisted');
    await store.close();

    const store2 = new DraftStore({ dbPath });
    await store2.open();
    const reloaded = await store2.load('a@x', draft.id);
    assert.ok(reloaded);
    assert.equal(reloaded.name, 'Persisted');
    await store2.close();

    store = new DraftStore({ dbPath });
    await store.open();
  });

  it('purgeInstalled hard-deletes soft-deleted installed drafts past grace', async () => {
    const storeShort = new DraftStore({
      dbPath: join(tmp, `purge-${String(Date.now())}.db`),
      installedPurgeGraceMs: 50,
    });
    await storeShort.open();

    const installed = await storeShort.create('a@x', 'inst');
    const draftRow = await storeShort.create('a@x', 'plain');
    await storeShort.update('a@x', installed.id, {
      status: 'installed',
      installedAgentId: 'de.byte5.agent.x',
    });

    await storeShort.softDelete('a@x', installed.id);
    await storeShort.softDelete('a@x', draftRow.id);

    // Under grace — nothing should purge
    const earlyCount = await storeShort.purgeInstalled();
    assert.equal(earlyCount, 0);

    await new Promise((r) => setTimeout(r, 80));

    const purged = await storeShort.purgeInstalled();
    assert.equal(purged, 1, 'exactly the installed+soft-deleted one purges');

    // Plain draft still there (never installed → never auto-purged)
    const leftover = await storeShort.list('a@x', { scope: 'deleted' });
    assert.equal(leftover.length, 1);
    assert.equal(leftover[0]?.id, draftRow.id);

    await storeShort.close();
  });

  it('findByInstalledAgentId returns the most recent matching active draft', async () => {
    const a = await store.create('alice@example.com', 'A');
    const b = await store.create('alice@example.com', 'B');
    await store.update('alice@example.com', a.id, {
      status: 'installed',
      installedAgentId: 'de.byte5.agent.foo',
    });
    // Same agent_id pinned to a SECOND draft (Edit-from-Store re-install
    // with a version bump produces this). updated_at on `b` is later, so
    // findByInstalledAgentId should return `b`.
    await new Promise((r) => setTimeout(r, 5));
    await store.update('alice@example.com', b.id, {
      status: 'installed',
      installedAgentId: 'de.byte5.agent.foo',
    });

    const hit = await store.findByInstalledAgentId(
      'alice@example.com',
      'de.byte5.agent.foo',
    );
    assert.ok(hit, 'expected a hit');
    assert.equal(hit.id, b.id, 'expected the most-recent draft');
    assert.equal(hit.installedAgentId, 'de.byte5.agent.foo');
  });

  it('findByInstalledAgentId returns null for foreign user (owner-scoped)', async () => {
    const draft = await store.create('alice@example.com', 'A');
    await store.update('alice@example.com', draft.id, {
      status: 'installed',
      installedAgentId: 'de.byte5.agent.foo',
    });
    const hit = await store.findByInstalledAgentId(
      'attacker@example.com',
      'de.byte5.agent.foo',
    );
    assert.equal(hit, null);
  });

  it('findByInstalledAgentId skips soft-deleted source drafts', async () => {
    const draft = await store.create('alice@example.com', 'A');
    await store.update('alice@example.com', draft.id, {
      status: 'installed',
      installedAgentId: 'de.byte5.agent.foo',
    });
    await store.softDelete('alice@example.com', draft.id);
    const hit = await store.findByInstalledAgentId(
      'alice@example.com',
      'de.byte5.agent.foo',
    );
    assert.equal(hit, null);
  });

  it('findByInstalledAgentId returns null when no draft has been installed', async () => {
    await store.create('alice@example.com', 'A');
    const hit = await store.findByInstalledAgentId(
      'alice@example.com',
      'de.byte5.agent.never-installed',
    );
    assert.equal(hit, null);
  });
});
