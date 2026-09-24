/**
 * #1076 — the generic runtime config-write paths can write the orchestrator's
 * `llm_provider` too (it is not a secret field, so it lands in the registry
 * config). They go through the same `reactivateAfterProviderWrite` as the
 * providers admin route, so EVERY writer of that key rebuilds
 * `@omadia/orchestrator-extras` before the orchestrator.
 */
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import express from 'express';
import type { Express } from 'express';

import { createRuntimeRouter } from '../src/routes/runtime.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

const ORCH = '@omadia/orchestrator';
const EXTRAS = '@omadia/orchestrator-extras';

interface Harness {
  baseUrl: string;
  registry: InMemoryInstalledRegistry;
  reactivated: string[];
  close(): Promise<void>;
}

async function makeHarness(
  installed: Array<{ id: string; config?: Record<string, unknown> }>,
): Promise<Harness> {
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
  // The secrets route splits vault vs config by the manifest's field types.
  // Declaring `llm_provider` as a plain string routes it into the config.
  const orchEntry: PluginCatalogEntry = {
    plugin: { id: ORCH, name: 'Orchestrator', version: '0.1.0' } as never,
    manifest: {
      setup: {
        fields: [
          { key: 'llm_provider', type: 'string' },
          { key: 'anthropic_api_key', type: 'secret' },
        ],
      },
    },
    source_path: '<test>',
    source_kind: 'manifest-v1',
    origin: 'installed',
  };
  const catalog = {
    get: (id: string): PluginCatalogEntry | undefined =>
      id === ORCH ? orchEntry : undefined,
  } as unknown as PluginCatalog;

  const reactivated: string[] = [];
  const stubReg = {
    names: () => [],
    counts: () => ({ before_turn: 0, after_tool_call: 0, after_turn: 0 }),
  };
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/runtime',
    createRuntimeRouter({
      installedRegistry: registry,
      serviceRegistry: stubReg as never,
      turnHookRegistry: stubReg as never,
      backgroundJobRegistry: stubReg as never,
      chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
      promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
      vault: new InMemorySecretVault(),
      catalog,
      reactivate: async (id: string): Promise<void> => {
        reactivated.push(id);
      },
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/admin/runtime`,
    registry,
    reactivated,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function patch(url: string, body: unknown): Promise<number> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

describe('runtime config writes rebuild provider dependents (#1076)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('PATCH /installed/:id/config with a new llm_provider rebuilds extras, then the orchestrator', async () => {
    h = await makeHarness([{ id: ORCH }, { id: EXTRAS }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/config`, {
      llm_provider: 'claude-cli',
    });
    assert.equal(status, 200);
    assert.equal(h.registry.get(ORCH)?.config['llm_provider'], 'claude-cli');
    assert.deepEqual(h.reactivated, [EXTRAS, ORCH]);
  });

  it('PATCH /installed/:id/config without a provider change rebuilds only that plugin', async () => {
    h = await makeHarness([{ id: ORCH }, { id: EXTRAS }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/config`, {
      _privacy_mode: 'bypass',
    });
    assert.equal(status, 200);
    assert.deepEqual(h.reactivated, [ORCH]);
  });

  it('PATCH /installed/:id/secrets writing llm_provider into the config rebuilds extras first', async () => {
    h = await makeHarness([{ id: ORCH, config: { llm_provider: 'anthropic' } }, { id: EXTRAS }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/secrets`, {
      set: { llm_provider: 'openai' },
    });
    assert.equal(status, 200);
    assert.equal(h.registry.get(ORCH)?.config['llm_provider'], 'openai');
    assert.deepEqual(h.reactivated, [EXTRAS, ORCH]);
  });

  it('PATCH /installed/:id/secrets touching only the vault rebuilds only that plugin', async () => {
    h = await makeHarness([{ id: ORCH, config: { llm_provider: 'anthropic' } }, { id: EXTRAS }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/secrets`, {
      set: { anthropic_api_key: 'sk-ant-test' },
    });
    assert.equal(status, 200);
    assert.deepEqual(h.reactivated, [ORCH]);
  });
});
