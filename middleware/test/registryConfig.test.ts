import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import {
  VaultBackedRegistryConfigStore,
  InMemoryRegistrySettings,
  RegistryConfigError,
  seedRegistriesOnFirstBoot,
  DEFAULT_REGISTRY,
  REGISTRY_VAULT_OWNER,
  SETTING_REGISTRY_LIST,
  type RegistryConfigStore,
} from '../src/plugins/registryConfigStore.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';
import { RegistryClient } from '../src/plugins/registryClient.js';
import { createAdminRegistriesRouter } from '../src/routes/adminRegistries.js';
import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { registrySeedFromEnv } from '../src/config.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

function freshStore(): {
  store: VaultBackedRegistryConfigStore;
  settings: InMemoryRegistrySettings;
  vault: InMemorySecretVault;
} {
  const settings = new InMemoryRegistrySettings();
  const vault = new InMemorySecretVault();
  const store = new VaultBackedRegistryConfigStore({ settings, vault });
  return { store, settings, vault };
}

// --- store -----------------------------------------------------------------

describe('VaultBackedRegistryConfigStore', () => {
  it('adds a registry and lists it (no token)', async () => {
    const { store } = freshStore();
    await store.add({ name: 'pub', url: 'https://hub.test' });
    assert.deepEqual(await store.listPublic(), [
      { name: 'pub', url: 'https://hub.test', has_token: false },
    ]);
    assert.deepEqual(await store.list(), [{ name: 'pub', url: 'https://hub.test' }]);
  });

  it('stores a token in the vault, never in settings', async () => {
    const { store, settings, vault } = freshStore();
    await store.add({ name: 'priv', url: 'https://priv.test', token: 'sek' });

    // listPublic only flags presence
    assert.deepEqual(await store.listPublic(), [
      { name: 'priv', url: 'https://priv.test', has_token: true },
    ]);
    // list() resolves the token for the client
    assert.equal((await store.list())[0]!.token, 'sek');
    // the token lives in the vault under the synthetic owner
    assert.equal(await vault.get(REGISTRY_VAULT_OWNER, 'priv'), 'sek');
    // the persisted settings blob contains NO token
    const raw = await settings.get<unknown>(SETTING_REGISTRY_LIST);
    assert.ok(!JSON.stringify(raw).includes('sek'), 'token must not be in settings');
  });

  it('rejects duplicates, bad names and bad urls', async () => {
    const { store } = freshStore();
    await store.add({ name: 'pub', url: 'https://hub.test' });
    await assert.rejects(
      () => store.add({ name: 'pub', url: 'https://other.test' }),
      (e: unknown) => e instanceof RegistryConfigError && e.status === 409,
    );
    await assert.rejects(
      () => store.add({ name: 'bad name!', url: 'https://x.test' }),
      (e: unknown) => e instanceof RegistryConfigError && e.code === 'registry_config.invalid_name',
    );
    await assert.rejects(
      () => store.add({ name: 'ok', url: 'ftp://nope' }),
      (e: unknown) => e instanceof RegistryConfigError && e.code === 'registry_config.invalid_url',
    );
  });

  it('updates url and toggles the token', async () => {
    const { store, vault } = freshStore();
    await store.add({ name: 'r', url: 'https://a.test' });

    await store.update('r', { url: 'https://b.test' });
    assert.equal((await store.listPublic())[0]!.url, 'https://b.test');

    await store.update('r', { token: 'tok' });
    assert.equal((await store.listPublic())[0]!.has_token, true);
    assert.equal(await vault.get(REGISTRY_VAULT_OWNER, 'r'), 'tok');

    await store.update('r', { token: null });
    assert.equal((await store.listPublic())[0]!.has_token, false);
    assert.equal(await vault.get(REGISTRY_VAULT_OWNER, 'r'), undefined);
  });

  it('404s on update/remove of an unknown registry', async () => {
    const { store } = freshStore();
    await assert.rejects(
      () => store.update('ghost', { url: 'https://x.test' }),
      (e: unknown) => e instanceof RegistryConfigError && e.status === 404,
    );
    await assert.rejects(
      () => store.remove('ghost'),
      (e: unknown) => e instanceof RegistryConfigError && e.status === 404,
    );
  });

  it('removes a registry and its token', async () => {
    const { store, vault } = freshStore();
    await store.add({ name: 'r', url: 'https://a.test', token: 'tok' });
    await store.remove('r');
    assert.deepEqual(await store.listPublic(), []);
    assert.equal(await vault.get(REGISTRY_VAULT_OWNER, 'r'), undefined);
  });
});

// --- seeding ---------------------------------------------------------------

