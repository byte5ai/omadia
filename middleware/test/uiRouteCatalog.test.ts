import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';

describe('UiRouteCatalog', () => {
  it('round-trips a descriptor with pluginId injected', () => {
    const cat = new UiRouteCatalog();
    cat.register('@plugin/x', {
      routeId: 'dashboard',
      path: '/dashboard',
      title: 'X Dashboard',
    });
    const list = cat.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.pluginId, '@plugin/x');
    assert.equal(list[0]?.routeId, 'dashboard');
    assert.equal(list[0]?.path, '/dashboard');
    assert.equal(list[0]?.title, 'X Dashboard');
  });

  it('sorts by (order asc, pluginId asc, routeId asc); defaults order=100', () => {
    const cat = new UiRouteCatalog();
    cat.register('@b/late', { routeId: 'z', path: '/z', title: 'Z', order: 50 });
    cat.register('@a/early', { routeId: 'a', path: '/a', title: 'A', order: 10 });
    cat.register('@a/early', { routeId: 'b', path: '/b', title: 'B', order: 10 });
    cat.register('@c/default', { routeId: 'd', path: '/d', title: 'D' }); // order=100
    const order = cat.list().map((r) => `${r.pluginId}:${r.routeId}`);
    assert.deepEqual(order, [
      '@a/early:a',
      '@a/early:b',
      '@b/late:z',
      '@c/default:d',
    ]);
  });

  it('re-registering the same (pluginId, routeId) throws', () => {
    const cat = new UiRouteCatalog();
    cat.register('@p/x', { routeId: 'r', path: '/r', title: 'T' });
    assert.throws(
      () => cat.register('@p/x', { routeId: 'r', path: '/r2', title: 'T2' }),
      /already registered/,
    );
  });

  it('dispose handle removes the entry; double-dispose is a no-op', () => {
    const cat = new UiRouteCatalog();
    const dispose = cat.register('@p/x', {
      routeId: 'r',
      path: '/r',
      title: 'T',
    });
    assert.equal(cat.size(), 1);
    dispose();
    assert.equal(cat.size(), 0);
    dispose(); // no throw
    assert.equal(cat.size(), 0);
  });

  it('stale dispose from previous registration does not unregister the new owner', () => {
    const cat = new UiRouteCatalog();
    const disposeA = cat.register('@p/x', {
      routeId: 'r',
      path: '/r',
      title: 'T-A',
    });
    disposeA();
    cat.register('@p/x', { routeId: 'r', path: '/r', title: 'T-B' });
    disposeA(); // stale closure — must be a no-op
    const list = cat.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.title, 'T-B');
  });

  it('disposeBySource drops every entry owned by that plugin', () => {
    const cat = new UiRouteCatalog();
    cat.register('@p/x', { routeId: 'a', path: '/a', title: 'A' });
    cat.register('@p/x', { routeId: 'b', path: '/b', title: 'B' });
    cat.register('@p/y', { routeId: 'c', path: '/c', title: 'C' });
    const dropped = cat.disposeBySource('@p/x');
    assert.equal(dropped, 2);
    assert.equal(cat.size(), 1);
    assert.equal(cat.list()[0]?.pluginId, '@p/y');
  });

  it('rejects empty pluginId, empty routeId, empty title, path without slash', () => {
    const cat = new UiRouteCatalog();
    assert.throws(
      () => cat.register('', { routeId: 'r', path: '/r', title: 'T' }),
      /pluginId/,
    );
    assert.throws(
      () => cat.register('@p/x', { routeId: '', path: '/r', title: 'T' }),
      /routeId/,
    );
    assert.throws(
      () => cat.register('@p/x', { routeId: 'r', path: 'r', title: 'T' }),
      /path must start with '\/'/,
    );
    assert.throws(
      () => cat.register('@p/x', { routeId: 'r', path: '/r', title: '' }),
      /title/,
    );
  });

  it('description is preserved when supplied, absent otherwise', () => {
    const cat = new UiRouteCatalog();
    cat.register('@p/x', {
      routeId: 'a',
      path: '/a',
      title: 'A',
      description: 'with desc',
    });
    cat.register('@p/x', { routeId: 'b', path: '/b', title: 'B' });
    const a = cat.list().find((r) => r.routeId === 'a');
    const b = cat.list().find((r) => r.routeId === 'b');
    assert.equal(a?.description, 'with desc');
    assert.equal(b?.description, undefined);
  });
});
