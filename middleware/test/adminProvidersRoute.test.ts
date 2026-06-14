import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { providerApiKeyVaultKey } from '@omadia/llm-provider';
import express from 'express';
import type { Express } from 'express';

import { createAdminProvidersRouter } from '../src/routes/adminProviders.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

/**
 * /api/v1/admin/providers (S6) — the dedicated models/providers admin backend.
 * Covers the providers+models listing (from the global registry) with
 * connection status, the per-plugin assignment read, and the assignment write
 * (config + reactivate, routing-disable on a non-Anthropic switch, and the
 * model/provider mismatch guard).
 */

const ORCH = '@omadia/orchestrator';
const VERIFIER = '@omadia/verifier';
const EXTRAS = '@omadia/orchestrator-extras';

interface Harness {
  server: Server;
  baseUrl: string;
  vault: InMemorySecretVault;
  registry: InMemoryInstalledRegistry;
  reactivated: string[];
  close(): Promise<void>;
}

async function makeHarness(
  installed: Array<{ id: string; config?: Record<string, unknown> }>,
): Promise<Harness> {
  const vault = new InMemorySecretVault();
  const registry = new InMemoryInstalledRegistry();
  for (const p of installed) {
    await registry.register({
      id: p.id,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: p.config ?? {},
    });
  }
  const reactivated: string[] = [];
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/providers',
    createAdminProvidersRouter({
      installedRegistry: registry,
      vault,
      reactivate: async (id: string) => {
        reactivated.push(id);
      },
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    vault,
    registry,
    reactivated,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface ProvidersResponse {
  providers: Array<{
    id: string;
    label: string;
    connected: boolean;
    models: Array<{ id: string; modelId: string; class: string }>;
  }>;
  assignments: Array<{
    pluginId: string;
    provider: string;
    model: string | null;
    installed: boolean;
    modelRouting?: string;
  }>;
}

async function getProviders(h: Harness): Promise<ProvidersResponse> {
  const res = await fetch(`${h.baseUrl}/api/v1/admin/providers`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as ProvidersResponse;
}

async function assign(
  h: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}/api/v1/admin/providers/assignment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('admin providers route — GET /', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('lists providers + registry models and per-plugin assignments', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const body = await getProviders(h);
    const anthropic = body.providers.find((p) => p.id === 'anthropic');
    const openai = body.providers.find((p) => p.id === 'openai');
    assert.ok(anthropic && openai);
    assert.ok(anthropic.models.some((m) => m.modelId === 'claude-opus-4-8'));
    assert.ok(openai.models.some((m) => m.modelId === 'gpt-5.5'));
    // nothing connected yet
    assert.equal(anthropic.connected, false);
    assert.equal(openai.connected, false);
    // assignments default to anthropic, no model set
    const orch = body.assignments.find((a) => a.pluginId === ORCH);
    assert.equal(orch?.provider, 'anthropic');
    assert.equal(orch?.model, null);
    assert.equal(orch?.installed, true);
    assert.equal(orch?.modelRouting, 'false');
  });

  it('reports connected providers from the vault (canonical + legacy)', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    await h.vault.setMany(ORCH, {
      [providerApiKeyVaultKey('openai')]: 'sk-openai',
      anthropic_api_key: 'sk-ant-legacy', // legacy fallback counts for anthropic
    });
    const body = await getProviders(h);
    assert.equal(body.providers.find((p) => p.id === 'openai')?.connected, true);
    assert.equal(body.providers.find((p) => p.id === 'anthropic')?.connected, true);
  });

  it('reflects a configured assignment', async () => {
    h = await makeHarness([
      { id: ORCH, config: { llm_provider: 'openai', orchestrator_model: 'gpt-5.5' } },
      { id: VERIFIER },
      { id: EXTRAS },
    ]);
    const body = await getProviders(h);
    const orch = body.assignments.find((a) => a.pluginId === ORCH);
    assert.equal(orch?.provider, 'openai');
    assert.equal(orch?.model, 'gpt-5.5');
  });
});

describe('admin providers route — POST /assignment', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('sets provider + model, disables routing for the orchestrator, reactivates', async () => {
    h = await makeHarness([
      { id: ORCH, config: { orchestrator_model: 'claude-opus-4-8', orchestrator_model_routing: 'true' } },
      { id: VERIFIER },
      { id: EXTRAS },
    ]);
    const { status, json } = await assign(h, {
      pluginId: ORCH,
      provider: 'openai',
      model: 'gpt-5.5',
    });
    assert.equal(status, 200, JSON.stringify(json));
    const cfg = h.registry.get(ORCH)?.config ?? {};
    assert.equal(cfg['llm_provider'], 'openai');
    assert.equal(cfg['orchestrator_model'], 'gpt-5.5');
    // non-anthropic → per-turn routing forced off
    assert.equal(cfg['orchestrator_model_routing'], 'false');
    assert.deepEqual(h.reactivated, [ORCH]);
  });

  it('sets BOTH model keys for the extras plugin', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status } = await assign(h, {
      pluginId: EXTRAS,
      provider: 'openai',
      model: 'gpt-5.4-mini',
    });
    assert.equal(status, 200);
    const cfg = h.registry.get(EXTRAS)?.config ?? {};
    assert.equal(cfg['fact_extractor_model'], 'gpt-5.4-mini');
    assert.equal(cfg['topic_classifier_model'], 'gpt-5.4-mini');
  });

  it('keeps anthropic routing untouched on an anthropic assignment', async () => {
    h = await makeHarness([
      { id: ORCH, config: { orchestrator_model_routing: 'true' } },
      { id: VERIFIER },
      { id: EXTRAS },
    ]);
    const { status } = await assign(h, {
      pluginId: ORCH,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    assert.equal(status, 200);
    const cfg = h.registry.get(ORCH)?.config ?? {};
    assert.equal(cfg['orchestrator_model_routing'], 'true');
  });

  it('rejects a model that belongs to a different provider', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status, json } = await assign(h, {
      pluginId: ORCH,
      provider: 'openai',
      model: 'claude-opus-4-8',
    });
    assert.equal(status, 400);
    assert.equal(json['code'], 'providers.model_provider_mismatch');
  });

  it('allows an unknown (custom/openai-compatible) model id', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status } = await assign(h, {
      pluginId: ORCH,
      provider: 'openai-compatible',
      model: 'mistral-large-latest',
    });
    assert.equal(status, 200);
  });

  it('preserves unrelated config keys across an assignment (merge, no key loss)', async () => {
    h = await makeHarness([
      {
        id: ORCH,
        config: {
          orchestrator_model: 'claude-opus-4-8',
          orchestrator_max_tokens: '8192',
          assistant_identity: 'Lucy',
        },
      },
      { id: VERIFIER },
      { id: EXTRAS },
    ]);
    const { status } = await assign(h, { pluginId: ORCH, provider: 'openai', model: 'gpt-5.5' });
    assert.equal(status, 200);
    const cfg = h.registry.get(ORCH)?.config ?? {};
    assert.equal(cfg['orchestrator_max_tokens'], '8192', 'max_tokens dropped');
    assert.equal(cfg['assistant_identity'], 'Lucy', 'identity dropped');
    assert.equal(cfg['orchestrator_model'], 'gpt-5.5');
    assert.equal(cfg['llm_provider'], 'openai');
  });

  it('normalises provider-qualified ids, class refs and aliases to the bare vendor id', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    // provider-qualified id
    await assign(h, { pluginId: ORCH, provider: 'openai', model: 'openai:gpt-5.5' });
    assert.equal(h.registry.get(ORCH)?.config['orchestrator_model'], 'gpt-5.5');
    // class ref resolves against the chosen provider
    await assign(h, { pluginId: ORCH, provider: 'openai', model: 'class:frontier' });
    assert.equal(h.registry.get(ORCH)?.config['orchestrator_model'], 'gpt-5.5');
    // legacy alias under anthropic
    await assign(h, { pluginId: ORCH, provider: 'anthropic', model: 'opus' });
    assert.equal(h.registry.get(ORCH)?.config['orchestrator_model'], 'claude-opus-4-8');
  });

  it('400 for a non-LLM plugin, 404 for not-installed', async () => {
    h = await makeHarness([{ id: VERIFIER }, { id: EXTRAS }]);
    const unknown = await assign(h, { pluginId: '@omadia/diagrams', provider: 'openai', model: 'gpt-5.5' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json['code'], 'providers.unknown_plugin');
    const notInstalled = await assign(h, { pluginId: ORCH, provider: 'openai', model: 'gpt-5.5' });
    assert.equal(notInstalled.status, 404);
    assert.equal(notInstalled.json['code'], 'providers.not_installed');
  });
});
