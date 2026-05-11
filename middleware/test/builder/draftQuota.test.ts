import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import {
  DraftQuota,
  QuotaExceededError,
} from '../../src/plugins/builder/draftQuota.js';

describe('DraftQuota', () => {
  let tmp: string;
  let store: DraftStore;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'draft-quota-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (store) await store.close();
    const dbPath = join(
      tmp,
      `quota-${String(Date.now())}-${String(Math.random())}.db`,
    );
    store = new DraftStore({ dbPath });
    await store.open();
  });

  it('snapshot reports used, remaining, warning, exceeded correctly', async () => {
    const quota = new DraftQuota({ store, cap: 3, warnAt: 2 });

    let snap = await quota.snapshot('a@x');
    assert.equal(snap.used, 0);
    assert.equal(snap.remaining, 3);
    assert.equal(snap.warning, false);
    assert.equal(snap.exceeded, false);

    await store.create('a@x', 'one');
    snap = await quota.snapshot('a@x');
    assert.equal(snap.used, 1);
    assert.equal(snap.warning, false);

    await store.create('a@x', 'two');
    snap = await quota.snapshot('a@x');
    assert.equal(snap.used, 2);
    assert.equal(snap.warning, true, 'at warnAt → warning flag');
    assert.equal(snap.exceeded, false);

    await store.create('a@x', 'three');
    snap = await quota.snapshot('a@x');
    assert.equal(snap.used, 3);
    assert.equal(snap.remaining, 0);
    assert.equal(snap.exceeded, true);
  });

  it('assertCanCreate throws QuotaExceededError at cap', async () => {
    const quota = new DraftQuota({ store, cap: 1, warnAt: 1 });
    await store.create('a@x', 'one');

    await assert.rejects(
      () => quota.assertCanCreate('a@x'),
      (err: unknown) => {
        assert.ok(err instanceof QuotaExceededError);
        assert.equal(err.code, 'quota.exceeded');
        assert.equal(err.snapshot.used, 1);
        return true;
      },
    );
  });

  it('soft-deleted drafts do not count against the cap', async () => {
    const quota = new DraftQuota({ store, cap: 2, warnAt: 2 });
    const a = await store.create('a@x', 'one');
    await store.create('a@x', 'two');
    await store.softDelete('a@x', a.id);

    const snap = await quota.snapshot('a@x');
    assert.equal(snap.used, 1);
    assert.equal(snap.exceeded, false);
    await assert.doesNotReject(() => quota.assertCanCreate('a@x'));
  });

  it('rejects construction when warnAt > cap', () => {
    assert.throws(
      () => new DraftQuota({ store, cap: 3, warnAt: 4 }),
      /warnAt/,
    );
  });

  it('quotas are per-user', async () => {
    const quota = new DraftQuota({ store, cap: 1, warnAt: 1 });
    await store.create('a@x', 'one');
    await assert.rejects(() => quota.assertCanCreate('a@x'));
    await assert.doesNotReject(
      () => quota.assertCanCreate('b@x'),
      'bob has his own bucket',
    );
  });
});
