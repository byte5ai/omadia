import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createRuntimeRouter } from '../src/routes/runtime.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

/**
 * Theme D: post-install credential editing via
 * GET /installed/:id/secrets and PATCH /installed/:id/secrets.
 * The vault namespace per pluginId is shared across users in the
 * current architecture; the route therefore only checks installation
 * status, not per-user ACL (see route docstring).
 */

interface Harness {
  server: Server;
  baseUrl: string;
  vault: InMemorySecretVault;
  registry: InMemoryInstalledRegistry;
  close(): Promise<void>;
}

interface HarnessOpts {
  wireVault?: boolean;
  /** When provided, the harness wires a stub catalog whose `get('de.byte5.agent.test')`
   *  returns a manifest declaring these setup fields. Mirrors the install-time
   *  schema-driven secret-vs-config split. Other plugin IDs return undefined. */
  setupFields?: Array<{
    key: string;
    type: 'secret' | 'oauth' | 'string' | 'url' | 'enum' | 'boolean' | 'integer';
  }>;
  /** Initial registry config — simulates non-secret values seeded at install time. */
  initialConfig?: Record<string, unknown>;
}

async function makeHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const wireVault = opts.wireVault ?? true;
  const vault = new InMemorySecretVault();
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: 'de.byte5.agent.test',
    installed_version: '0.1.0',
    installed_at: new Date().toISOString(),
    status: 'active',
    config: opts.initialConfig ?? {},
  });

  let catalog: PluginCatalog | undefined;
  if (opts.setupFields) {
    const fields = opts.setupFields;
    const stubEntry: PluginCatalogEntry = {
      plugin: {
        id: 'de.byte5.agent.test',
        name: 'Test Agent',
        version: '0.1.0',
      } as never,
      manifest: { setup: { fields } },
      source_path: '<test>',
      source_kind: 'manifest-v1',
    };
    catalog = {
      get: (id: string): PluginCatalogEntry | undefined =>
        id === 'de.byte5.agent.test' ? stubEntry : undefined,
    } as unknown as PluginCatalog;
  }

  const app: Express = express();
  app.use(express.json());
  // Stub-out the registries that this route needs as a TYPE shape but
  // doesn't exercise (we test only the secrets endpoints).
  const stubReg = {
    names: () => [],
    counts: () => ({ before_turn: 0, after_tool_call: 0, after_turn: 0 }),
  };
  const router = createRuntimeRouter({
    installedRegistry: registry,
    serviceRegistry: stubReg as never,
    turnHookRegistry: stubReg as never,
    backgroundJobRegistry: stubReg as never,
    chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
    promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
    ...(wireVault ? { vault } : {}),
    ...(catalog ? { catalog } : {}),
  });
  app.use('/api/v1/admin/runtime', router);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    vault,
    registry,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('runtime secrets route — GET /installed/:id/secrets', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('returns sorted key list (no values)', async () => {
    h = await makeHarness();
    await h.vault.setMany('de.byte5.agent.test', {
      zeta: 'should-not-leak',
      alpha: 'should-not-leak',
      mu: 'should-not-leak',
    });
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { keys: string[] };
    assert.deepEqual(body.keys, ['alpha', 'mu', 'zeta']);
    assert.ok(!JSON.stringify(body).includes('should-not-leak'));
  });

  it('returns 404 when the agent is not installed', async () => {
    h = await makeHarness();
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.unknown/secrets`,
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'runtime.not_installed');
  });

  it('returns 503 when the route was wired without a vault', async () => {
    h = await makeHarness({ wireVault: false });
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'runtime.vault_unavailable');
  });
});

describe('runtime secrets route — PATCH /installed/:id/secrets', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('upserts new keys via `set` and returns the post-update key list', async () => {
    h = await makeHarness();
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          set: { api_key: 'k1', refresh_token: 't1' },
        }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { keys: string[] };
    assert.deepEqual(body.keys, ['api_key', 'refresh_token']);
    // Vault should hold the actual values.
    const stored = await h.vault.listKeys('de.byte5.agent.test');
    assert.deepEqual(stored.sort(), ['api_key', 'refresh_token']);
  });

  it('removes keys via `delete`', async () => {
    h = await makeHarness();
    await h.vault.setMany('de.byte5.agent.test', {
      keep: 'k',
      remove_me: 'r',
    });
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: ['remove_me'] }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { keys: string[] };
    assert.deepEqual(body.keys, ['keep']);
  });

  it('combines set + delete in a single patch', async () => {
    h = await makeHarness();
    await h.vault.setMany('de.byte5.agent.test', { old_key: 'o' });
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          set: { new_key: 'n' },
          delete: ['old_key'],
        }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { keys: string[] };
    assert.deepEqual(body.keys, ['new_key']);
  });

  it('returns 400 on empty patch body', async () => {
    h = await makeHarness();
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'runtime.empty_secrets_patch');
  });

  it('rejects non-string secret values with 400', async () => {
    h = await makeHarness();
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ set: { api_key: 42 } }),
      },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'runtime.invalid_secrets_body');
  });

  it('rejects non-array `delete` with 400', async () => {
    h = await makeHarness();
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: 'just_one' }),
      },
    );
    assert.equal(res.status, 400);
  });

  it('returns 404 when patching secrets for an uninstalled agent', async () => {
    h = await makeHarness();
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.unknown/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ set: { k: 'v' } }),
      },
    );
    assert.equal(res.status, 404);
  });
});

describe('runtime secrets route — schema-driven secret/config split', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('GET surfaces existing config keys (initial install seeded into registry)', async () => {
    h = await makeHarness({
      setupFields: [
        { key: 'tenant_id', type: 'string' },
        { key: 'app_id', type: 'string' },
        { key: 'app_password', type: 'secret' },
      ],
      initialConfig: { tenant_id: 't-123', app_id: 'a-456' },
    });
    await h.vault.setMany('de.byte5.agent.test', { app_password: 'shh' });
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      keys: string[];
      config_keys: string[];
      config_values: Record<string, string>;
    };
    // Vault keys (secrets/oauth)
    assert.deepEqual(body.keys, ['app_password']);
    // Registry config keys (everything else)
    assert.deepEqual(body.config_keys, ['app_id', 'tenant_id']);
    // Non-secret values are surfaced verbatim so the post-install editor
    // can render the current selection / prefill text inputs.
    assert.deepEqual(body.config_values, {
      tenant_id: 't-123',
      app_id: 'a-456',
    });
    // Secret values must still NOT leak — vault stays opaque.
    assert.ok(!JSON.stringify(body).includes('shh'));
  });

  it('PATCH routes secret-typed values to the vault and non-secret values to registry config', async () => {
    h = await makeHarness({
      setupFields: [
        { key: 'tenant_id', type: 'string' },
        { key: 'app_id', type: 'string' },
        { key: 'app_password', type: 'secret' },
      ],
    });
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          set: {
            tenant_id: 't-new',
            app_id: 'a-new',
            app_password: 'p-new',
          },
        }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      keys: string[];
      config_keys: string[];
      config_values: Record<string, string>;
    };
    assert.deepEqual(body.keys, ['app_password']);
    assert.deepEqual(body.config_keys, ['app_id', 'tenant_id']);
    assert.deepEqual(body.config_values, {
      tenant_id: 't-new',
      app_id: 'a-new',
    });
    // Vault holds only the secret
    const vaultKeys = await h.vault.listKeys('de.byte5.agent.test');
    assert.deepEqual(vaultKeys.sort(), ['app_password']);
    // Registry config holds the non-secret values verbatim
    const installed = h.registry.get('de.byte5.agent.test');
    assert.equal(installed?.config['tenant_id'], 't-new');
    assert.equal(installed?.config['app_id'], 'a-new');
  });

  it('PATCH delete removes vault entries vs config entries based on field type', async () => {
    h = await makeHarness({
      setupFields: [
        { key: 'tenant_id', type: 'string' },
        { key: 'app_password', type: 'secret' },
      ],
      initialConfig: { tenant_id: 't-old' },
    });
    await h.vault.setMany('de.byte5.agent.test', { app_password: 'p-old' });
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: ['tenant_id', 'app_password'] }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      keys: string[];
      config_keys: string[];
      config_values: Record<string, string>;
    };
    assert.deepEqual(body.keys, []);
    assert.deepEqual(body.config_keys, []);
    assert.deepEqual(body.config_values, {});
    const vaultKeys = await h.vault.listKeys('de.byte5.agent.test');
    assert.deepEqual(vaultKeys, []);
    const installed = h.registry.get('de.byte5.agent.test');
    assert.equal(installed?.config['tenant_id'], undefined);
  });

  it('PATCH config update merges into existing registry config (preserves untouched keys)', async () => {
    h = await makeHarness({
      setupFields: [
        { key: 'tenant_id', type: 'string' },
        { key: 'app_id', type: 'string' },
      ],
      initialConfig: { tenant_id: 't-keep', app_id: 'a-old' },
    });
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ set: { app_id: 'a-new' } }),
      },
    );
    assert.equal(res.status, 200);
    const installed = h.registry.get('de.byte5.agent.test');
    assert.equal(installed?.config['tenant_id'], 't-keep');
    assert.equal(installed?.config['app_id'], 'a-new');
  });

  it('falls back to vault-only when no catalog is wired (legacy behaviour)', async () => {
    // No `setupFields` → no catalog. Mirrors test wiring used by callers
    // that don't need schema-driven splits (existing harness tests).
    h = await makeHarness();
    const res = await fetch(
      `${h.baseUrl}/api/v1/admin/runtime/installed/de.byte5.agent.test/secrets`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          set: { tenant_id: 't', app_password: 'p' },
        }),
      },
    );
    assert.equal(res.status, 200);
    const vaultKeys = await h.vault.listKeys('de.byte5.agent.test');
    // Both keys land in the vault when the catalog is unavailable —
    // preserves the original Theme D behaviour for tests/dev wiring
    // without a manifest source.
    assert.deepEqual(vaultKeys.sort(), ['app_password', 'tenant_id']);
  });
});
