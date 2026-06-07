import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ExtensionStore } from '../../src/plugins/selfExtension/extensionStore.js';

describe('ExtensionStore', () => {
  let dir: string;
  let store: ExtensionStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'extstore-'));
    store = new ExtensionStore(path.join(dir, 'extensions.json'));
    await store.load();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds + lists per plugin', async () => {
    await store.add('p1', { templateId: 'odata.delta', params: { entitySet: 'salesorders' } });
    assert.equal(store.list('p1').length, 1);
    assert.equal(store.list('p2').length, 0);
    assert.equal(store.list('p1')[0]?.templateId, 'odata.delta');
  });

  it('dedupes identical template+params (order-independent)', async () => {
    const a = await store.add('p1', { templateId: 't', params: { x: 1, y: 2 } });
    const b = await store.add('p1', { templateId: 't', params: { y: 2, x: 1 } }); // same, reordered
    assert.equal(a, true);
    assert.equal(b, false);
    assert.equal(store.list('p1').length, 1);
  });

  it('keeps distinct params as separate extensions', async () => {
    await store.add('p1', { templateId: 't', params: { entitySet: 'a' } });
    await store.add('p1', { templateId: 't', params: { entitySet: 'b' } });
    assert.equal(store.list('p1').length, 2);
  });

  it('removeTemplate drops all of a template id', async () => {
    await store.add('p1', { templateId: 'delta', params: { entitySet: 'a' } });
    await store.add('p1', { templateId: 'delta', params: { entitySet: 'b' } });
    await store.add('p1', { templateId: 'count', params: {} });
    const removed = await store.removeTemplate('p1', 'delta');
    assert.equal(removed, 2);
    assert.equal(store.list('p1').length, 1);
    assert.equal(store.list('p1')[0]?.templateId, 'count');
  });

  it('persists across reload', async () => {
    await store.add('p1', { templateId: 'odata.delta', params: { entitySet: 'salesorders' } });
    const reloaded = new ExtensionStore(path.join(dir, 'extensions.json'));
    await reloaded.load();
    assert.equal(reloaded.list('p1').length, 1);
    assert.equal(reloaded.list('p1')[0]?.params['entitySet'], 'salesorders');
  });
});
