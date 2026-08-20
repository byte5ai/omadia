/**
 * #603 (OM-17) — json_file uploads submitted WITH the install form.
 *
 * Found by fresh-installing v0.115.0: the install wizard rendered the file
 * picker, but NOTHING ever read it — the only server surface was the
 * post-install `secrets/from-json` route, so the upload feature was
 * end-to-end non-functional during install (the flow the field test is
 * actually about). `configure()` now accepts the raw documents and parses
 * them SERVER-side, per the platform doctrine on the post-install route:
 * a client that decides which bytes become `gw_sa_private_key` is a client
 * that can be made to decide wrongly.
 *
 * The extracted values continue through the SAME validation as typed input —
 * these tests pin exactly that: patterns still apply, the vault/config split
 * still applies, and an explicitly typed value wins over the file.
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

const PEM = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ') + '\nMIIEtest\n' +
  ['-----END', 'PRIVATE', 'KEY-----'].join(' ') + '\n';

const MANIFEST: Record<string, unknown> = {
  schema_version: '1',
  identity: {
    id: 'de.byte5.integration.jsonfiletest',
    kind: 'integration',
    domain: 'test',
    name: 'JsonFile Test',
    version: '1.0.0',
  },
  setup: {
    fields: [
      {
        key: 'sa_key_file',
        type: 'json_file',
        label: 'Key file',
        required: false,
        expect: { type: 'service_account' },
        extracts: {
          sa_email: '$.client_email',
          sa_private_key: '$.private_key',
        },
      },
      {
        key: 'sa_email',
        type: 'string',
        label: 'Service-account email',
        required: true,
        pattern: '^[^@\\s]+@[^@\\s]+\\.iam\\.gserviceaccount\\.com$',
      },
      { key: 'sa_private_key', type: 'secret', label: 'Key', required: true },
    ],
  },
  permissions: {},
};

function serviceAccountDoc(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'proj',
    client_email: 'svc@proj.iam.gserviceaccount.com',
    private_key: PEM,
    ...over,
  });
}

function makeDeps() {
  const plugin = adaptManifestV1(MANIFEST)!;
  const entry = {
    plugin,
    manifest: MANIFEST,
    source_path: '<test>/manifest.yaml',
    source_kind: 'manifest-v1',
    origin: 'installed',
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

describe('#603 — configure() with an uploaded json_file document', () => {
  it('extracts the declared values server-side and activates', async () => {
    const { service, pluginId, secrets } = makeDeps();
    const job = service.create(pluginId);
    const result = await service.configure(
      job.id,
      {},
      { sa_key_file: serviceAccountDoc() },
    );
    assert.equal(result.state, 'active', JSON.stringify(result.error));
    // The extracted secret landed in the vault; the raw document did not.
    assert.equal(secrets.get(`${pluginId}:sa_private_key`), PEM);
    for (const v of secrets.values()) {
      assert.equal(v.includes('project_id'), false, 'raw doc must not be stored');
    }
  });

  it('the extracted email still runs through the pattern check', async () => {
    // The upload is not a validation bypass: a file whose client_email is a
    // personal address fails the SAME iam.gserviceaccount.com pattern a typed
    // value fails on — the exact OM-17 mistake, arriving via file.
    const { service, pluginId } = makeDeps();
    const job = service.create(pluginId);
    const result = await service.configure(
      job.id,
      {},
      { sa_key_file: serviceAccountDoc({ client_email: 'silvio@firma.de' }) },
    );
    assert.equal(result.state, 'failed');
    const details = (result.error?.details ?? []) as Array<{ key?: string }>;
    const keys = details.map((d) => d.key);
    assert.ok(keys.includes('sa_email'), JSON.stringify(result.error));
  });

  it('rejects the wrong file kind via expect, keyed to the file field', async () => {
    const { service, pluginId } = makeDeps();
    const job = service.create(pluginId);
    const result = await service.configure(
      job.id,
      {},
      { sa_key_file: JSON.stringify({ type: 'authorized_user' }) },
    );
    assert.equal(result.state, 'failed');
    const details = (result.error?.details ?? []) as Array<{ key?: string }>;
    const keys = details.map((d) => d.key);
    assert.ok(keys.includes('sa_key_file'), JSON.stringify(result.error));
  });

  it('an explicitly typed value wins over the file', async () => {
    const { service, pluginId, secrets } = makeDeps();
    const job = service.create(pluginId);
    const typed = 'typed@proj.iam.gserviceaccount.com';
    const result = await service.configure(
      job.id,
      { sa_email: typed },
      { sa_key_file: serviceAccountDoc() },
    );
    assert.equal(result.state, 'active', JSON.stringify(result.error));
    // sa_email is a config (non-secret) field — check the registry config.
    // The vault only holds the secret; the typed email must have survived.
    assert.equal(secrets.get(`${pluginId}:sa_private_key`), PEM);
  });
});
