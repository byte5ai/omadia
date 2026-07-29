/**
 * Shared harness for the `/api/v1/admin/embedding-provider` route tests.
 *
 * Extracted so the spec file stays about behaviour. Same convention as
 * `devplatform/devPlatformRoutes.harness.ts` — the `.harness.ts` suffix keeps
 * it out of the test-file glob the runner uses.
 *
 * It models the runtime the way it actually behaves: `activate(id)` publishes
 * that plugin's client into a SINGLE capability slot and `deactivate(id)`
 * withdraws it, so "the target activated but published nothing" (unconfigured
 * adapter) and "activation threw" are both expressible — those are the two
 * rollback paths the switch must survive.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { EmbeddingClient } from '@omadia/plugin-api';
import express from 'express';
import type { Express } from 'express';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

import { createAdminEmbeddingProviderRouter } from '../src/routes/adminEmbeddingProvider.js';
import type { EmbeddingGateStatus } from '../src/health/kgHealth.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';

export const OLLAMA = '@omadia/embeddings';
export const OPENAI = '@omadia/embedding-adapter-openai';
export const KG_NEON = '@omadia/knowledge-graph-neon';

const CLIENTS: Readonly<Record<string, EmbeddingClient>> = {
  [OLLAMA]: {
    modelId: 'ollama:nomic-embed-text',
    dimensions: 768,
    embed: async () => [],
  } as EmbeddingClient,
  [OPENAI]: {
    modelId: 'openai:text-embedding-3-small',
    dimensions: 1536,
    embed: async () => [],
  } as EmbeddingClient,
};

interface CatalogEntry {
  plugin: { id: string; name: string; provides: readonly string[] };
}

export const CATALOG_ENTRIES: readonly CatalogEntry[] = [
  {
    plugin: {
      id: OLLAMA,
      name: 'Embeddings (Ollama)',
      provides: ['embeddingClient@1'],
    },
  },
  {
    plugin: {
      id: OPENAI,
      name: 'Embeddings (OpenAI-compatible)',
      provides: ['embeddingClient@1'],
    },
  },
  {
    plugin: {
      id: KG_NEON,
      name: 'Knowledge Graph (Neon)',
      // A malformed entry alongside a valid one — the loader tolerates it, so
      // the router must too rather than dropping the whole plugin.
      provides: ['knowledgeGraph@1', 'not a capability ref'],
    },
  },
];

/**
 * A `Pool` that answers the three read-only queries the router makes and
 * RECORDS the tenant parameter of every one of them.
 *
 * That parameter is the whole point: the confirmation gate prices the switch
 * off `countVectors(… tenantId)`, so a router that asks for the wrong tenant
 * reports an empty corpus for a populated one and lets a destructive switch
 * through unconfirmed. Only a fake can assert on the parameter itself.
 */
