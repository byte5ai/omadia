import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { Agent, fetch as undiciFetch } from 'undici';

import { createAdminEmbeddingProviderRouter } from '../src/routes/adminEmbeddingProvider.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import {
  CATALOG_ENTRIES,
  KG_NEON,
  OLLAMA,
  OPENAI,
  makeHarness,
  type Harness,
  type SnapshotResponse,
} from './adminEmbeddingProvider.harness.js';

/**
 * `/api/v1/admin/embedding-provider` — the live `embeddingClient@1` provider
 * switch (#440 follow-up).
 *
 * `getGraphPool` returns undefined throughout: no Postgres is needed to test
 * the routing, validation, confirmation gate and rollback, and the undefined
 * pool exercises the fail-closed branch (corpus size unknown ⇒ the switch
 * counts as destructive).
 *
 * Auth is NOT exercised inside the router: `requireAuth` is applied at MOUNT
 * time in production (src/index.ts), exactly like the sibling memory-purge and
 * providers routers. The dedicated test below mounts the router behind a
 * rejecting guard and asserts no route escapes it.
 */

let harness: Harness | undefined;

beforeEach(() => {
  harness = undefined;
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('GET /api/v1/admin/embedding-provider', () => {
  it('returns the installed providers, which is active, its model, the gate and the auto-migrate setting', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: OPENAI, status: 'inactive', config: { model: 'text-embedding-3-small' } },
      { id: KG_NEON, status: 'active', config: {} },
    ]);

    const { status, body } = await harness.getJson();
    assert.equal(status, 200);
    assert.deepEqual(
      body.providers.map((p) => p.pluginId),
      [OPENAI, OLLAMA].sort(),
    );
    assert.equal(body.activeProviderId, OLLAMA);
    assert.deepEqual(body.activeModel, {
      modelId: 'ollama:nomic-embed-text',
      dimensions: 768,
    });
    assert.equal(body.gate?.status, 'match');
    // Manifest default for `auto_migrate_vector_columns` is 'true'.
    assert.equal(body.autoMigrateVectorColumns, true);
    assert.equal(body.graphAvailable, false);

    const openai = body.providers.find((p) => p.pluginId === OPENAI);
    assert.equal(openai?.active, false);
    assert.equal(openai?.label, 'Embeddings (OpenAI-compatible)');
    // Preview mirrors the adapter's own resolver: known model ⇒ known width.
    assert.equal(openai?.dimensions, 1536);
    // No pool ⇒ the corpus size is unknown, which must read as unknown rather
    // than as zero.
    assert.equal(openai?.preview?.vectorsToDiscard, null);
    const ollama = body.providers.find((p) => p.pluginId === OLLAMA);
    assert.equal(ollama?.active, true);
    assert.equal(ollama?.preview, null);
  });

  it("reports auto-migrate off when the knowledge-graph config says 'false'", async () => {
    harness = await makeHarness([
      { id: OLLAMA },
      { id: KG_NEON, config: { auto_migrate_vector_columns: 'false' } },
    ]);
    const { body } = await harness.getJson();
    assert.equal(body.autoMigrateVectorColumns, false);
  });

  it('does not list a provider that is not installed', async () => {
    harness = await makeHarness([{ id: OLLAMA }]);
    const { body } = await harness.getJson();
    assert.deepEqual(
      body.providers.map((p) => p.pluginId),
      [OLLAMA],
    );
  });
});

