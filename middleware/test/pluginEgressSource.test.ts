/**
 * Spec 2042 §5.10 — what the plugin egress guard knows about the instance:
 * the effective permission resolves `$config.*` base URLs to their host, and
 * a local model server's host is not a model endpoint (it would cut every
 * plugin off loopback).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProviderCatalog } from '@omadia/llm-provider';

import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import { adaptManifestV1, type PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createPluginEgressSource } from '../src/platform/pluginEgressSource.js';

function entry(id: string, kind: string, outbound: string[], extra: Record<string, unknown> = {}) {
  const manifest = {
    schema_version: '1',
    identity: { id, name: id, version: '1.0.0', kind },
    permissions: { network: { outbound } },
    ...extra,
  };
  const plugin = adaptManifestV1(manifest, () => undefined);
  assert.ok(plugin, id);
  return { plugin, manifest, source_path: `/data/plugins/${id}/1.0.0/manifest.yaml`, source_kind: 'manifest-v1', origin: 'installed' };
}

const entries = [
  entry('@omadia/llm-ollama', 'model', ['localhost', '127.0.0.1', 'host.docker.internal', '$config.ollama_base_url']),
  entry('@omadia/llm-anthropic', 'extension', ['api.anthropic.com'], { llm_provider: { id: 'anthropic' } }),
  entry('@omadia/decision-jev', 'model', ['api.typesafe.ai', '$config.jev_base_url']),
  entry('@acme/crm', 'integration', ['$config.crm_url', 'static.example.com']),
];
const config: Record<string, Record<string, unknown>> = {
  '@omadia/llm-ollama': { ollama_base_url: 'http://10.0.0.7:11434' },
  '@omadia/decision-jev': { jev_base_url: 'https://gateway.example.net/v1' },
  '@acme/crm': { crm_url: 'https://crm.example.org/api, other.example.org' },
};

const source = createPluginEgressSource({
  catalog: {
    get: (id: string) => entries.find((e) => e.plugin.id === id),
    list: () => entries,
    isBundledId: () => false,
  } as unknown as PluginCatalog,
  installedRegistry: { get: (id: string) => ({ config: config[id] ?? {} }) } as unknown as InstalledRegistry,
  llmProviderCatalog: {
    list: () => [
      { id: 'anthropic', baseURL: 'https://api.anthropic.com' },
      { id: 'ollama', baseURL: 'http://localhost:11434' },
    ],
  } as unknown as LlmProviderCatalog,
});

describe('plugin egress source', () => {
  it('takes the host of a $config base URL into the permission', () => {
    assert.deepEqual(source.permissionOf('@acme/crm')?.hosts, ['crm.example.org', 'other.example.org', 'static.example.com']);
    assert.equal(source.permissionOf('@acme/crm')?.isModelPlugin, false);
  });

  it('knows model plugins by kind and by an llm_provider block', () => {
    assert.equal(source.permissionOf('@omadia/llm-ollama')?.isModelPlugin, true);
    assert.equal(source.permissionOf('@omadia/llm-anthropic')?.isModelPlugin, true);
    assert.equal(source.permissionOf('@omadia/decision-jev')?.isModelPlugin, true);
  });

  it('lists public model endpoints, never local or private ones', () => {
    const hosts = [...source.modelProviderHosts()].sort();
    assert.deepEqual(hosts, ['api.anthropic.com', 'api.typesafe.ai', 'gateway.example.net']);
  });
});
