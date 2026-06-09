import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAdminSettingsRouter } from '../src/routes/adminSettings.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

/**
 * /api/v1/admin/settings — the *cross-plugin* config/vault overview. After the
 * per-plugin settings were de-duplicated out of this page (each plugin's own
 * setup.fields editor is now the source of truth), the catalog holds only the
 * shared Anthropic API key, whose secret fans out to three vault scopes. These
 * tests cover that one entry end-to-end: secret set/unset resolution, the
 * fan-out write, the sk-ant- prefix validation, and unknown/not-installed paths.
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
    '/api/v1/admin/settings',
    createAdminSettingsRouter({
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

async function getSettings(h: Harness): Promise<{
  categories: Array<{
    category: string;
    settings: Array<{
      key: string;
      installed: boolean;
      value?: string | null;
      isSet?: boolean;
      type: string;
    }>;
  }>;
  vault_available: boolean;
}> {
  const res = await fetch(`${h.baseUrl}/api/v1/admin/settings`);
  assert.equal(res.status, 200);
  return res.json() as never;
}

function findSetting(
  body: Awaited<ReturnType<typeof getSettings>>,
  key: string,
): { installed: boolean; value?: string | null; isSet?: boolean; type?: string } | undefined {
  for (const c of body.categories) {
    const s = c.settings.find((x) => x.key === key);
    if (s) return s;
  }
  return undefined;
}

async function patch(
  h: Harness,
  changes: Array<{ key: string; value: string | null }>,
): Promise<{ status: number; body: { updated?: unknown[]; errors?: Array<{ key: string; message: string }>; code?: string } }> {
  const res = await fetch(`${h.baseUrl}/api/v1/admin/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
  return { status: res.status, body: (await res.json()) as never };
}

describe('admin settings route — GET /', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('exposes the shared Anthropic key as an installed secret when all scopes are present', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const body = await getSettings(h);
    assert.ok(body.vault_available);
    const key = findSetting(body, 'ANTHROPIC_API_KEY');
    assert.equal(key?.installed, true);
    assert.equal(key?.type, 'secret');
    assert.equal(key?.isSet, false);
  });

  it('flags the key not-installed when one scope plugin is missing', async () => {
    // Verifier + extras missing → the cross-plugin secret can't be fully written.
    h = await makeHarness([{ id: ORCH }]);
    const body = await getSettings(h);
    const key = findSetting(body, 'ANTHROPIC_API_KEY');
    assert.equal(key?.installed, false);
  });

  it('reports secret set/unset without leaking the value', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    await h.vault.setMany(ORCH, { anthropic_api_key: 'sk-ant-supersecret' });
    const body = await getSettings(h);
    const key = findSetting(body, 'ANTHROPIC_API_KEY');
    assert.equal(key?.isSet, true);
    assert.ok(!JSON.stringify(body).includes('sk-ant-supersecret'));
  });
});

describe('admin settings route — PATCH /', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('writes the Anthropic secret to every configured vault scope and reactivates each', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status } = await patch(h, [
      { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-test123' },
    ]);
    assert.equal(status, 200);
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      const keys = await h.vault.listKeys(scope);
      assert.ok(keys.includes('anthropic_api_key'), `missing in ${scope}`);
    }
    assert.deepEqual(h.reactivated.sort(), [ORCH, EXTRAS, VERIFIER].sort());
  });

  it('clears the Anthropic secret from every scope on an empty value', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      await h.vault.setMany(scope, { anthropic_api_key: 'sk-ant-old' });
    }
    const { status } = await patch(h, [{ key: 'ANTHROPIC_API_KEY', value: null }]);
    assert.equal(status, 200);
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      const keys = await h.vault.listKeys(scope);
      assert.ok(!keys.includes('anthropic_api_key'), `still set in ${scope}`);
    }
  });

  it('rejects an Anthropic key without the sk-ant- prefix', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status, body } = await patch(h, [
      { key: 'ANTHROPIC_API_KEY', value: 'nope' },
    ]);
    assert.equal(status, 400);
    assert.ok(body.errors?.some((e) => e.key === 'ANTHROPIC_API_KEY'));
    assert.deepEqual(h.reactivated, []);
  });

  it('errors on an unknown setting key', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status, body } = await patch(h, [
      { key: 'ORCHESTRATOR_MODEL', value: 'claude-opus-4-8' },
    ]);
    // No longer in the catalog — orchestrator settings moved to the per-plugin editor.
    assert.equal(status, 400);
    assert.equal(body.code, 'settings.no_valid_changes');
    assert.ok(
      body.errors?.some(
        (e) => e.key === 'ORCHESTRATOR_MODEL' && e.message.includes('unknown'),
      ),
    );
  });

  it('errors when a target scope plugin is not installed', async () => {
    h = await makeHarness([{ id: ORCH }]); // verifier + extras missing
    const { status, body } = await patch(h, [
      { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-test123' },
    ]);
    assert.equal(status, 400);
    assert.equal(body.code, 'settings.no_valid_changes');
    assert.ok(
      body.errors?.some(
        (e) =>
          e.key === 'ANTHROPIC_API_KEY' && e.message.includes('not installed'),
      ),
    );
  });
});
