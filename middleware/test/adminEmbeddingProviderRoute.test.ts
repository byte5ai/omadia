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
  makeCorpusPool,
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
        getKnowledgeGraph: () => ({ kind: 'graph' }),
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
  it('deactivates the old provider, activates the target and re-gates in place', async () => {
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
    //
    // INVERTED (was `reactivate:${KG_NEON}`): re-activating the knowledge
    // graph runs its `close()`, which ends the pg pool the kernel captured
    // once and shares with ~40 subsystems — so a successful switch poisoned
    // all of them until the process restarted. The gate re-evaluates itself in
    // place now, and the knowledge-graph plugin is never touched. `destructive`
    // because the operator confirmed the discard; that confirmation is the
    // only thing in the system that can hand over the capability.
    assert.deepEqual(harness.calls, [
      `deactivate:${OLLAMA}`,
      `activate:${OPENAI}`,
      'reevaluate:destructive',
    ]);
    assert.ok(
      !harness.calls.some((c) => c.startsWith('reactivate:')),
      'the knowledge-graph plugin must not be reactivated — that ends the shared pool',
    );
    assert.equal(harness.publishedBy, OPENAI);
    // The gate re-resolved the client, so the graph now embeds with the NEW
    // provider. Without this the switch reports success while the graph keeps
    // calling the previous one, silently.
    assert.equal(harness.approvedClientId, OPENAI);
    assert.equal(body['gateReevaluated'], true);
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
    // The rollback re-gates too — otherwise the graph would keep the
    // half-switched world's client. Never destructively: the target never
    // activated, so no column ever moved, and a rollback that dropped a corpus
    // would be its own incident.
    assert.ok(harness.calls.includes('reevaluate:safe'));
    assert.ok(!harness.calls.includes('reevaluate:destructive'));
    assert.equal(harness.approvedClientId, OLLAMA);
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

  it('does not claim a restore when the previous provider could not be brought back', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: OPENAI, status: 'inactive' },
      { id: KG_NEON, status: 'active' },
    ]);
    // The target cannot take over AND the outgoing one cannot be revived —
    // the deployment ends with no live provider. Reporting "the previous
    // provider was restored" over that is the failure mode being fixed.
    harness.failActivation.add(OPENAI);
    harness.failActivation.add(OLLAMA);

    const { status, body } = await harness.postSwitch({
      pluginId: OPENAI,
      confirmDiscardVectors: true,
    });
    assert.equal(status, 409);
    assert.equal(body['code'], 'embeddingProvider.target_unavailable');
    assert.match(String(body['message']), /COULD NOT BE RESTORED/);
    assert.deepEqual(body['details'], { restoredProviderId: null });
    assert.equal(harness.publishedBy, null, 'nothing is live — say so');
    // The registry must not claim an active provider that is not live, or the
    // next boot activates it into the same failure.
    assert.equal(harness.registry.get(OLLAMA)?.status, 'inactive');
    assert.equal(harness.registry.get(OPENAI)?.status, 'inactive');
  });
});

describe('POST /switch — concurrency (F6)', () => {
  it('refuses a second switch while one is in flight, so the registry keeps exactly one active provider', async () => {
    harness = await makeHarness(
      [
        { id: OLLAMA, status: 'active' },
        { id: OPENAI, status: 'inactive' },
        { id: KG_NEON, status: 'active' },
      ],
      // Hold `activate` open long enough that the second request is
      // guaranteed to arrive mid-switch rather than after it.
      { activateDelayMs: 120 },
    );
    const h = harness;

    // A→OPENAI and A→OPENAI concurrently. Interleaved, the second request used
    // to mark its target active while the first was mid-activation, and the
    // duplicate `ctx.services.provide` throw was swallowed by a rollback that
    // ALSO threw — leaving two entries at status 'active', which crashes the
    // next boot in activateAllInstalled.
    const [a, b] = await Promise.all([
      h.postSwitch({ pluginId: OPENAI, confirmDiscardVectors: true }),
      h.postSwitch({ pluginId: OPENAI, confirmDiscardVectors: true }),
    ]);

    const codes = [a, b].map((r) => String(r.body['code'] ?? 'ok')).sort();
    assert.deepEqual(
      codes,
      ['embeddingProvider.switch_in_progress', 'ok'],
      `exactly one switch may run; the other must be told, got ${codes.join(',')}`,
    );

    const active = [OLLAMA, OPENAI].filter(
      (id) => h.registry.get(id)?.status === 'active',
    );
    assert.deepEqual(active, [OPENAI], 'exactly one provider may be left active');
    assert.equal(h.publishedBy, OPENAI);
  });
});

