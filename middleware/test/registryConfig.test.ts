import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import {
  VaultBackedRegistryConfigStore,
  InMemoryRegistrySettings,
  RegistryConfigError,
  seedRegistriesIfEmpty,
  DEFAULT_REGISTRY,
  REGISTRY_VAULT_OWNER,
  SETTING_REGISTRY_LIST,
  type RegistryConfigStore,
} from '../src/plugins/registryConfigStore.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';
import { RegistryClient } from '../src/plugins/registryClient.js';
import { createAdminRegistriesRouter } from '../src/routes/adminRegistries.js';

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

describe('seedRegistriesIfEmpty', () => {
  it('seeds the public default when empty and no env seed', async () => {
    const { store } = freshStore();
    await seedRegistriesIfEmpty(store, [], () => {});
    const list = await store.listPublic();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, DEFAULT_REGISTRY.name);
    assert.equal(list[0]!.url, DEFAULT_REGISTRY.url);
  });

  it('seeds from the env seed when provided', async () => {
    const { store } = freshStore();
    await seedRegistriesIfEmpty(
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
    await seedRegistriesIfEmpty(store, [], () => {});
    const list = await store.listPublic();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, 'existing');
  });
});

// --- admin router ----------------------------------------------------------

describe('createAdminRegistriesRouter', () => {
  let server: Server;
  let baseUrl: string;
  let store: RegistryConfigStore;
  let client: RegistryClient;

  before(() => {
    const settings = new InMemoryRegistrySettings();
    const vault = new InMemorySecretVault();
    store = new VaultBackedRegistryConfigStore({ settings, vault });
    client = new RegistryClient({ registries: [], log: () => {} });

    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/registries', createAdminRegistriesRouter({ store, client }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/admin/registries`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    // reset between cases
    for (const r of await store.listPublic()) await store.remove(r.name);
    client.setRegistries([]);
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

    const list = await (await fetch(baseUrl)).json();
    assert.deepEqual(list, {
      registries: [{ name: 'pub', url: 'https://hub.test', has_token: true }],
    });
    assert.ok(!JSON.stringify(list).includes('sek'), 'token must never be returned');
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
