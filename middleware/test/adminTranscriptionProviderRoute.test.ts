import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

import { createAdminTranscriptionProviderRouter } from '../src/routes/adminTranscriptionProvider.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';
import { TranscriptionProviderCatalog } from '../src/platform/transcriptionProviderCatalog.js';
import { parseTranscriptionProviderManifestBlock } from '../src/platform/transcriptionProviderManifest.js';
import { __clearVerificationCache } from '../src/platform/providerCredentialVerifier.js';

/**
 * /api/v1/admin/transcription-provider (#584) — the transcription
 * twin of the providers/embedding-provider admin backends. Covers the
 * provider listing (policy flags for the AVV/EU banner, models with their
 * surfaces), the 4-state key verdict incl. the cache/durable-record
 * behaviour, key entry (write → invalidate → reactivate), and provider
 * selection via activate/deactivate.
 */

const ADAPTER = '@omadia/transcription-adapter-openai';

/** Literal copy of the adapter manifest's `transcription_provider` block. */
const OPENAI_BLOCK = {
  id: 'openai',
  label: 'OpenAI',
  default_base_url: 'https://api.openai.com/v1',
  base_url_config_key: 'base_url',
  policy: {
    requires_avv_disclosure: true,
    eu_hosted: false,
    requires_api_key: true,
  },
  models: [
    {
      id: 'openai:gpt-transcribe',
      model_id: 'gpt-transcribe',
      label: 'GPT Transcribe (Batch)',
      surfaces: ['file'],
    },
  ],
};

/** A second, fictional provider so selection has something to switch to. */
const ACME_BLOCK = {
  id: 'acme',
  label: 'Acme Transcribe',
  default_base_url: 'https://api.acme.example/v1',
  policy: {
    requires_avv_disclosure: false,
    eu_hosted: true,
    requires_api_key: true,
  },
  models: [
    {
      id: 'acme:acme-scribe',
      model_id: 'acme-scribe',
      label: 'Acme Scribe',
      surfaces: ['file'],
    },
  ],
};
const ACME_PLUGIN = '@acme/transcription-adapter';

interface Harness {
  server: Server;
  baseUrl: string;
  vault: InMemorySecretVault;
  registry: InMemoryInstalledRegistry;
  reactivated: string[];
  activated: string[];
  deactivated: string[];
  /** Outbound vendor-API probes the route made. MUST stay empty for GET /. */
  probeCalls: string[];
  close(): Promise<void>;
}

