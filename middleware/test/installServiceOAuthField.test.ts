/**
 * Spec 005 — configure() must ACCEPT a plugin that declares a `type:oauth`
 * setup field. The field carries no value at configure (the kernel OAuth
 * broker establishes the connection post-install and stores the token in the
 * vault under `oauth.<key>`), so the validator skips it rather than rejecting
 * with the old `unsupported_type` stub. Regression for the live-smoke blocker
 * where every broker plugin failed to install.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { InstallService } from '../src/plugins/installService.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { SecretVault } from '../src/secrets/vault.js';

const MANIFEST = {
  schema_version: '1',
  identity: {
    id: '@test/oauth-int',
    kind: 'integration',
    domain: 'test',
    name: 'OAuth Integration',
    version: '0.1.0',
  },
  setup: {
    fields: [
      { key: 'client_id', type: 'string', label: 'Client ID', required: true },
      { key: 'client_secret', type: 'secret', label: 'Secret', required: true },
      {
        key: 'connection',
        type: 'oauth',
        label: 'Connect',
        provider: 'x',
        scopes: ['a'],
        required: false,
        install_hidden: true,
      },
    ],
  },
  oauth_providers: [
    {
      id: 'x',
      authorize_url: 'https://idp.example/authorize',
      token_url: 'https://idp.example/token',
      token_auth_style: 'body_json',
      client_id_field: 'client_id',
      client_secret_field: 'client_secret',
    },
  ],
  permissions: {
    secrets: { runtime_write: true },
    network: { outbound: ['api.example'] },
  },
};

function makeDeps() {
  const plugin = adaptManifestV1(MANIFEST)!;
  const entry = {
    plugin,
    manifest: MANIFEST,
    source_path: '<test>/manifest.yaml',
    source_kind: 'manifest-v1',
  } as unknown as PluginCatalogEntry;
  const catalog = {
    get: (id: string) => (id === plugin.id ? entry : undefined),
    list: () => [entry],
  } as unknown as PluginCatalog;

  const config = new Map<string, Record<string, unknown>>();
  const installed = new Set<string>();
  const registry = {
    list: () => [],
    get: (id: string) =>
      installed.has(id) ? { id, config: config.get(id) ?? {} } : undefined,
    has: (id: string) => installed.has(id),
    register: async (e: { id: string; config?: Record<string, unknown> }) => {
      installed.add(e.id);
      config.set(e.id, e.config ?? {});
    },
    remove: async () => {},
    markActivationFailed: async () => {},
    markActivationSucceeded: async () => {},
    updateConfig: async (id: string, c: Record<string, unknown>) => {
      config.set(id, c);
    },
    updateVersion: async () => {},
  } as unknown as InstalledRegistry;

  const secrets = new Map<string, string>();
  const vault = {
    get: async (a: string, k: string) => secrets.get(`${a}:${k}`),
    set: async (a: string, k: string, v: string) => {
      secrets.set(`${a}:${k}`, v);
    },
    setMany: async (a: string, entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) secrets.set(`${a}:${k}`, v);
    },
    purge: async () => {},
  } as unknown as SecretVault;

  const service = new InstallService({
    catalog,
    registry,
    vault,
    onInstalled: async () => {},
  });
  return { service, pluginId: plugin.id, secrets };
}

describe('Spec 005 — configure with a type:oauth field', () => {
  it('installs without rejecting the oauth field (it is connected post-install)', async () => {
    const { service, pluginId, secrets } = makeDeps();
    const job = service.create(pluginId);
    // Operator supplies only the visible creds — NOT the hidden oauth field.
    const result = await service.configure(job.id, {
      client_id: 'cid-123',
      client_secret: 'sshh',
    });
    assert.equal(result.state, 'active', 'job should activate');
    assert.equal(result.error, null, 'no validation error');
    // The secret landed in the vault; the oauth field wrote nothing.
    assert.equal(secrets.get(`${pluginId}:client_secret`), 'sshh');
    assert.equal(secrets.has(`${pluginId}:connection`), false);
  });

  it('still flags a genuinely missing REQUIRED non-oauth field (and never the oauth field)', async () => {
    const { service, pluginId } = makeDeps();
    const job = service.create(pluginId);
    const result = await service.configure(job.id, { client_id: 'cid-123' }); // no client_secret
    assert.equal(result.state, 'failed');
    assert.equal(result.error?.code, 'install.validation_failed');
    const details = result.error?.details as
      | Array<{ key: string; code: string }>
      | undefined;
    assert.ok(
      details?.some((e) => e.key === 'client_secret' && e.code === 'required'),
      'client_secret is flagged required',
    );
    assert.ok(
      !details?.some((e) => e.key === 'connection'),
      'the oauth field is never flagged at configure',
    );
  });
});
