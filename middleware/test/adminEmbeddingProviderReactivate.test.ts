import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import type { EmbeddingClient } from '@omadia/plugin-api';
import express from 'express';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { Agent, fetch as undiciFetch } from 'undici';

import type { EmbeddingGateStatus } from '../src/health/kgHealth.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { createAdminEmbeddingProviderRouter } from '../src/routes/adminEmbeddingProvider.js';

/**
 * OM-98 — `POST /reactivate`, the action that unblocks a subscription install.
 *
 * The dead end it removes: the ONLY path allowed to change a vector column's
 * width was an operator-confirmed provider SWITCH, and #1053 drops the surplus
 * `embeddingClient@1` provider at boot — so a deployment with 768-wide EMPTY
 * columns and the keyless 384-d adapter had no second provider to switch to
 * and nothing to confirm. It also covers the other half of the same report:
 * the adapter publishes nothing until it is re-activated after its weights
 * finish downloading.
 *
 * Standalone rather than folded into `adminEmbeddingProvider.harness.ts`: this
 * route models a SINGLE-provider install, which is the state the harness's
 * two-provider fixture cannot express.
 */

const LOCAL = '@omadia/embedding-adapter-local';
const KG_NEON = '@omadia/knowledge-graph-neon';

const LOCAL_MODEL_ID = 'local:paraphrase-multilingual-MiniLM-L12-v2';
const LOCAL_CLIENT = {
  modelId: LOCAL_MODEL_ID,
  dimensions: 384,
  embed: async () => [],
} as unknown as EmbeddingClient;

const CATALOG = [
  {
    plugin: { id: LOCAL, name: 'Embeddings (keyless)', provides: ['embeddingClient@1'] },
  },
  {
    plugin: { id: KG_NEON, name: 'Knowledge Graph (Neon)', provides: ['knowledgeGraph@1'] },
  },
];