describe('POST /switch — in-place gate re-evaluation (F7, repurposed)', () => {
  /**
   * The original F7 property was "a knowledge graph that failed to come back is
   * never reported as ok: true". The reactivation that could leave it down is
   * gone (it ended the shared pg pool), so the property moves onto the state
   * that CAN still fail: the in-place re-evaluation itself. Same strength, same
   * "this is not a rollback" reasoning, different failure.
   */
  it('reports the truth when the in-place re-gate throws', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: OPENAI, status: 'inactive' },
      { id: KG_NEON, status: 'active' },
    ]);
    harness.failGateReevaluation = true;

    const { status, body } = await harness.postSwitch({
      pluginId: OPENAI,
      confirmDiscardVectors: true,
    });

    assert.equal(status, 500, 'a gate that did not re-run is not ok: true');
    assert.equal(body['code'], 'embeddingProvider.gate_reevaluation_failed');
    assert.notEqual(body['ok'], true);
    assert.match(String(body['message']), /still governed by the PREVIOUS verdict/);
    // The provider switch itself DID take effect, so nothing is rolled back
    // and no restore may be claimed.
    assert.equal(harness.publishedBy, OPENAI);
    assert.deepEqual(body['details'], {
      switchedTo: OPENAI,
      gateReevaluated: false,
    });
    // And the graph is still embedding with the OLD client, which is exactly
    // what the 500 is telling the operator.
    assert.equal(harness.approvedClientId, OLLAMA);
  });

  it('says so, rather than implying success, when there is no re-gate to run', async () => {
    // No Postgres knowledge-graph active: the switch is a legitimate success,
    // but a different one from a switch whose vector columns were re-gated.
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: OPENAI, status: 'inactive' },
    ]);
    harness.gateReevaluatorPresent = false;

    const { status, body } = await harness.postSwitch({
      pluginId: OPENAI,
      confirmDiscardVectors: true,
    });
    assert.equal(status, 200);
    assert.equal(body['ok'], true);
    assert.equal(body['gateReevaluated'], false);
    assert.match(String(body['gateWarning']), /no gate re-evaluation entry point/);
    assert.equal(harness.publishedBy, OPENAI);
  });

  it('reports ok, and a gate that actually re-ran, on the happy path', async () => {
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
    assert.equal(body['gateReevaluated'], true);
    assert.equal(harness.approvedClientId, OPENAI);
  });
});

