/**
 * A registry entry whose package is gone is visited by no runtime (each walks
 * the packages it finds), so nothing ever reported it and it stayed `active`
 * for good. It is now named once per boot and reported by
 * `GET /admin/runtime/installed`, derived on every read: the registry is not
 * rewritten and nothing is removed.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';

import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { hasPackage, listPackagelessEntries, warnPackagelessEntries } from '../src/plugins/packagelessEntries.js';
import { createRuntimeRouter } from '../src/routes/runtime.js';

async function registryOf(
  entries: readonly { id: string; status: 'active' | 'inactive' | 'errored' }[],
): Promise<InMemoryInstalledRegistry> {
  const registry = new InMemoryInstalledRegistry();
  for (const entry of entries) {
    await registry.register({ ...entry, installed_version: '1.2.3', installed_at: '2026-11-01T00:00:00.000Z', config: {} });
  }
  return registry;
}

const store = (...ids: string[]): { has(id: string): boolean } => ({ has: (id) => ids.includes(id) });

describe('registry entries without a package', () => {
  it('a package in either store counts; a missing store does not', () => {
    assert.equal(hasPackage('a', [store('a'), store()]), true);
    assert.equal(hasPackage('a', [undefined, store('a')]), true);
    assert.equal(hasPackage('a', [store('b'), undefined]), false);
  });

  it('lists exactly the entries no store knows, with what the registry still says', async () => {
    const registry = await registryOf([
      { id: 'de.byte5.legacy', status: 'active' },
      { id: '@omadia/memory', status: 'active' },
      { id: 'canvas-core', status: 'errored' },
      { id: '@acme/uploaded', status: 'inactive' },
    ]);
    const before = JSON.stringify(registry.list());
    const found = listPackagelessEntries(registry, [store('@acme/uploaded'), store('@omadia/memory')]);
    assert.deepEqual(found, [
      { id: 'canvas-core', installed_version: '1.2.3', installed_at: '2026-11-01T00:00:00.000Z', registry_status: 'errored' },
      { id: 'de.byte5.legacy', installed_version: '1.2.3', installed_at: '2026-11-01T00:00:00.000Z', registry_status: 'active' },
    ]);
    assert.equal(JSON.stringify(registry.list()), before, 'the registry is not rewritten');
  });

  it('warns once, naming every entry, and says nothing when there is none', async () => {
    const registry = await registryOf([
      { id: 'de.byte5.legacy', status: 'active' },
      { id: 'ui-channel', status: 'active' },
      { id: '@omadia/memory', status: 'active' },
    ]);
    const warnings: string[] = [];
    const reported = warnPackagelessEntries(registry, [store('@omadia/memory')], (m) => warnings.push(m));
    assert.equal(reported.length, 2);
    assert.equal(warnings.length, 1, 'one line for the whole boot');
    assert.match(warnings[0]!, /2 installed entries have no package and are not running/);
    assert.match(warnings[0]!, /de\.byte5\.legacy@1\.2\.3 \(active\), ui-channel@1\.2\.3 \(active\)/);
    assert.match(warnings[0]!, /Nothing is removed automatically/);
    assert.ok(!warnings[0]!.includes('@omadia/memory'));

    const one: string[] = [];
    warnPackagelessEntries(registry, [store('@omadia/memory', 'ui-channel')], (m) => one.push(m));
    assert.match(one[0]!, /1 installed entry has no package and is not running/);

    const none: string[] = [];
    assert.deepEqual(warnPackagelessEntries(registry, [store('@omadia/memory', 'ui-channel', 'de.byte5.legacy')], (m) => none.push(m)), []);
    assert.deepEqual(none, []);
  });

  it('#1942: names omadia-ui-support for the canvas packages that left the core image', async () => {
    const registry = await registryOf([
      { id: '@omadia/ui-orchestrator', status: 'active' },
      { id: '@omadia/ui-channel', status: 'active' },
      { id: 'de.byte5.legacy', status: 'active' },
    ]);
    const warnings: string[] = [];
    warnPackagelessEntries(registry, [store()], (m) => warnings.push(m));
    assert.match(
      warnings[0]!,
      /@omadia\/ui-channel, @omadia\/ui-orchestrator ship outside the core image now: install from byte5ai\/omadia-ui-support\./,
    );
    assert.ok(!/de\.byte5\.legacy ships/.test(warnings[0]!), 'other entries get no relocation hint');

    const plain: string[] = [];
    warnPackagelessEntries(await registryOf([{ id: 'de.byte5.legacy', status: 'active' }]), [store()], (m) => plain.push(m));
    assert.ok(!plain[0]!.includes('omadia-ui-support'));
  });
});

describe('GET /admin/runtime/installed reports an entry without a package', () => {
  const serve = async (
    registry: InMemoryInstalledRegistry,
    hasPackageFor?: (id: string) => boolean,
  ): Promise<{ items: Record<string, unknown>[]; one(id: string): Promise<Record<string, unknown>>; close(): Promise<void> }> => {
    const stub = { names: () => [], counts: () => ({}) };
    const app = express();
    app.use(
      '/runtime',
      createRuntimeRouter({
        installedRegistry: registry,
        verifyConnection: () => Promise.resolve(undefined),
        serviceRegistry: stub as never,
        turnHookRegistry: stub as never,
        backgroundJobRegistry: stub as never,
        chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
        promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
        ...(hasPackageFor ? { hasPackage: hasPackageFor } : {}),
      }),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/runtime/installed`;
    const body = (await (await fetch(base)).json()) as { items: Record<string, unknown>[] };
    return {
      items: body.items,
      one: async (id) => (await (await fetch(`${base}/${encodeURIComponent(id)}`)).json()) as Record<string, unknown>,
      close: () => new Promise<void>((done) => server.close(() => done())),
    };
  };

  it('status package_missing, the stored status next to it, and the registry untouched', async () => {
    const registry = await registryOf([
      { id: 'de.byte5.legacy', status: 'active' },
      { id: '@omadia/memory', status: 'active' },
    ]);
    const served = await serve(registry, (id) => id === '@omadia/memory');
    try {
      const byId = new Map(served.items.map((row) => [row['id'], row]));
      assert.deepEqual(
        [byId.get('de.byte5.legacy')?.['status'], byId.get('de.byte5.legacy')?.['registry_status'], byId.get('de.byte5.legacy')?.['package_missing']],
        ['package_missing', 'active', true],
      );
      assert.deepEqual(
        [byId.get('@omadia/memory')?.['status'], byId.get('@omadia/memory')?.['registry_status'], byId.get('@omadia/memory')?.['package_missing']],
        ['active', 'active', false],
      );
      // The single-entry route gives the same answer as the list.
      const legacy = await served.one('de.byte5.legacy');
      assert.deepEqual([legacy['status'], legacy['registry_status'], legacy['package_missing']], ['package_missing', 'active', true]);
      const memory = await served.one('@omadia/memory');
      assert.deepEqual([memory['status'], memory['registry_status'], memory['package_missing']], ['active', 'active', false]);
      assert.equal(registry.get('de.byte5.legacy')?.status, 'active', 'derived, not written');
    } finally {
      await served.close();
    }
  });

  it('without knowledge of the packages every entry is reported as stored', async () => {
    const registry = await registryOf([{ id: 'de.byte5.legacy', status: 'active' }]);
    const served = await serve(registry);
    try {
      assert.equal(served.items[0]?.['status'], 'active');
      assert.equal(served.items[0]?.['package_missing'], false);
    } finally {
      await served.close();
    }
  });
});