/** Answers the three read-only queries the router makes. */
function makePool(vectors: number, declaredDimensions = 768): Pool {
  const run = (sql: string): QueryResult => {
    const rows = (r: ReadonlyArray<Record<string, unknown>>): QueryResult =>
      ({ command: '', rowCount: r.length, oid: 0, rows: [...r], fields: [] }) as unknown as QueryResult;
    if (/FROM pg_attribute/i.test(sql)) {
      return rows([
        {
          table_name: 'graph_nodes',
          column_name: 'embedding',
          declared_type: `vector(${String(declaredDimensions)})`,
          typmod: declaredDimensions,
        },
      ]);
    }
    if (/count\(\*\) AS n/i.test(sql)) return rows([{ n: String(vectors) }]);
    if (/FROM graph_embedding_model/i.test(sql)) {
      return rows([
        {
          model_id: 'ollama:nomic-embed-text',
          dimensions: declaredDimensions,
          clear_pending: false,
        },
      ]);
    }
    return rows([]);
  };
  return {
    async query(sql: string): Promise<QueryResult> {
      return run(sql);
    },
    async connect(): Promise<PoolClient> {
      return {
        async query(sql: string): Promise<QueryResult> {
          return run(sql);
        },
        release(): void {
          /* no-op */
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
}

interface ReactivateHarness {
  post(): Promise<{ status: number; body: Record<string, unknown> }>;
  registry: InMemoryInstalledRegistry;
  calls: string[];
  regateRequests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function makeHarness(opts: {
  vectors: number;
  /** Does `activate()` publish a client? False models missing weights. */
  publishesOnActivate?: boolean;
  /** Is a client published BEFORE the reactivation? */
  publishedInitially?: boolean;
  /** Registry entries. Defaults to the keyless adapter plus the KG. */
  installed?: ReadonlyArray<{ id: string; config?: Record<string, unknown> }>;
  /** Weights still missing, as the fetcher reports them. */
  missingFiles?: string[];
  gateReason?: string;
}): Promise<ReactivateHarness> {
  const registry = new InMemoryInstalledRegistry();
  for (const p of opts.installed ?? [{ id: LOCAL }, { id: KG_NEON }]) {
    await registry.register({
      id: p.id,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: p.config ?? {},
    });
  }

  const state = {
    published: opts.publishedInitially ?? false,
    calls: [] as string[],
    regateRequests: [] as Array<Record<string, unknown>>,
  };

  const gate = (): EmbeddingGateStatus => {
    const base = {
      vectorWritesAllowed: opts.gateReason === undefined,
      status: opts.gateReason === undefined ? 'match' : 'blocked',
      ...(opts.gateReason === undefined ? {} : { reason: opts.gateReason }),
      activeModelId: `${LOCAL_MODEL_ID} (384d)`,
    } as EmbeddingGateStatus;
    Object.defineProperty(base, 'reevaluate', {
      enumerable: false,
      value: async (request: Record<string, unknown>) => {
        state.regateRequests.push(request);
        return undefined;
      },
    });
    return base;
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/embedding-provider',
    createAdminEmbeddingProviderRouter({
      installedRegistry: registry,
      catalog: {
        list: () => CATALOG,
        get: (id: string) => CATALOG.find((e) => e.plugin.id === id),
      },
      getEmbeddingClient: () => (state.published ? LOCAL_CLIENT : undefined),
      getLocalModelFetcher: () => ({
        status: () => ({
          modelDir: '/tmp/embedding-models',
          missingFiles: opts.missingFiles ?? [],
          totalBytes: 0,
          job: {
            state: 'done' as const,
            downloadedBytes: 0,
            totalBytes: 0,
            currentFile: null,
            error: null,
          },
        }),
        start: () => true,
      }),
      getGateStatus: gate,
      getGraphPool: () => makePool(opts.vectors),
      tenantId: 'default',
      activate: async (id: string) => {
        state.calls.push(`activate:${id}`);
        if (opts.publishesOnActivate ?? true) state.published = true;
      },
      deactivate: async (id: string) => {
        state.calls.push(`deactivate:${id}`);
        state.published = false;
        return true;
      },
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${String(port)}/api/v1/admin/embedding-provider/reactivate`;
  const dispatcher = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });

  return {
    registry,
    get calls() {
      return state.calls;
    },
    get regateRequests() {
      return state.regateRequests;
    },
    async post() {
      const res = await undiciFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        dispatcher,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    async close() {
      await dispatcher.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('OM-98 POST /reactivate', () => {
  it('rebuilds empty columns without a provider switch', async () => {
    const h = await makeHarness({ vectors: 0, gateReason: 'column-width-mismatch' });
    try {
      const res = await h.post();
      assert.equal(res.status, 200);
      assert.equal(res.body['ok'], true);
      assert.equal(res.body['reactivated'], LOCAL);
      assert.equal(res.body['capabilityPublished'], true);
      assert.equal(res.body['gateReevaluated'], true);
      // The provider was cycled, which is what makes freshly downloaded
      // weights take effect.
      assert.deepEqual(h.calls, [`deactivate:${LOCAL}`, `activate:${LOCAL}`]);
      // The capability handover: empty-column rebuild YES, discard NO.
      assert.equal(h.regateRequests.length, 1);
      assert.equal(h.regateRequests[0]?.['allowEmptyColumnMigration'], true);
      assert.equal(h.regateRequests[0]?.['allowDestructiveMigration'], false);
    } finally {
      await h.close();
    }
  });

  it('refuses a populated corpus and touches nothing', async () => {
    const h = await makeHarness({ vectors: 42, gateReason: 'column-width-mismatch' });
    try {
      const res = await h.post();
      assert.equal(res.status, 409);
      assert.equal(res.body['code'], 'embeddingProvider.corpus_not_empty');
      // Nothing was cycled and no gate ran: the refusal is up front, so a
      // running deployment is not disturbed by a click that cannot succeed.
      assert.deepEqual(h.calls, []);
      assert.equal(h.regateRequests.length, 0);
    } finally {
      await h.close();
    }
  });

  it('writes the adapter recommendation into an unset dedup threshold', async () => {
    const h = await makeHarness({ vectors: 0 });
    try {
      const res = await h.post();
      assert.equal(res.status, 200);
      const dedup = res.body['dedupThreshold'] as Record<string, unknown>;
      assert.equal(dedup['applied'], true);
      assert.equal(dedup['value'], 0.45);
      assert.equal(
        h.registry.get(KG_NEON)?.config?.['process_dedup_threshold'],
        '0.45',
      );
    } finally {
      await h.close();
    }
  });

  it('never overwrites a threshold the operator set', async () => {
    const h = await makeHarness({
      vectors: 0,
      installed: [
        { id: LOCAL },
        { id: KG_NEON, config: { process_dedup_threshold: '0.80' } },
      ],
    });
    try {
      const res = await h.post();
      const dedup = res.body['dedupThreshold'] as Record<string, unknown>;
      assert.equal(dedup['applied'], false);
      assert.equal(dedup['reason'], 'operator-set');
      assert.equal(dedup['previous'], '0.80');
      assert.equal(
        h.registry.get(KG_NEON)?.config?.['process_dedup_threshold'],
        '0.80',
      );
    } finally {
      await h.close();
    }
  });

  it('reports honestly when the reactivation publishes nothing', async () => {
    // Weights still incomplete: the adapter comes up and stands down. The
    // route must not claim success it cannot see, and must not configure a
    // threshold for a provider that is not serving.
    const h = await makeHarness({
      vectors: 0,
      publishesOnActivate: false,
      missingFiles: ['onnx/model_quantized.onnx'],
    });
    try {
      const res = await h.post();
      assert.equal(res.status, 200);
      assert.equal(res.body['capabilityPublished'], false);
      assert.equal(res.body['dedupThreshold'], null);
      assert.equal(res.body['capabilityGap'], 'missing-weights');
    } finally {
      await h.close();
    }
  });

  it('refuses when no provider is active at all', async () => {
    const h = await makeHarness({ vectors: 0, installed: [{ id: KG_NEON }] });
    try {
      const res = await h.post();
      assert.equal(res.status, 409);
      assert.equal(res.body['code'], 'embeddingProvider.no_active_provider');
    } finally {
      await h.close();
    }
  });
});