describe('provider drift — the registry and the verdict name different models', () => {
  // Reachable without anything failing: the generic plugin-install UI can
  // activate a different `embeddingClient@1` adapter and deliberately does NOT
  // re-run the dimension gate. Both numbers were already in the snapshot; only
  // their disagreement was silent, so an operator had to spot it by comparing
  // two fields.

  it('reports no drift while the two agree', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: KG_NEON, status: 'active' },
    ]);
    const { body } = await harness.getJson();
    assert.equal(body.activeModel?.modelId, 'ollama:nomic-embed-text');
    assert.equal(body.gate?.activeModelId, 'ollama:nomic-embed-text (768d)');
    assert.equal(
      body.providerDrift,
      null,
      'the (768d) suffix the verdict carries is formatting, not drift',
    );
  });

  it('surfaces drift when the verdict describes a model that is no longer active', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: KG_NEON, status: 'active' },
    ]);
    // The registry still publishes ollama:nomic-embed-text; the governing
    // verdict was computed against something else and nothing re-gated.
    harness.gate.activeModelId = 'openai:text-embedding-3-small (1536d)';

    const { body } = await harness.getJson();
    assert.deepEqual(body.providerDrift, {
      activeModelId: 'ollama:nomic-embed-text',
      gateModelId: 'openai:text-embedding-3-small',
    });
  });

  it('does not invent drift when the verdict names no model at all', async () => {
    harness = await makeHarness([
      { id: OLLAMA, status: 'active' },
      { id: KG_NEON, status: 'active' },
    ]);
    // `unknown-provider` publishes no `activeModelId`. Absence of evidence is
    // not evidence of drift — reporting one here would be a permanent false
    // alarm on every pre-#440 third-party adapter.
    delete (harness.gate as { activeModelId?: string }).activeModelId;

    const { body } = await harness.getJson();
    assert.equal(body.providerDrift, null);
  });
});

describe('corpus pricing uses the tenant the plugin uses (F5)', () => {
  it('prices graph_tenant_id from the knowledge-graph setup field, not GRAPH_TENANT_ID', async () => {
    const { pool, tenantsQueried } = makeCorpusPool({
      // The real corpus lives under 'acme'. 'default' is empty.
      vectorsByTenant: { acme: 42 },
    });
    harness = await makeHarness(
      [
        { id: OLLAMA, status: 'active' },
        { id: OPENAI, status: 'inactive' },
        { id: KG_NEON, status: 'active', config: { graph_tenant_id: 'acme' } },
      ],
      { graphPool: pool },
    );

    const { body } = await harness.getJson();
    assert.equal(body.graphTenantId, 'acme');
    assert.equal(
      body.storedVectorTotal,
      42,
      'GET reported 0 for a populated corpus before this fix',
    );
    assert.ok(
      tenantsQueried.every((t) => t === 'acme'),
      `every corpus read must address 'acme', saw ${tenantsQueried.join(',')}`,
    );
    const openai = body.providers.find((p) => p.pluginId === OPENAI);
    assert.equal(openai?.preview?.vectorsToDiscard, 42);
  });

  it('refuses a same-width switch that would discard the configured tenant\'s corpus', async () => {
    // Same-width target (768 → 768) with a populated 'acme' corpus. Priced
    // against 'default' the total came back 0, `destructive` computed false,
    // and the switch went through with no confirmDiscardVectors — after which
    // the gate cleared the real corpus.
    const { pool } = makeCorpusPool({ vectorsByTenant: { acme: 7 } });
    harness = await makeHarness(
      [
        { id: OLLAMA, status: 'active' },
        { id: OPENAI, status: 'inactive', config: { model: 'nomic-embed-text' } },
        { id: KG_NEON, status: 'active', config: { graph_tenant_id: 'acme' } },
      ],
      { graphPool: pool },
    );

    const { status, body } = await harness.postSwitch({ pluginId: OPENAI });
    assert.equal(status, 400);
    assert.equal(body['code'], 'embeddingProvider.confirmation_required');
    assert.deepEqual(
      (body['details'] as { vectorsToDiscard: number }).vectorsToDiscard,
      7,
    );
    assert.deepEqual(harness.calls, [], 'nothing may have been touched');
  });

  it('falls back to the env-derived tenant when the setup field is unset or blank', async () => {
    const { pool, tenantsQueried } = makeCorpusPool({ vectorsByTenant: { default: 3 } });
    harness = await makeHarness(
      [
        { id: OLLAMA, status: 'active' },
        { id: KG_NEON, status: 'active', config: { graph_tenant_id: '   ' } },
      ],
      { graphPool: pool },
    );
    const { body } = await harness.getJson();
    assert.equal(body.graphTenantId, 'default');
    assert.equal(body.storedVectorTotal, 3);
    assert.ok(tenantsQueried.every((t) => t === 'default'));
  });
});