describe('mount-time auth', () => {
  it('lets no route escape the guard applied at mount', async () => {
    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: OLLAMA,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: {},
    });
    const app: Express = express();
    app.use(express.json());
    const denyAll = (_req: Request, res: Response, _next: NextFunction): void => {
      res.status(401).json({ error: 'unauthorized' });
    };
    app.use(
      '/api/v1/admin/embedding-provider',
      denyAll,
      createAdminEmbeddingProviderRouter({
        installedRegistry: registry,
        catalog: {
          list: () => CATALOG_ENTRIES,
          get: (id: string) => CATALOG_ENTRIES.find((e) => e.plugin.id === id),
        },
        getEmbeddingClient: () => undefined,
        getGateStatus: () => undefined,
        getGraphPool: () => undefined,
        tenantId: 'default',
        activate: async () => undefined,
        deactivate: async () => true,
        reactivate: async () => undefined,
      }),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${String(port)}/api/v1/admin/embedding-provider`;
    const dispatcher = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
    try {
      assert.equal((await undiciFetch(base, { dispatcher })).status, 401);
      assert.equal(
        (
          await undiciFetch(`${base}/switch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pluginId: OPENAI, confirmDiscardVectors: true }),
            dispatcher,
          })
        ).status,
        401,
      );
    } finally {
      await dispatcher.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('POST /api/v1/admin/embedding-provider/switch', () => {
  it('deactivates the old provider, activates the target and re-gates the knowledge-graph', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: OPENAI, status: 'inactive' },
      { id: KG_NEON, status: 'active' },
    ]);

    const { status, body } = await harness.postSwitch({
      pluginId: OPENAI,
      confirmDiscardVectors: true,
    });
    assert.equal(status, 200);
    assert.equal(body['ok'], true);
    assert.equal(body['switchedTo'], OPENAI);

    // Order matters: the outgoing provider must be gone before the incoming
    // one publishes, or `ctx.services.provide` throws on the duplicate.
    assert.deepEqual(harness.calls, [
      `deactivate:${OLLAMA}`,
      `activate:${OPENAI}`,
      `reactivate:${KG_NEON}`,
    ]);
    assert.equal(harness.publishedBy, OPENAI);
    // Persisted, not just runtime: leaving both at 'active' would crash the
    // next boot with two embeddingClient@1 providers.
    assert.equal(harness.registry.get(OLLAMA)?.status, 'inactive');
    assert.equal(harness.registry.get(OPENAI)?.status, 'active');

    // The response carries the resulting gate outcome so the page can show
    // what actually happened.
    const snapshot = body as unknown as SnapshotResponse;
    assert.equal(snapshot.gate?.reason, 'vector-columns-migrated');
    assert.equal(snapshot.gate?.vectorWritesAllowed, true);
    assert.equal(snapshot.activeProviderId, OPENAI);
  });

  it('rejects a target that is not an installed embeddingClient@1 provider', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: KG_NEON, status: 'active' },
    ]);

    // Installed, but provides knowledgeGraph@1 — not an embedding provider.
    const notAProvider = await harness.postSwitch({
      pluginId: KG_NEON,
      confirmDiscardVectors: true,
    });
    assert.equal(notAProvider.status, 400);
    assert.equal(notAProvider.body['code'], 'embeddingProvider.unknown_target');

    // Declares the capability but is not installed here.
    const notInstalled = await harness.postSwitch({
      pluginId: OPENAI,
      confirmDiscardVectors: true,
    });
    assert.equal(notInstalled.status, 400);
    assert.equal(notInstalled.body['code'], 'embeddingProvider.unknown_target');

    // Pure garbage.
    const garbage = await harness.postSwitch({
      pluginId: '../../etc/passwd',
      confirmDiscardVectors: true,
    });
    assert.equal(garbage.status, 400);

    const malformed = await harness.postSwitch({ confirm: true });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body['code'], 'embeddingProvider.invalid_request');

    // Nothing was touched by any of them.
    assert.deepEqual(harness.calls, []);
    assert.equal(harness.registry.get(OLLAMA)?.status, 'active');
  });

  it('refuses a destructive switch without confirmDiscardVectors', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: OPENAI, status: 'inactive' },
      { id: KG_NEON, status: 'active' },
    ]);

    const { status, body } = await harness.postSwitch({ pluginId: OPENAI });
    assert.equal(status, 400);
    assert.equal(body['code'], 'embeddingProvider.confirmation_required');
    assert.deepEqual(harness.calls, []);
    assert.equal(harness.publishedBy, OLLAMA);
    assert.equal(harness.registry.get(OLLAMA)?.status, 'active');
    assert.equal(harness.registry.get(OPENAI)?.status, 'inactive');

    // An explicit `false` is not a confirmation either.
    const explicitFalse = await harness.postSwitch({
      pluginId: OPENAI,
      confirmDiscardVectors: false,
    });
    assert.equal(explicitFalse.status, 400);
    assert.deepEqual(harness.calls, []);
  });

  it('409s when the target is already the active provider', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: KG_NEON, status: 'active' },
    ]);
    const { status, body } = await harness.postSwitch({
      pluginId: OLLAMA,
      confirmDiscardVectors: true,
    });
    assert.equal(status, 409);
    assert.equal(body['code'], 'embeddingProvider.already_active');
    assert.deepEqual(harness.calls, []);
  });

  it('restores the previous provider when activating the target throws', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: OPENAI, status: 'inactive' },
      { id: KG_NEON, status: 'active' },
    ]);
    harness.failActivation.add(OPENAI);

    const { status, body } = await harness.postSwitch({
      pluginId: OPENAI,
      confirmDiscardVectors: true,
    });
    assert.equal(status, 409);
    assert.equal(body['code'], 'embeddingProvider.target_unavailable');

    // Back where we started: the old provider owns the capability again and
    // the registry agrees, so the next boot activates exactly one.
    assert.equal(harness.publishedBy, OLLAMA);
    assert.equal(harness.registry.get(OLLAMA)?.status, 'active');
    assert.equal(harness.registry.get(OPENAI)?.status, 'inactive');
    assert.ok(harness.calls.includes(`activate:${OLLAMA}`));
    assert.ok(harness.calls.includes(`reactivate:${KG_NEON}`));
  });

  it('restores the previous provider when the target activates but publishes no client', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: OPENAI, status: 'inactive' },
      { id: KG_NEON, status: 'active' },
    ]);
    // The OpenAI adapter with no api_key in the vault: activate() succeeds and
    // publishes nothing. Half-switching here would leave the deployment with
    // NO embedding provider at all.
    harness.publishNothing.add(OPENAI);

    const { status, body } = await harness.postSwitch({
      pluginId: OPENAI,
      confirmDiscardVectors: true,
    });
    assert.equal(status, 409);
    assert.equal(body['code'], 'embeddingProvider.target_unavailable');
    assert.match(String(body['message']), /published no embeddingClient@1/);

    assert.equal(harness.publishedBy, OLLAMA);
    assert.equal(harness.registry.get(OLLAMA)?.status, 'active');
    assert.equal(harness.registry.get(OPENAI)?.status, 'inactive');
  });
});