async function makeHarness(
  installed: Array<{ id: string; status?: 'active' | 'inactive'; config?: Record<string, unknown> }>,
  opts: { probeStatus?: number; withAcme?: boolean; failActivate?: string } = {},
): Promise<Harness> {
  const vault = new InMemorySecretVault();
  const registry = new InMemoryInstalledRegistry();
  for (const p of installed) {
    await registry.register({
      id: p.id,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: p.status ?? 'active',
      config: p.config ?? {},
    });
  }
  const catalog = new TranscriptionProviderCatalog();
  catalog.register(parseTranscriptionProviderManifestBlock(OPENAI_BLOCK), ADAPTER);
  if (opts.withAcme === true) {
    catalog.register(parseTranscriptionProviderManifestBlock(ACME_BLOCK), ACME_PLUGIN);
  }

  const reactivated: string[] = [];
  const activated: string[] = [];
  const deactivated: string[] = [];
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/transcription-provider',
    createAdminTranscriptionProviderRouter({
      installedRegistry: registry,
      vault,
      catalog,
      reactivate: async (id: string) => {
        reactivated.push(id);
      },
      activate: async (id: string) => {
        if (opts.failActivate === id) throw new Error(`activate(${id}) exploded`);
        activated.push(id);
      },
      deactivate: async (id: string) => {
        deactivated.push(id);
      },
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  // Intercept only OUTBOUND vendor calls; requests to our own express server
  // fall through to the real fetch. `probeCalls` is what lets a test assert
  // that the listing endpoint touched no network at all.
  const probeCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    // `globalThis.Request`, not express's `Request` — this file imports the
    // express type, which would otherwise shadow the fetch one.
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<globalThis.Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.includes('127.0.0.1')) {
      probeCalls.push(url);
      const probeStatus = opts.probeStatus ?? 200;
      // The verifier refuses to call a bare 200 a working credential — the
      // happy-path stub must answer like the real `models` endpoint does.
      return probeStatus >= 200 && probeStatus < 300
        ? new globalThis.Response(JSON.stringify({ data: [{ id: 'model-1' }] }), {
            status: probeStatus,
            headers: { 'content-type': 'application/json' },
          })
        : new globalThis.Response('', { status: probeStatus });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    vault,
    registry,
    reactivated,
    activated,
    deactivated,
    probeCalls,
    async close() {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface ProviderRow {
  id: string;
  label: string;
  pluginId: string;
  active: boolean;
  connected: boolean;
  status: 'no_key' | 'unverified' | 'verified' | 'invalid';
  verifiedAt?: string;
  verifyError?: string;
  verifyErrorCode?: string;
  verifyReason?: string;
  requiresAvvDisclosure: boolean;
  euHosted: boolean;
  models: Array<{ id: string; modelId: string; label: string; surfaces: string[] }>;
}

interface StateResponse {
  providers: ProviderRow[];
  active: string | null;
  vault_available: boolean;
}

async function getState(h: Harness): Promise<StateResponse> {
  const res = await fetch(`${h.baseUrl}/api/v1/admin/transcription-provider`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as StateResponse;
}

async function verify(
  h: Harness,
  id: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(
    `${h.baseUrl}/api/v1/admin/transcription-provider/${id}/verify`,
    { method: 'POST', headers: { 'content-type': 'application/json' } },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function putKey(
  h: Harness,
  id: string,
  apiKey: string | null,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(
    `${h.baseUrl}/api/v1/admin/transcription-provider/${id}/key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function select(
  h: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}/api/v1/admin/transcription-provider/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('admin transcription-provider route — GET /', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
    // The module-level verification cache is keyed by provider id — a leaked
    // verdict would silently change another test's expected status.
    __clearVerificationCache();
  });

  it('lists providers with policy flags, models and surfaces', async () => {
    h = await makeHarness([{ id: ADAPTER }]);
    const body = await getState(h);
    const openai = body.providers.find((p) => p.id === 'openai');
    assert.ok(openai);
    assert.equal(openai.label, 'OpenAI');
    assert.equal(openai.pluginId, ADAPTER);
    // Policy drives the AVV/EU banner exactly like the LLM providers page.
    assert.equal(openai.requiresAvvDisclosure, true);
    assert.equal(openai.euHosted, false);
    assert.deepEqual(
      openai.models.map((m) => ({ modelId: m.modelId, surfaces: m.surfaces })),
      [{ modelId: 'gpt-transcribe', surfaces: ['file'] }],
    );
    assert.equal(body.active, 'openai');
    assert.equal(body.vault_available, true);
  });

  it('an empty vault is no_key, not merely "not connected"', async () => {
    h = await makeHarness([{ id: ADAPTER }]);
    const body = await getState(h);
    const openai = body.providers.find((p) => p.id === 'openai');
    assert.equal(openai?.status, 'no_key');
    assert.equal(openai?.connected, false);
  });

  it('a stored-but-never-probed key is UNVERIFIED, while `connected` stays true', async () => {
    h = await makeHarness([{ id: ADAPTER }]);
    await h.vault.setMany(ADAPTER, { api_key: 'sk-never-checked' });
    const body = await getState(h);
    const openai = body.providers.find((p) => p.id === 'openai');
    assert.equal(openai?.status, 'unverified');
    assert.equal(openai?.connected, true, 'back-compat: key is on file');
    assert.equal(openai?.verifiedAt, undefined);
  });

  it('makes ZERO outbound calls while listing providers', async () => {
    h = await makeHarness([{ id: ADAPTER }]);
    await h.vault.setMany(ADAPTER, { api_key: 'sk-never-checked' });
    await getState(h);
    await getState(h);
    assert.deepEqual(h.probeCalls, [], 'GET / must never hit a vendor API');
  });

  it('a provider whose plugin is not installed reports active: false and no key state surprises', async () => {
    h = await makeHarness([], { withAcme: true });
    const body = await getState(h);
    assert.equal(body.active, null);
    for (const p of body.providers) {
      assert.equal(p.active, false);
      assert.equal(p.status, 'no_key');
    }
  });
});

describe('admin transcription-provider route — POST /:id/verify', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
    __clearVerificationCache();
  });

  it('a 200 probe yields verified + verifiedAt, and the next GET serves it from cache', async () => {
    h = await makeHarness([{ id: ADAPTER }], { probeStatus: 200 });
    await h.vault.setMany(ADAPTER, { api_key: 'sk-good' });

    const { status, json } = await verify(h, 'openai');
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json['status'], 'verified');
    assert.ok(typeof json['verifiedAt'] === 'string');
    assert.equal(h.probeCalls.length, 1);
    // The probe is the cheapest authenticated call: GET {base}/models.
    assert.ok(h.probeCalls[0]?.startsWith('https://api.openai.com/v1/models'));

    const body = await getState(h);
    const openai = body.providers.find((p) => p.id === 'openai');
    assert.equal(openai?.status, 'verified');
    assert.equal(openai?.verifiedAt, json['verifiedAt']);
    assert.equal(h.probeCalls.length, 1, 'the GET must not re-probe');
  });

  it('persists the verdict so it survives a cold cache (restart)', async () => {
    h = await makeHarness([{ id: ADAPTER }], { probeStatus: 200 });
    await h.vault.setMany(ADAPTER, { api_key: 'sk-good' });
    await verify(h, 'openai');

    __clearVerificationCache(); // simulate a process restart
    const body = await getState(h);
    assert.equal(body.providers.find((p) => p.id === 'openai')?.status, 'verified');
    assert.equal(h.probeCalls.length, 1, 'the durable record must not re-probe');
  });

  it('a 401 probe yields invalid with the machine-readable code', async () => {
    h = await makeHarness([{ id: ADAPTER }], { probeStatus: 401 });
    await h.vault.setMany(ADAPTER, { api_key: 'sk-revoked' });
    const { status, json } = await verify(h, 'openai');
    assert.equal(status, 200);
    assert.equal(json['status'], 'invalid');
    assert.ok(typeof json['error'] === 'string' && json['error'].length > 0);

    const body = await getState(h);
    const openai = body.providers.find((p) => p.id === 'openai');
    assert.equal(openai?.status, 'invalid');
    assert.equal(openai?.verifyErrorCode, 'providers.key_rejected');
    assert.equal(openai?.connected, true);
  });

  it('a 500 probe stays unverified — an outage must not accuse the key', async () => {
    h = await makeHarness([{ id: ADAPTER }], { probeStatus: 503 });
    await h.vault.setMany(ADAPTER, { api_key: 'sk-fine' });
    const { json } = await verify(h, 'openai');
    assert.equal(json['status'], 'unverified');
    assert.equal(json['error'], undefined);
  });

  it('a replaced key never inherits the previous verdict (fingerprint-bound cache)', async () => {
    h = await makeHarness([{ id: ADAPTER }], { probeStatus: 200 });
    await h.vault.setMany(ADAPTER, { api_key: 'sk-old' });
    await verify(h, 'openai');
    assert.equal((await getState(h)).providers[0]?.status, 'verified');

    // Key swapped behind the router's back (install form / secrets PATCH):
    // the cached verdict and the durable record are both bound to the OLD
    // key's fingerprint, so the new key must read as unverified.
    await h.vault.setMany(ADAPTER, { api_key: 'sk-new' });
    const body = await getState(h);
    assert.equal(body.providers.find((p) => p.id === 'openai')?.status, 'unverified');
    assert.equal(h.probeCalls.length, 1, 'the GET must not probe the new key');
  });

  it('reports no_key when nothing is stored, and 404 for an unknown provider', async () => {
    h = await makeHarness([{ id: ADAPTER }]);
    const empty = await verify(h, 'openai');
    assert.equal(empty.json['status'], 'no_key');
    assert.equal(h.probeCalls.length, 0);

    const unknown = await verify(h, 'not-a-provider');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json['code'], 'transcriptionProvider.unknown_provider');
  });
});

describe('admin transcription-provider route — POST /:id/key', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
    __clearVerificationCache();
  });

  it('stores the key in the adapter plugin scope and reactivates it', async () => {
    h = await makeHarness([{ id: ADAPTER }]);
    const { status, json } = await putKey(h, 'openai', 'sk-fresh');
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(await h.vault.get(ADAPTER, 'api_key'), 'sk-fresh');
    // The adapter reads its key at activate() — without a reactivate the
    // saved key would not publish the capability until the next boot.
    assert.deepEqual(h.reactivated, [ADAPTER]);

    const body = await getState(h);
    assert.equal(body.providers.find((p) => p.id === 'openai')?.status, 'unverified');
  });

  it('a key save drops the previous verdict — no stale verified chip', async () => {
    h = await makeHarness([{ id: ADAPTER }], { probeStatus: 200 });
    await putKey(h, 'openai', 'sk-first');
    await verify(h, 'openai');
    assert.equal((await getState(h)).providers[0]?.status, 'verified');

    await putKey(h, 'openai', 'sk-second');
    const body = await getState(h);
    assert.equal(body.providers.find((p) => p.id === 'openai')?.status, 'unverified');
    assert.equal(h.probeCalls.length, 1, 'the key save itself must not probe');
  });

  it('null removes the key, the verdict record, and reactivates', async () => {
    h = await makeHarness([{ id: ADAPTER }], { probeStatus: 200 });
    await putKey(h, 'openai', 'sk-to-remove');
    await verify(h, 'openai');

    const { status } = await putKey(h, 'openai', null);
    assert.equal(status, 200);
    assert.equal(await h.vault.get(ADAPTER, 'api_key'), undefined);
    assert.deepEqual(h.reactivated, [ADAPTER, ADAPTER]);

    __clearVerificationCache(); // even after a restart …
    const body = await getState(h);
    assert.equal(
      body.providers.find((p) => p.id === 'openai')?.status,
      'no_key',
      'a removed key must not resurrect as verified from the durable record',
    );
  });

  it('rejects a non-string body and an unknown provider', async () => {
    h = await makeHarness([{ id: ADAPTER }]);
    const bad = await putKey(h, 'openai', 42 as unknown as string);
    assert.equal(bad.status, 400);
    assert.equal(bad.json['code'], 'transcriptionProvider.invalid_request');

    const unknown = await putKey(h, 'nope', 'sk-x');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json['code'], 'transcriptionProvider.unknown_provider');
  });
});

describe('admin transcription-provider route — POST /select', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
    __clearVerificationCache();
  });

  it('activates the target, deactivates the previous, and persists the selection', async () => {
    h = await makeHarness(
      [{ id: ADAPTER }, { id: ACME_PLUGIN, status: 'inactive' }],
      { withAcme: true },
    );
    assert.equal((await getState(h)).active, 'openai');

    const { status, json } = await select(h, { providerId: 'acme' });
    assert.equal(status, 200, JSON.stringify(json));
    assert.deepEqual(h.deactivated, [ADAPTER]);
    assert.deepEqual(h.activated, [ACME_PLUGIN]);

    // Selection persistence: the registry statuses carry the choice.
    assert.equal(h.registry.get(ADAPTER)?.status, 'inactive');
    assert.equal(h.registry.get(ACME_PLUGIN)?.status, 'active');
    assert.equal((await getState(h)).active, 'acme');
  });

  it('409 when the target is already the active provider', async () => {
    h = await makeHarness([{ id: ADAPTER }]);
    const { status, json } = await select(h, { providerId: 'openai' });
    assert.equal(status, 409);
    assert.equal(json['code'], 'transcriptionProvider.already_active');
    assert.deepEqual(h.activated, []);
  });

  it('404 for an unknown provider and for a not-installed plugin', async () => {
    h = await makeHarness([{ id: ADAPTER }], { withAcme: true });
    const unknown = await select(h, { providerId: 'nope' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json['code'], 'transcriptionProvider.unknown_provider');

    // acme is in the catalog (manifest known) but its plugin is not installed.
    const notInstalled = await select(h, { providerId: 'acme' });
    assert.equal(notInstalled.status, 404);
    assert.equal(notInstalled.json['code'], 'transcriptionProvider.not_installed');
  });

  it('rolls back to the previous provider when activating the target fails', async () => {
    h = await makeHarness(
      [{ id: ADAPTER }, { id: ACME_PLUGIN, status: 'inactive' }],
      { withAcme: true, failActivate: ACME_PLUGIN },
    );
    const { status, json } = await select(h, { providerId: 'acme' });
    assert.equal(status, 500);
    assert.equal(json['code'], 'transcriptionProvider.switch_failed');
    // The previous provider was reactivated and is still the selection.
    assert.deepEqual(h.activated, [ADAPTER]);
    assert.equal(h.registry.get(ADAPTER)?.status, 'active');
    assert.equal((await getState(h)).active, 'openai');
  });

  it('400 for a missing providerId', async () => {
    h = await makeHarness([{ id: ADAPTER }]);
    const { status, json } = await select(h, {});
    assert.equal(status, 400);
    assert.equal(json['code'], 'transcriptionProvider.invalid_request');
  });
});

describe('mount-time auth', () => {
  // `requireAuth` is applied at MOUNT time in production (src/index.ts),
  // exactly like the sibling providers and embedding-provider routers. This
  // suite proves the router itself performs no second auth check — mounting
  // it behind a denying middleware must 401 every route.
  it('a denying mount middleware blocks every route', async () => {
    const registry = new InMemoryInstalledRegistry();
    const catalog = new TranscriptionProviderCatalog();
    catalog.register(parseTranscriptionProviderManifestBlock(OPENAI_BLOCK), ADAPTER);
    const app: Express = express();
    app.use(express.json());
    const denyAll = (_req: Request, res: Response, _next: NextFunction): void => {
      res.status(401).json({ code: 'auth.required' });
    };
    app.use(
      '/api/v1/admin/transcription-provider',
      denyAll,
      createAdminTranscriptionProviderRouter({
        installedRegistry: registry,
        catalog,
        activate: async () => {},
        deactivate: async () => {},
      }),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${String(port)}/api/v1/admin/transcription-provider`;
    try {
      for (const [method, path] of [
        ['GET', ''],
        ['POST', '/openai/verify'],
        ['POST', '/openai/key'],
        ['POST', '/select'],
      ] as const) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(method === 'GET' ? {} : { body: '{}' }),
        });
        assert.equal(res.status, 401, `${method} ${path || '/'} must be blocked`);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