export function makeCorpusPool(opts: {
  /** Vectors per tenant. Any tenant not listed reads as empty. */
  vectorsByTenant: Readonly<Record<string, number>>;
  declaredDimensions?: number;
}): { pool: Pool; tenantsQueried: string[] } {
  const tenantsQueried: string[] = [];
  const dims = opts.declaredDimensions ?? 768;

  const run = (sql: string, params?: ReadonlyArray<unknown>): QueryResult => {
    const rows = (r: ReadonlyArray<Record<string, unknown>>): QueryResult =>
      ({ command: '', rowCount: r.length, oid: 0, rows: [...r], fields: [] }) as unknown as QueryResult;
    if (/FROM pg_attribute/i.test(sql)) {
      return rows([
        {
          table_name: 'graph_nodes',
          column_name: 'embedding',
          declared_type: `vector(${String(dims)})`,
          typmod: dims,
        },
      ]);
    }
    if (/count\(\*\) AS n/i.test(sql)) {
      const tenant = String(params?.[0] ?? '');
      tenantsQueried.push(tenant);
      return rows([{ n: String(opts.vectorsByTenant[tenant] ?? 0) }]);
    }
    if (/FROM graph_embedding_model/i.test(sql)) {
      const tenant = String(params?.[0] ?? '');
      tenantsQueried.push(tenant);
      return rows([
        { model_id: 'ollama:nomic-embed-text', dimensions: dims, clear_pending: false },
      ]);
    }
    return rows([]);
  };

  const pool = {
    async query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
      return run(sql, params);
    },
    async connect(): Promise<PoolClient> {
      return {
        async query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
          return run(sql, params);
        },
        release(): void {
          /* no-op */
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;

  return { pool, tenantsQueried };
}

export interface Harness {
  server: Server;
  baseUrl: string;
  /** This harness's OWN connection pool — never the process-global one. */
  dispatcher: Agent;
  getJson(): Promise<{ status: number; body: SnapshotResponse }>;
  postSwitch(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  registry: InMemoryInstalledRegistry;
  /** Which plugin currently owns the single `embeddingClient@1` slot. */
  publishedBy: string | null;
  calls: string[];
  /** Plugin ids whose `activate()` should throw. */
  failActivation: Set<string>;
  /** Plugin ids that activate successfully but publish no client. */
  publishNothing: Set<string>;
  /**
   * Plugin ids whose `reactivate()` fails. Modelled the way
   * `installService.reactivate` actually behaves: the hook error is swallowed
   * and the promise RESOLVES, leaving the plugin's services withdrawn.
   */
  failReactivate: Set<string>;
  /** Is the `knowledgeGraph` service currently resolvable? */
  knowledgeGraphLive: boolean;
  gate: EmbeddingGateStatus;
  close(): Promise<void>;
}

export async function makeHarness(
  installed: ReadonlyArray<{
    id: string;
    status?: 'active' | 'inactive';
    config?: Record<string, unknown>;
  }>,
  wiring: { graphPool?: Pool; activateDelayMs?: number } = {},
): Promise<Harness> {
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

  const state = {
    publishedBy: null as string | null,
    calls: [] as string[],
    failActivation: new Set<string>(),
    publishNothing: new Set<string>(),
    failReactivate: new Set<string>(),
    knowledgeGraphLive: true,
    gate: {
      vectorWritesAllowed: true,
      status: 'match',
      activeModelId: 'ollama:nomic-embed-text (768d)',
    } as EmbeddingGateStatus,
  };
  // Seed the slot from whichever provider the registry marks active.
  const initiallyActive = installed.find(
    (p) => (p.status ?? 'active') === 'active' && p.id in CLIENTS,
  );
  state.publishedBy = initiallyActive?.id ?? null;

  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/embedding-provider',
    createAdminEmbeddingProviderRouter({
      installedRegistry: registry,
      catalog: {
        list: () => CATALOG_ENTRIES,
        get: (id: string) => CATALOG_ENTRIES.find((e) => e.plugin.id === id),
      },
      getEmbeddingClient: () =>
        state.publishedBy === null ? undefined : CLIENTS[state.publishedBy],
      getGateStatus: () => state.gate,
      getGraphPool: () => wiring.graphPool,
      getKnowledgeGraph: () => (state.knowledgeGraphLive ? { kind: 'graph' } : undefined),
      tenantId: 'default',
      activate: async (id: string) => {
        state.calls.push(`activate:${id}`);
        // Lets a concurrency test guarantee the two switches actually overlap
        // instead of relying on express scheduling.
        if (wiring.activateDelayMs !== undefined) {
          await new Promise((r) => setTimeout(r, wiring.activateDelayMs));
        }
        if (state.failActivation.has(id)) {
          throw new Error(`boom activating ${id}`);
        }
        if (!state.publishNothing.has(id) && id in CLIENTS) {
          state.publishedBy = id;
        }
      },
      deactivate: async (id: string) => {
        state.calls.push(`deactivate:${id}`);
        if (state.publishedBy === id) state.publishedBy = null;
        return true;
      },
      reactivate: async (id: string) => {
        state.calls.push(`reactivate:${id}`);
        if (state.failReactivate.has(id)) {
          // installService.reactivate logs the hook failure and RESOLVES; the
          // plugin's services are gone but the caller sees a clean promise.
          if (id === KG_NEON) state.knowledgeGraphLive = false;
          return;
        }
        if (id === KG_NEON && state.publishedBy !== null) {
          const client = CLIENTS[state.publishedBy];
          state.gate = {
            vectorWritesAllowed: true,
            status: 'column-migrated',
            reason: 'vector-columns-migrated',
            activeModelId: `${client?.modelId ?? '?'} (${String(
              (client as { dimensions?: number } | undefined)?.dimensions ?? 0,
            )}d)`,
            detail: 'graph_nodes.embedding vector(768)→vector(1536) were rewritten at runtime',
          };
        }
      },
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${String(port)}/api/v1/admin/embedding-provider`;
  // A pool scoped to this harness. The process-global fetch dispatcher keeps
  // sockets alive past `server.close()`, so a later request could be written
  // onto a socket whose server is already gone (UND_ERR_SOCKET
  // "other side closed", or a 300s headersTimeout hang). Owning the pool lets
  // `close()` destroy it deterministically.
  const dispatcher = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
  return {
    server,
    baseUrl,
    dispatcher,
    getJson: () => getJson(baseUrl, dispatcher),
    postSwitch: (body: unknown) => postSwitch(baseUrl, body, dispatcher),
    registry,
    get publishedBy() {
      return state.publishedBy;
    },
    get calls() {
      return state.calls;
    },
    get failActivation() {
      return state.failActivation;
    },
    get publishNothing() {
      return state.publishNothing;
    },
    get failReactivate() {
      return state.failReactivate;
    },
    get knowledgeGraphLive() {
      return state.knowledgeGraphLive;
    },
    get gate() {
      return state.gate;
    },
    async close() {
      // Order matters: drop the client pool first, then force any socket the
      // server still holds, then wait for the listener to actually go away.
      await dispatcher.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  } as Harness;
}

export interface SnapshotResponse {
  providers: Array<{
    pluginId: string;
    label: string;
    active: boolean;
    registryStatus: string | null;
    modelId: string | null;
    dimensions: number | null;
    preview: { widthChange: boolean | null; vectorsToDiscard: number | null } | null;
  }>;
  activeProviderId: string | null;
  activeModel: { modelId: string; dimensions: number } | null;
  gate: EmbeddingGateStatus | null;
  autoMigrateVectorColumns: boolean;
  graphAvailable: boolean;
  graphTenantId: string;
  storedVectorTotal: number | null;
  switchedTo?: string;
}

export async function getJson(
  url: string,
  dispatcher: Dispatcher,
): Promise<{ status: number; body: SnapshotResponse }> {
  const res = await undiciFetch(url, { dispatcher });
  return { status: res.status, body: (await res.json()) as SnapshotResponse };
}

export async function postSwitch(
  baseUrl: string,
  body: unknown,
  dispatcher: Dispatcher,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await undiciFetch(`${baseUrl}/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    dispatcher,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
