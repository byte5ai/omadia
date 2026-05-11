import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DraftStore } from '../src/plugins/builder/draftStore.js';
import { buildDraftStorageMirrorHook } from '../src/plugins/builder/draftStorageBridge.js';
import type { LiveProfileStorageService } from '../src/profileStorage/liveProfileStorageService.js';
import { emptyAgentSpec } from '../src/plugins/builder/types.js';

/**
 * Slice 2 of OB-83 — the `onUpdated` hook that mirrors builder draft
 * saves into `profile_agent_md`.
 *
 * The hook itself is a thin wrapper around `specToAgentMd` +
 * `LiveProfileStorageService.setAgentMd`; what we test here is the
 * integration with `DraftStore.update()`:
 *
 *   - Spec-touching update fires the hook.
 *   - Non-spec update (transcript only) does NOT fire the hook.
 *   - Hook failure is caught — `update()` still returns the saved draft.
 *   - When the bridge is built without `liveProfileStorage`, it
 *     produces `undefined` and the store stays hook-less (pass-through).
 */

interface MirrorCall {
  profileId: string;
  bytes: Buffer;
  updatedBy: string;
}

function makeStorageStub(opts: { fail?: boolean } = {}): {
  storage: LiveProfileStorageService;
  calls: MirrorCall[];
} {
  const calls: MirrorCall[] = [];
  const storage = {
    async setAgentMd(profileId: string, content: Buffer, updatedBy: string) {
      if (opts.fail) throw new Error('storage write blew up');
      calls.push({ profileId, bytes: content, updatedBy });
      return {
        content,
        sha256: 'stub',
        sizeBytes: content.byteLength,
        updatedAt: new Date(),
        updatedBy,
      };
    },
  } as unknown as LiveProfileStorageService;
  return { storage, calls };
}

describe('buildDraftStorageMirrorHook', () => {
  it('returns undefined when liveProfileStorage is missing', () => {
    const hook = buildDraftStorageMirrorHook({});
    assert.equal(hook, undefined);
  });

  it('returns a callable hook when storage is provided', () => {
    const { storage } = makeStorageStub();
    const hook = buildDraftStorageMirrorHook({ liveProfileStorage: storage });
    assert.equal(typeof hook, 'function');
  });
});

describe('DraftStore + onUpdated hook integration', () => {
  let tmpDir: string;
  let store: DraftStore;
  let calls: MirrorCall[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'draft-bridge-'));
    const stub = makeStorageStub();
    calls = stub.calls;
    const hook = buildDraftStorageMirrorHook({ liveProfileStorage: stub.storage });
    assert.ok(hook, 'hook must be defined for this test');
    store = new DraftStore({
      dbPath: join(tmpDir, 'drafts.db'),
      onUpdated: hook,
    });
    await store.open();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires the hook on spec-touching update', async () => {
    const draft = await store.create('op@example.com', 'Demo Bot');
    const updatedSpec = { ...emptyAgentSpec(), id: draft.id, name: 'Demo Bot', description: 'changed' };
    const updated = await store.update('op@example.com', draft.id, { spec: updatedSpec });
    assert.ok(updated);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.profileId, draft.id);
    assert.equal(calls[0]!.updatedBy, 'op@example.com');
    const text = calls[0]!.bytes.toString('utf8');
    assert.ok(text.startsWith('---\n'), 'mirrored bytes should be agent.md frontmatter');
    assert.ok(text.includes('description: changed'));
  });

  it('fires the hook on name-only update', async () => {
    const draft = await store.create('op@example.com', 'Demo Bot');
    await store.update('op@example.com', draft.id, { name: 'Renamed Bot' });
    assert.equal(calls.length, 1);
  });

  it('does NOT fire the hook for transcript-only updates', async () => {
    const draft = await store.create('op@example.com', 'Demo Bot');
    await store.update('op@example.com', draft.id, {
      transcript: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    });
    assert.equal(calls.length, 0);
  });

  it('does NOT fire the hook for empty patch', async () => {
    const draft = await store.create('op@example.com', 'Demo Bot');
    await store.update('op@example.com', draft.id, {});
    assert.equal(calls.length, 0);
  });
});

describe('DraftStore + failing hook', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'draft-bridge-fail-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('swallows hook failures so the user-visible update still returns the draft', async () => {
    const stub = makeStorageStub({ fail: true });
    const hook = buildDraftStorageMirrorHook({ liveProfileStorage: stub.storage });
    assert.ok(hook);
    const store = new DraftStore({ dbPath: join(tmpDir, 'drafts.db'), onUpdated: hook });
    await store.open();
    try {
      const draft = await store.create('op@example.com', 'Demo');
      const updated = await store.update('op@example.com', draft.id, {
        spec: { ...emptyAgentSpec(), id: draft.id, name: 'Demo' },
      });
      assert.ok(updated, 'update must succeed even when mirror throws');
      // Sanity: storage.setAgentMd attempted but rejected → no calls captured.
      assert.equal(stub.calls.length, 0);
    } finally {
      await store.close();
    }
  });
});