describe('seedRegistriesOnFirstBoot', () => {
  it('seeds the public default on first boot when REGISTRY_URLS is unset', async () => {
    const { store } = freshStore();
    await seedRegistriesOnFirstBoot(store, undefined, () => {});
    const list = await store.listPublic();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, DEFAULT_REGISTRY.name);
    assert.equal(list[0]!.url, DEFAULT_REGISTRY.url);
  });

  it('seeds from the env seed when provided', async () => {
    const { store } = freshStore();
    await seedRegistriesOnFirstBoot(
      store,
      [{ name: 'corp', url: 'https://corp.hub', token: 't' }],
      () => {},
    );
    const list = await store.listPublic();
    assert.deepEqual(list, [{ name: 'corp', url: 'https://corp.hub', has_token: true }]);
  });

  it('is a no-op when registries already exist', async () => {
    const { store } = freshStore();
    await store.add({ name: 'existing', url: 'https://x.test' });
    await seedRegistriesOnFirstBoot(store, undefined, () => {});
    const list = await store.listPublic();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, 'existing');
  });

  // #1483 — the seeder could not tell a first boot from a deliberate removal.
  it('does not re-seed a list the admin emptied', async () => {
    const { store } = freshStore();
    await seedRegistriesOnFirstBoot(store, undefined, () => {});
    await store.remove(DEFAULT_REGISTRY.name);
    // next boot
    await seedRegistriesOnFirstBoot(store, undefined, () => {});
    assert.deepEqual(await store.listPublic(), []);
  });

  it("REGISTRY_URLS='[]' starts without a registry, and stays so", async () => {
    const { store, settings } = freshStore();
    const seed = registrySeedFromEnv('[]', () => {});
    assert.deepEqual(seed, []);
    await seedRegistriesOnFirstBoot(store, seed, () => {});
    assert.deepEqual(await store.listPublic(), []);
    assert.deepEqual(await settings.get(SETTING_REGISTRY_LIST), []);
    // a later boot without the variable still does not seed the default
    await seedRegistriesOnFirstBoot(store, registrySeedFromEnv(undefined), () => {});
    assert.deepEqual(await store.listPublic(), []);
  });
});

describe('seedRegistriesOnFirstBoot · a failed seed', () => {
  it('leaves the list unwritten so the next boot retries', async () => {
    const { store } = freshStore();
    let fail = true;
    const flaky: RegistryConfigStore = {
      ...store,
      isInitialized: () => store.isInitialized(),
      markInitialized: () => store.markInitialized(),
      list: () => store.list(),
      listPublic: () => store.listPublic(),
      update: (n, p) => store.update(n, p),
      remove: (n) => store.remove(n),
      add: async (input) => {
        if (fail) throw new Error('vault unavailable');
        await store.add(input);
      },
    };
    const seed = [{ name: 'corp', url: 'https://corp.hub', token: 't' }];
    await seedRegistriesOnFirstBoot(flaky, seed, () => {});
    assert.equal(await store.isInitialized(), false);
    fail = false;
    await seedRegistriesOnFirstBoot(flaky, seed, () => {});
    assert.deepEqual(await store.listPublic(), [
      { name: 'corp', url: 'https://corp.hub', has_token: true },
    ]);
  });
});

describe('registrySeedFromEnv', () => {
  it('unset, blank or unusable → undefined (default hub)', () => {
    assert.equal(registrySeedFromEnv(undefined), undefined);
    assert.equal(registrySeedFromEnv('  '), undefined);
    assert.equal(registrySeedFromEnv('not json', () => {}), undefined);
    assert.equal(registrySeedFromEnv('{}', () => {}), undefined);
    assert.equal(registrySeedFromEnv('[{"name":"x"}]', () => {}), undefined);
  });

  it("'[]' → [] (no registry); a valid list → that list", () => {
    assert.deepEqual(registrySeedFromEnv('[]'), []);
    assert.deepEqual(
      registrySeedFromEnv('[{"name":"corp","url":"https://corp.hub"}]'),
      [{ name: 'corp', url: 'https://corp.hub' }],
    );
  });
});

// --- admin router ----------------------------------------------------------

