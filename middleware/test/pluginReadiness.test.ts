/**
 * OM-16 — `computeReadiness` must distinguish "installed" from "actually able
 * to serve a request".
 *
 * The customer bug: the Google-Workspace plugin reported "Installiert · AKTIV"
 * after every credential field had been emptied. `install_state` is a pure
 * registry-membership test and `InstalledAgent.status` only flips on the
 * activation circuit breaker, so neither noticed. These tests pin the derived
 * third view down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeReadiness } from '../src/plugins/readiness.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { InstalledAgent } from '../src/plugins/installedRegistry.js';
import type { Plugin, PluginSetupField } from '../src/api/admin-v1.js';

const PLUGIN_ID = 'de.byte5.integration.google-workspace';

function field(over: Partial<PluginSetupField> & { key: string }): PluginSetupField {
  return {
    label: over.key,
    type: 'string',
    ...over,
  } as PluginSetupField;
}

function plugin(fields: PluginSetupField[]): Pick<Plugin, 'id' | 'setup_fields'> {
  return { id: PLUGIN_ID, setup_fields: fields };
}

async function registryWith(entry: Partial<InstalledAgent>) {
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: PLUGIN_ID,
    installed_version: '1.0.0',
    installed_at: '2026-01-01T00:00:00.000Z',
    status: 'active',
    config: {},
    ...entry,
  });
  return registry;
}

/** Minimal structural vault: only `listKeys` is used, never a value read. */
function vaultWith(keys: string[]) {
  return { listKeys: async (): Promise<string[]> => keys };
}

test('a plugin absent from the installed registry is not_installed', async () => {
  const registry = new InMemoryInstalledRegistry();
  const r = await computeReadiness(
    plugin([field({ key: 'client_id' })]),
    registry,
    vaultWith([]),
  );
  assert.equal(r.state, 'not_installed');
  assert.deepEqual(r.missing_fields, []);
  assert.equal(r.verified_at, null);
});

test('all required values present → ready, with verified_at set', async () => {
  const registry = await registryWith({
    config: { client_id: 'abc' },
    last_activated_at: '2026-02-02T10:00:00.000Z',
  });
  const r = await computeReadiness(
    plugin([
      field({ key: 'client_id' }),
      field({ key: 'client_secret', type: 'secret' }),
    ]),
    registry,
    vaultWith(['client_secret']),
  );
  assert.equal(r.state, 'ready');
  assert.deepEqual(r.missing_fields, []);
  assert.equal(r.verified_at, '2026-02-02T10:00:00.000Z');
});

test('verified_at falls back to installed_at on a pre-OM-16 registry entry', async () => {
  const registry = await registryWith({ config: { client_id: 'abc' } });
  const r = await computeReadiness(
    plugin([field({ key: 'client_id' })]),
    registry,
    vaultWith([]),
  );
  assert.equal(r.state, 'ready');
  assert.equal(r.verified_at, '2026-01-01T00:00:00.000Z');
});

test('a required secret missing from the vault → config_required naming that key', async () => {
  const registry = await registryWith({ config: { client_id: 'abc' } });
  const r = await computeReadiness(
    plugin([
      field({ key: 'client_id' }),
      field({ key: 'client_secret', type: 'secret' }),
    ]),
    registry,
    vaultWith(['some_other_key']),
  );
  assert.equal(r.state, 'config_required');
  assert.deepEqual(r.missing_fields, ['client_secret']);
  assert.equal(r.verified_at, null);
});

test('a required config key present but EMPTY → config_required (the OM-16 repro)', async () => {
  // This is exactly what PATCH /runtime/installed/:id/secrets leaves behind:
  // the key survives, the value is "".
  const registry = await registryWith({ config: { client_id: '   ' } });
  const r = await computeReadiness(
    plugin([field({ key: 'client_id' })]),
    registry,
    vaultWith([]),
  );
  assert.equal(r.state, 'config_required');
  assert.deepEqual(r.missing_fields, ['client_id']);
});

test('status errored wins over a fully-configured plugin', async () => {
  const registry = await registryWith({
    status: 'errored',
    config: { client_id: 'abc' },
    last_activation_error: 'boot failed: ENOTFOUND',
  });
  const r = await computeReadiness(
    plugin([field({ key: 'client_id' })]),
    registry,
    vaultWith([]),
  );
  assert.equal(r.state, 'errored');
  assert.equal(r.error_detail, 'boot failed: ENOTFOUND');
  assert.deepEqual(r.missing_fields, []);
});

test('a required:false field left empty does NOT block readiness', async () => {
  const registry = await registryWith({ config: {} });
  const r = await computeReadiness(
    plugin([field({ key: 'optional_note', required: false })]),
    registry,
    vaultWith([]),
  );
  assert.equal(r.state, 'ready');
});

test('a required:false SECRET absent from the vault does NOT block readiness', async () => {
  const registry = await registryWith({ config: {} });
  const r = await computeReadiness(
    plugin([field({ key: 'optional_token', type: 'secret', required: false })]),
    registry,
    vaultWith([]),
  );
  assert.equal(r.state, 'ready');
  assert.deepEqual(r.missing_fields, []);
});

test('an omitted `required` still counts as required (required-by-default)', async () => {
  const registry = await registryWith({ config: {} });
  const r = await computeReadiness(
    plugin([field({ key: 'client_id' })]),
    registry,
    vaultWith([]),
  );
  assert.equal(r.state, 'config_required');
  assert.deepEqual(r.missing_fields, ['client_id']);
});

test('synthetic `_privacy_*` fields are never counted as missing', async () => {
  const registry = await registryWith({ config: {} });
  const r = await computeReadiness(
    plugin([
      field({ key: '_privacy_mode', type: 'enum' }),
      field({ key: '_privacy_bypass_scopes' }),
    ]),
    registry,
    vaultWith([]),
  );
  assert.equal(r.state, 'ready');
});

test('oauth fields are broker-owned and never counted as missing', async () => {
  const registry = await registryWith({ config: {} });
  const r = await computeReadiness(
    plugin([field({ key: 'google_oauth', type: 'oauth' })]),
    registry,
    vaultWith([]),
  );
  assert.equal(r.state, 'ready');
});

test('a throwing vault degrades to ready — it must never 500 the store', async () => {
  const registry = await registryWith({ config: { client_id: 'abc' } });
  const explodingVault = {
    listKeys: async (): Promise<string[]> => {
      throw new Error('vault sealed');
    },
  };
  const r = await computeReadiness(
    plugin([
      field({ key: 'client_id' }),
      field({ key: 'client_secret', type: 'secret' }),
    ]),
    registry,
    explodingVault,
  );
  assert.equal(r.state, 'ready');
  assert.deepEqual(r.missing_fields, []);
});

test('no vault wired at all → secret fields assumed satisfied, config still checked', async () => {
  const registry = await registryWith({ config: {} });
  const r = await computeReadiness(
    plugin([
      field({ key: 'client_secret', type: 'secret' }),
      field({ key: 'client_id' }),
    ]),
    registry,
    undefined,
  );
  assert.equal(r.state, 'config_required');
  assert.deepEqual(r.missing_fields, ['client_id']);
});
