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
 * /api/v1/admin/settings — the .env-based config/vault overview. Verifies the
 * catalog → current-value resolution, the typed PATCH validation, and that a
 * change writes to the right target (config-store vs vault) and reactivates
 * exactly the touched plugins.
 */

const ORCH = '@omadia/orchestrator';
const VERIFIER = '@omadia/verifier';
const EXTRAS = '@omadia/orchestrator-extras';
const DIAGRAMS = '@omadia/diagrams';

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
): { installed: boolean; value?: string | null; isSet?: boolean } | undefined {
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

  it('groups the catalog and resolves current config values', async () => {
    h = await makeHarness([
      { id: ORCH, config: { orchestrator_model: 'claude-opus-4-7' } },
    ]);
    const body = await getSettings(h);
    assert.ok(body.vault_available);
    const model = findSetting(body, 'ORCHESTRATOR_MODEL');
    assert.equal(model?.installed, true);
    assert.equal(model?.value, 'claude-opus-4-7');
    // A setting whose plugin isn't installed is flagged not-installed.
    const telegram = findSetting(body, 'TELEGRAM_BOT_TOKEN');
    assert.equal(telegram?.installed, false);
  });

  it('reports secret set/unset without leaking the value', async () => {
    h = await makeHarness([{ id: DIAGRAMS }]);
    await h.vault.setMany(DIAGRAMS, { aws_access_key_id: 'AKIA-secret' });
    const body = await getSettings(h);
    const aws = findSetting(body, 'AWS_ACCESS_KEY_ID');
    assert.equal(aws?.isSet, true);
    assert.ok(!JSON.stringify(body).includes('AKIA-secret'));
  });
});

describe('admin settings route — PATCH /', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('writes a config value and reactivates the target plugin', async () => {
    h = await makeHarness([
      { id: ORCH, config: { orchestrator_model: 'claude-opus-4-7' } },
    ]);
    const { status } = await patch(h, [
      { key: 'ORCHESTRATOR_MODEL', value: 'claude-opus-4-8' },
    ]);
    assert.equal(status, 200);
    assert.equal(
      h.registry.get(ORCH)?.config['orchestrator_model'],
      'claude-opus-4-8',
    );
    assert.deepEqual(h.reactivated, [ORCH]);
  });

  it('stores a boolean toggle as a string and reactivates once', async () => {
    h = await makeHarness([{ id: ORCH }]);
    const { status } = await patch(h, [
      { key: 'ORCHESTRATOR_MODEL_ROUTING', value: 'true' },
    ]);
    assert.equal(status, 200);
    assert.equal(
      h.registry.get(ORCH)?.config['orchestrator_model_routing'],
      'true',
    );
    assert.deepEqual(h.reactivated, [ORCH]);
  });

  it('clears a config key when value is empty/null', async () => {
    h = await makeHarness([
      { id: ORCH, config: { model_routing_simple_model: 'claude-sonnet-4-6' } },
    ]);
    const { status } = await patch(h, [
      { key: 'MODEL_ROUTING_SIMPLE_MODEL', value: null },
    ]);
    assert.equal(status, 200);
    assert.equal(
      h.registry.get(ORCH)?.config['model_routing_simple_model'],
      undefined,
    );
  });

  it('rejects a non-numeric value for a number setting', async () => {
    h = await makeHarness([{ id: ORCH }]);
    const { status, body } = await patch(h, [
      { key: 'ORCHESTRATOR_MAX_TOKENS', value: 'lots' },
    ]);
    // Only change is invalid → no valid changes.
    assert.equal(status, 400);
    assert.equal(body.code, 'settings.no_valid_changes');
    assert.ok(body.errors?.some((e) => e.key === 'ORCHESTRATOR_MAX_TOKENS'));
    assert.deepEqual(h.reactivated, []);
  });

  it('writes a secret to every configured vault scope', async () => {
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

  it('rejects an Anthropic key without the sk-ant- prefix', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status, body } = await patch(h, [
      { key: 'ANTHROPIC_API_KEY', value: 'nope' },
    ]);
    assert.equal(status, 400);
    assert.ok(body.errors?.some((e) => e.key === 'ANTHROPIC_API_KEY'));
  });

  it('errors a change whose target plugin is not installed', async () => {
    h = await makeHarness([{ id: ORCH }]);
    const { status, body } = await patch(h, [
      { key: 'TELEGRAM_PUBLIC_BASE_URL', value: 'https://x.example' },
    ]);
    assert.equal(status, 400);
    assert.equal(body.code, 'settings.no_valid_changes');
    assert.ok(
      body.errors?.some(
        (e) =>
          e.key === 'TELEGRAM_PUBLIC_BASE_URL' &&
          e.message.includes('not installed'),
      ),
    );
  });

  it('applies the valid changes in a mixed batch and skips the invalid one', async () => {
    h = await makeHarness([{ id: ORCH }]);
    const { status, body } = await patch(h, [
      { key: 'ORCHESTRATOR_MODEL', value: 'claude-opus-4-8' },
      { key: 'ORCHESTRATOR_MODEL_ROUTING', value: 'maybe' },
    ]);
    assert.equal(status, 200);
    assert.equal(
      h.registry.get(ORCH)?.config['orchestrator_model'],
      'claude-opus-4-8',
    );
    assert.ok(body.errors?.some((e) => e.key === 'ORCHESTRATOR_MODEL_ROUTING'));
  });
});