describe('createAdminRegistriesRouter', () => {
  let server: Server;
  let baseUrl: string;
  let store: RegistryConfigStore;
  let client: RegistryClient;
  const audited: AuditEntryInput[] = [];

  before(async () => {
    const settings = new InMemoryRegistrySettings();
    const vault = new InMemorySecretVault();
    store = new VaultBackedRegistryConfigStore({ settings, vault });
    // No network: every registry index answers 404, so GET reports a status.
    client = new RegistryClient({
      registries: [],
      log: () => {},
      fetchImpl: async () => new Response('nope', { status: 404 }),
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = {
        uid: '11111111-2222-4333-8444-555555555555',
        email: 'admin@example.com',
      };
      next();
    });
    app.use(
      '/api/v1/admin/registries',
      createAdminRegistriesRouter({
        store,
        client,
        audit: { record: async (e) => void audited.push(e) },
      }),
    );
    server = await listenLoopback(app);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/admin/registries`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    // reset between cases
    for (const r of await store.listPublic()) await store.remove(r.name);
    client.setRegistries([]);
    audited.length = 0;
  });

  const post = (body: unknown) =>
    fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('POST adds and refreshes the live client; GET never leaks the token', async () => {
    const res = await post({ name: 'pub', url: 'https://hub.test', token: 'sek' });
    assert.equal(res.status, 201);
    // live client picked up the change (no restart)
    assert.deepEqual(client.registryNames(), ['pub']);

    const list = (await (await fetch(baseUrl)).json()) as {
      registries: Array<Record<string, unknown>>;
    };
    assert.equal(list.registries.length, 1);
    const { status, ...row } = list.registries[0]!;
    assert.deepEqual(row, { name: 'pub', url: 'https://hub.test', has_token: true });
    // #1482 — the last fetch outcome rides along with the row.
    assert.equal((status as { ok: boolean }).ok, false);
    assert.equal((status as { error: { code: string } }).error.code, 'registry.index_http');
    assert.ok(!JSON.stringify(list).includes('sek'), 'token must never be returned');
  });

  // #1487 — every mutation leaves an admin_audit row, never with the token.
  it('POST, PATCH and DELETE each write an audit row without the token', async () => {
    await post({ name: 'probe', url: 'https://hub.test', token: 'sek' });
    await fetch(`${baseUrl}/probe`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://hub.test/v2' }),
    });
    await fetch(`${baseUrl}/probe`, { method: 'DELETE' });

    const actor = {
      id: '11111111-2222-4333-8444-555555555555',
      email: 'admin@example.com',
    };
    assert.deepEqual(audited, [
      {
        actor,
        action: 'registry.create',
        target: 'registry:probe',
        after: { url: 'https://hub.test', has_token: true },
      },
      {
        actor,
        action: 'registry.update',
        target: 'registry:probe',
        before: { url: 'https://hub.test', has_token: true },
        after: { url: 'https://hub.test/v2', has_token: true },
      },
      {
        actor,
        action: 'registry.delete',
        target: 'registry:probe',
        before: { url: 'https://hub.test/v2', has_token: true },
      },
    ]);
    assert.ok(!JSON.stringify(audited).includes('sek'), 'token must never be audited');
  });

  it('a failing audit write does not fail the change', async () => {
    const settings = new InMemoryRegistrySettings();
    const vault = new InMemorySecretVault();
    const own = new VaultBackedRegistryConfigStore({ settings, vault });
    const app = express();
    app.use(express.json());
    app.use(
      '/r',
      createAdminRegistriesRouter({
        store: own,
        client: new RegistryClient({ registries: [], log: () => {} }),
        audit: {
          record: async () => {
            throw new Error('audit db down');
          },
        },
      }),
    );
    const srv = await listenLoopback(app);
    const errors = console.error;
    console.error = () => {};
    try {
      const res = await fetch(
        `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}/r`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'x', url: 'https://x.test' }),
        },
      );
      assert.equal(res.status, 201);
      assert.equal((await own.listPublic()).length, 1);
    } finally {
      console.error = errors;
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('a refused mutation writes no audit row', async () => {
    assert.equal((await post({ name: 'x' })).status, 400);
    assert.equal((await fetch(`${baseUrl}/ghost`, { method: 'DELETE' })).status, 404);
    assert.deepEqual(audited, []);
  });

  it('POST 400 on missing fields, 409 on duplicate', async () => {
    assert.equal((await post({ name: 'x' })).status, 400);
    assert.equal((await post({ name: 'x', url: 'https://x.test' })).status, 201);
    assert.equal((await post({ name: 'x', url: 'https://y.test' })).status, 409);
  });

  it('PATCH updates url, 404 unknown, 400 empty', async () => {
    await post({ name: 'r', url: 'https://a.test' });
    const ok = await fetch(`${baseUrl}/r`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://b.test' }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await store.listPublic())[0]!.url, 'https://b.test');

    const empty = await fetch(`${baseUrl}/r`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);

    const ghost = await fetch(`${baseUrl}/ghost`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://z.test' }),
    });
    assert.equal(ghost.status, 404);
  });

  it('DELETE removes and refreshes the client; 404 unknown', async () => {
    await post({ name: 'r', url: 'https://a.test' });
    assert.deepEqual(client.registryNames(), ['r']);
    const del = await fetch(`${baseUrl}/r`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(client.registryNames(), []);
    assert.equal((await fetch(`${baseUrl}/ghost`, { method: 'DELETE' })).status, 404);
  });
});
