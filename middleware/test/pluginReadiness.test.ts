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
import type { ReadinessLlmProbe } from '../src/plugins/readiness.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { InstalledAgent } from '../src/plugins/installedRegistry.js';
import type { Plugin, PluginSetupField } from '../src/api/admin-v1.js';
import { resolvePluginLlmReadiness } from '../src/platform/pluginLlmReadiness.js';
import type { ProviderVerification } from '../src/platform/providerCredentialVerifier.js';

const PLUGIN_ID = 'de.byte5.integration.google-workspace';
const LLM_PLUGIN_ID = '@omadia/orchestrator';

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

function llmPlugin(
  fields: PluginSetupField[],
): Pick<Plugin, 'id' | 'setup_fields'> {
  return { id: LLM_PLUGIN_ID, setup_fields: fields };
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

async function llmRegistryWith(entry: Partial<InstalledAgent>) {
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: LLM_PLUGIN_ID,
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

function probeReturning(
  verdict: ProviderVerification | undefined,
): ReadinessLlmProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (pluginId) => {
      calls.push(pluginId);
      return verdict;
    },
  };
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

/**
 * #884 — a plugin can be installed and locally configured while still lacking a
 * working provider credential. The Hub must expose that separately from the
 * older install/config projections.
 */

test('an LLM plugin stays ready when the 4th computeReadiness argument is omitted', async () => {
  const registry = await llmRegistryWith({
    config: { workspace: 'acme' },
  });
  const r = await computeReadiness(
    llmPlugin([field({ key: 'workspace' })]),
    registry,
    vaultWith([]),
  );
  assert.equal(r.state, 'ready');
});

test('an LLM plugin with a provider verdict of no_key becomes awaiting_llm', async () => {
  const registry = await llmRegistryWith({ config: { workspace: 'acme' } });
  const r = await computeReadiness(
    llmPlugin([field({ key: 'workspace' })]),
    registry,
    vaultWith([]),
    probeReturning({ status: 'no_key' }),
  );
  assert.equal(r.state, 'awaiting_llm');
  assert.deepEqual(r.missing_fields, []);
  assert.equal(r.verified_at, null);
});

test('an LLM plugin with an unverified provider verdict becomes awaiting_llm', async () => {
  const registry = await llmRegistryWith({ config: { workspace: 'acme' } });
  const r = await computeReadiness(
    llmPlugin([field({ key: 'workspace' })]),
    registry,
    vaultWith([]),
    probeReturning({ status: 'unverified' }),
  );
  assert.equal(r.state, 'awaiting_llm');
});

test('an LLM plugin with an invalid provider verdict becomes awaiting_llm', async () => {
  const registry = await llmRegistryWith({ config: { workspace: 'acme' } });
  const r = await computeReadiness(
    llmPlugin([field({ key: 'workspace' })]),
    registry,
    vaultWith([]),
    // A stored key the provider rejects is exactly the state the operator was
    // being lied to about, so it must not read as ready.
    probeReturning({ status: 'invalid' }),
  );
  assert.equal(r.state, 'awaiting_llm');
});

test('a verified provider verdict keeps an LLM plugin ready and preserves verified_at', async () => {
  const registry = await llmRegistryWith({
    config: { workspace: 'acme' },
    last_activated_at: '2026-04-04T08:30:00.000Z',
  });
  const r = await computeReadiness(
    llmPlugin([field({ key: 'workspace' })]),
    registry,
    vaultWith([]),
    probeReturning({ status: 'verified', verifiedAt: '2026-04-03T00:00:00.000Z' }),
  );
  assert.equal(r.state, 'ready');
  assert.equal(r.verified_at, '2026-04-04T08:30:00.000Z');
});

test('the real LLM readiness resolver returns undefined for non-LLM plugins without touching deps', async () => {
  const registry = await registryWith({ config: { client_id: 'abc' } });
  const explodingVault = {
    get: async (): Promise<string | undefined> => {
      throw new Error('vault should not be touched');
    },
  };
  const explodingCatalog = {
    get: (): never => {
      throw new Error('catalog should not be touched');
    },
  };
  const r = await computeReadiness(
    plugin([field({ key: 'client_id' })]),
    registry,
    vaultWith([]),
    {
      resolve: (id, cfg) =>
        resolvePluginLlmReadiness(id, cfg, {
          vault: explodingVault,
          llmProviderCatalog: explodingCatalog,
        }),
    },
  );
  assert.equal(r.state, 'ready');
});

test('a throwing LLM readiness probe degrades to ready', async () => {
  const registry = await llmRegistryWith({ config: { workspace: 'acme' } });
  const r = await computeReadiness(
    llmPlugin([field({ key: 'workspace' })]),
    registry,
    vaultWith([]),
    {
      resolve: async (): Promise<ProviderVerification | undefined> => {
        throw new Error('probe failed');
      },
    },
  );
  assert.equal(r.state, 'ready');
});

test('config_required wins over awaiting_llm for an LLM plugin', async () => {
  const registry = await llmRegistryWith({ config: {} });
  const r = await computeReadiness(
    llmPlugin([field({ key: 'workspace' })]),
    registry,
    vaultWith([]),
    probeReturning({ status: 'no_key' }),
  );
  assert.equal(r.state, 'config_required');
  assert.deepEqual(r.missing_fields, ['workspace']);
});

test('errored wins over awaiting_llm for an LLM plugin', async () => {
  const registry = await llmRegistryWith({
    status: 'errored',
    config: { workspace: 'acme' },
    last_activation_error: 'activation failed',
  });
  const r = await computeReadiness(
    llmPlugin([field({ key: 'workspace' })]),
    registry,
    vaultWith([]),
    probeReturning({ status: 'no_key' }),
  );
  assert.equal(r.state, 'errored');
  assert.equal(r.error_detail, 'activation failed');
});

test('the LLM readiness probe is skipped for a not_installed plugin', async () => {
  const registry = new InMemoryInstalledRegistry();
  const probe = probeReturning({ status: 'no_key' });
  const r = await computeReadiness(
    llmPlugin([field({ key: 'workspace' })]),
    registry,
    vaultWith([]),
    probe,
  );
  assert.equal(r.state, 'not_installed');
  assert.deepEqual(probe.calls, []);
});
