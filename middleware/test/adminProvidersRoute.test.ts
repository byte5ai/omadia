import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  LlmProviderCatalog,
  clearExternalModels,
  providerApiKeyVaultKey,
  registerExternalModels,
} from '@omadia/llm-provider';
import express from 'express';
import type { Express } from 'express';

import { createAdminProvidersRouter } from '../src/routes/adminProviders.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';
import {
  BUILTIN_LLM_PROVIDERS,
  registerBuiltinLlmProviders,
} from '../src/platform/builtinLlmProviders.js';
import { __clearVerificationCache } from '../src/platform/providerCredentialVerifier.js';

// The registry ships no static models now; makeHarness registers the bundled
// built-ins (anthropic/openai/mistral) into a catalog passed to the route, so it
// lists them + their data-protection policy exactly as production wires it.

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
  /** Outbound vendor-API probes the route made. MUST stay empty for GET /. */
  probeCalls: string[];
  close(): Promise<void>;
}

async function makeHarness(
  installed: Array<{ id: string; config?: Record<string, unknown> }>,
  opts: { probeStatus?: number } = {},
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
  // Register the bundled built-ins into a fresh catalog (also populates the
  // global model overlay) so the route lists providers/models + their policy.
  clearExternalModels();
  const llmProviderCatalog = new LlmProviderCatalog();
  registerBuiltinLlmProviders(llmProviderCatalog);
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
      llmProviderCatalog,
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  // Intercept only OUTBOUND vendor calls; requests to our own express server
  // fall through to the real fetch. `probeCalls` is what lets a test assert
  // that the listing endpoint touched no network at all.
  const probeCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.includes('127.0.0.1')) {
      probeCalls.push(url);
      const probeStatus = opts.probeStatus ?? 200;
      // A 2xx only counts as `verified` when it carries a JSON model list —
      // a bare 200 is what a corporate proxy's block page looks like, and the
      // verifier deliberately refuses to call that a working credential. So the
      // happy-path stub has to answer like the real `models` endpoint does.
      return probeStatus >= 200 && probeStatus < 300
        ? new Response(JSON.stringify({ data: [{ id: 'model-1' }] }), {
            status: probeStatus,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('', { status: probeStatus });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;

  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    vault,
    registry,
    reactivated,
    probeCalls,
    async close() {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface ProvidersResponse {
  providers: Array<{
    id: string;
    label: string;
    connected: boolean;
    status: 'no_key' | 'unverified' | 'verified' | 'invalid';
    verifiedAt?: string;
    verifyError?: string;
    verifyErrorCode?: string;
    requiresAvvDisclosure?: boolean;
    euHosted?: boolean;
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
    // Clear the global model overlay so concurrent test files don't see our
    // built-ins (and we don't see theirs) — keeps the full-suite run clean.
    clearExternalModels();
    // Same reasoning for the module-level verification cache: it is keyed by
    // provider id only, so a leaked verdict would silently change another
    // test's expected status.
    __clearVerificationCache();
  });

  it('lists providers + registry models and per-plugin assignments', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const body = await getProviders(h);
    const anthropic = body.providers.find((p) => p.id === 'anthropic');
    const openai = body.providers.find((p) => p.id === 'openai');
    const mistral = body.providers.find((p) => p.id === 'mistral');
    assert.ok(anthropic && openai && mistral);
    assert.ok(anthropic.models.some((m) => m.modelId === 'claude-opus-4-8'));
    assert.ok(openai.models.some((m) => m.modelId === 'gpt-5.5'));
    // Mistral is registry-driven too: listed with a clean label + its models.
    assert.equal(mistral.label, 'Mistral');
    assert.ok(mistral.models.some((m) => m.modelId === 'mistral-large-latest'));
    assert.equal(mistral.connected, false);
    // Data-protection policy flags are data-driven from the provider descriptor
    // (replaces the old hard-coded `provider !== 'anthropic'` / `=== 'mistral'`).
    assert.equal(anthropic.requiresAvvDisclosure, false);
    assert.equal(openai.requiresAvvDisclosure, true);
    assert.equal(mistral.requiresAvvDisclosure, true);
    assert.equal(mistral.euHosted, true);
    assert.equal(anthropic.euHosted, false);
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

  it('an empty vault is no_key, not merely "not connected"', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const body = await getProviders(h);
    const anthropic = body.providers.find((p) => p.id === 'anthropic');
    assert.equal(anthropic?.status, 'no_key');
    assert.equal(anthropic?.connected, false);
  });

  it('a stored-but-never-probed key is UNVERIFIED, while `connected` stays true', async () => {
    // This is the whole bug (OM-02/03/04): the dashboard said "VERBUNDEN"
    // purely because a string sat in the vault. `connected` must keep its old
    // meaning for back-compat, but `status` must tell the truth.
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    await h.vault.setMany(ORCH, {
      [providerApiKeyVaultKey('anthropic')]: 'sk-ant-never-checked',
    });
    const body = await getProviders(h);
    const anthropic = body.providers.find((p) => p.id === 'anthropic');
    assert.equal(anthropic?.status, 'unverified');
    assert.equal(anthropic?.connected, true, 'back-compat: key is on file');
    assert.equal(anthropic?.verifiedAt, undefined);
  });

  it('makes ZERO outbound calls while listing providers', async () => {
    // Load-bearing regression guard. If the listing endpoint ever probes, the
    // dashboard becomes slow, rate-limitable and dependent on the vendor being
    // up — the exact failure mode the cache exists to prevent.
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    await h.vault.setMany(ORCH, {
      [providerApiKeyVaultKey('anthropic')]: 'sk-ant-never-checked',
      [providerApiKeyVaultKey('openai')]: 'sk-openai',
      [providerApiKeyVaultKey('mistral')]: 'mistral-key',
    });
    await getProviders(h);
    await getProviders(h);
    assert.deepEqual(h.probeCalls, [], 'GET / must never hit a vendor API');
  });

  it('orders providers deterministically across calls, even after a re-registration', async () => {
    // OM-10b: `listModels()` returns providers in plugin ACTIVATION order, and
    // a key save re-registers the plugin's models — which used to move the
    // provider the operator just configured to the bottom of the list.
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const first = (await getProviders(h)).providers.map((p) => p.id);
    // Simulate the re-registration `reactivate()` performs after a key save:
    // the plugin's models are disposed and re-registered, landing at the END of
    // the registry. Reversing the whole registration order is the harshest
    // version of that, and the response must be unchanged.
    clearExternalModels();
    registerExternalModels(
      [...BUILTIN_LLM_PROVIDERS].reverse().flatMap((d) => [...d.models]),
    );
    const second = (await getProviders(h)).providers.map((p) => p.id);
    assert.deepEqual(second, first, 'provider order must not depend on load order');

    // And the order obeys the documented comparator: keyed providers first,
    // then label ascending within each group. Asserted as an invariant rather
    // than a fixed list, because whether the `claude-cli` provider counts as
    // connected depends on whether the host happens to have the CLI logged in.
    const rows = (await getProviders(h)).providers;
    const keyedRun = rows.filter((p) => p.connected);
    assert.deepEqual(
      rows.slice(0, keyedRun.length).map((p) => p.id),
      keyedRun.map((p) => p.id),
      'connected providers must all come first',
    );
    for (const group of [keyedRun, rows.filter((p) => !p.connected)]) {
      const labels = group.map((p) => p.label);
      const sorted = [...labels].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
      assert.deepEqual(labels, sorted, 'labels must ascend within a group');
    }
  });
});

describe('admin providers route — POST /:id/verify', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
    clearExternalModels();
    __clearVerificationCache();
  });

  async function verify(
    harness: Harness,
    id: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(
      `${harness.baseUrl}/api/v1/admin/providers/${id}/verify`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('a 200 probe yields verified + verifiedAt, and the next GET serves it from cache', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], {
      probeStatus: 200,
    });
    await h.vault.setMany(ORCH, {
      [providerApiKeyVaultKey('anthropic')]: 'sk-ant-good',
    });

    const { status, json } = await verify(h, 'anthropic');
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json['status'], 'verified');
    assert.ok(typeof json['verifiedAt'] === 'string');
    assert.equal(h.probeCalls.length, 1);

    const body = await getProviders(h);
    const anthropic = body.providers.find((p) => p.id === 'anthropic');
    assert.equal(anthropic?.status, 'verified');
    assert.equal(anthropic?.verifiedAt, json['verifiedAt']);
    assert.equal(h.probeCalls.length, 1, 'the GET must not re-probe');
  });

  it('persists the verdict so it survives a cold cache (restart)', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], {
      probeStatus: 200,
    });
    await h.vault.setMany(ORCH, {
      [providerApiKeyVaultKey('anthropic')]: 'sk-ant-good',
    });
    await verify(h, 'anthropic');

    __clearVerificationCache(); // simulate a process restart
    const body = await getProviders(h);
    assert.equal(
      body.providers.find((p) => p.id === 'anthropic')?.status,
      'verified',
    );
    assert.equal(h.probeCalls.length, 1, 'the durable record must not re-probe');
  });

  it('a 401 probe yields invalid with an explanatory error', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], {
      probeStatus: 401,
    });
    await h.vault.setMany(ORCH, {
      [providerApiKeyVaultKey('anthropic')]: 'sk-ant-revoked',
    });
    const { status, json } = await verify(h, 'anthropic');
    assert.equal(status, 200);
    assert.equal(json['status'], 'invalid');
    assert.ok(typeof json['error'] === 'string' && json['error'].length > 0);

    const body = await getProviders(h);
    const anthropic = body.providers.find((p) => p.id === 'anthropic');
    assert.equal(anthropic?.status, 'invalid');
    assert.ok(anthropic?.verifyError);
    // OM-09: the DTO also carries the machine code, so web-ui can render its
    // own localized copy instead of the English sentence in `verifyError`.
    assert.equal(anthropic?.verifyErrorCode, 'providers.key_rejected');
    // Still "connected" in the legacy sense — a key IS on file, it just fails.
    assert.equal(anthropic?.connected, true);
  });

  // The field is conditional: a verdict with no code must leave it OFF the
  // payload entirely, so `verifyErrorCode === undefined` keeps meaning
  // "nothing to resolve" for both older and newer clients.
  it('omits verifyErrorCode entirely on every non-rejected provider', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], {
      probeStatus: 200,
    });
    await h.vault.setMany(ORCH, {
      [providerApiKeyVaultKey('anthropic')]: 'sk-ant-good',
    });
    await verify(h, 'anthropic');

    const body = await getProviders(h);
    for (const p of body.providers) {
      assert.notEqual(p.status, 'invalid', p.id);
      assert.equal(
        Object.prototype.hasOwnProperty.call(p, 'verifyErrorCode'),
        false,
        `${p.id} must not carry verifyErrorCode`,
      );
    }
  });

  it('a 500 probe stays unverified — an outage must not accuse the key', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], {
      probeStatus: 503,
    });
    await h.vault.setMany(ORCH, {
      [providerApiKeyVaultKey('anthropic')]: 'sk-ant-fine',
    });
    const { json } = await verify(h, 'anthropic');
    assert.equal(json['status'], 'unverified');
    assert.equal(json['error'], undefined);
  });

  it('reports no_key when nothing is stored, and 404 for an unknown provider', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const empty = await verify(h, 'anthropic');
    assert.equal(empty.json['status'], 'no_key');
    assert.equal(h.probeCalls.length, 0);

    const unknown = await verify(h, 'not-a-provider');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json['code'], 'providers.unknown_provider');
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
    // Clear the global model overlay so concurrent test files don't see our
    // built-ins (and we don't see theirs) — keeps the full-suite run clean.
    clearExternalModels();
    // Same reasoning for the module-level verification cache: it is keyed by
    // provider id only, so a leaked verdict would silently change another
    // test's expected status.
    __clearVerificationCache();
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
    // A genuinely-unregistered model id passes through (custom/self-hosted).
    // (`mistral-large-latest` is now a first-class registry model, so it would
    // correctly mismatch provider 'openai-compatible' — see the Mistral test.)
    const { status } = await assign(h, {
      pluginId: ORCH,
      provider: 'openai-compatible',
      model: 'llama-3.3-70b-instruct',
    });
    assert.equal(status, 200);
  });

  it('assigns a Mistral model by class ref, stores the bare id, disables routing', async () => {
    h = await makeHarness([
      { id: ORCH, config: { orchestrator_model_routing: 'true' } },
      { id: VERIFIER },
      { id: EXTRAS },
    ]);
    // class:frontier resolves against the chosen provider → mistral-large-latest.
    const { status, json } = await assign(h, {
      pluginId: ORCH,
      provider: 'mistral',
      model: 'class:frontier',
    });
    assert.equal(status, 200, JSON.stringify(json));
    const cfg = h.registry.get(ORCH)?.config ?? {};
    assert.equal(cfg['llm_provider'], 'mistral');
    assert.equal(cfg['orchestrator_model'], 'mistral-large-latest');
    // non-anthropic → per-turn Claude routing forced off
    assert.equal(cfg['orchestrator_model_routing'], 'false');
  });

  it('rejects a Mistral model assigned to the wrong provider', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status, json } = await assign(h, {
      pluginId: ORCH,
      provider: 'openai',
      model: 'mistral-large-latest',
    });
    assert.equal(status, 400);
    assert.equal(json['code'], 'providers.model_provider_mismatch');
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
