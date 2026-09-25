import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import {
  createAnthropicClient,
  createAnthropicProvider,
} from '@omadia/llm-adapter-anthropic';
import type { LlmProviderPool } from '@omadia/llm-provider';
import type { EntityRefBus, PluginContext } from '@omadia/plugin-api';

import { InMemoryMemoryStore } from '../packages/harness-memory/src/inMemoryMemoryStore.js';
import { InMemoryKnowledgeGraph } from '../packages/harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.js';
import { CaptureFilter } from '../packages/harness-orchestrator-extras/src/captureFilter.js';
import { CaptureFilteringKnowledgeGraph } from '../packages/harness-orchestrator-extras/src/captureFilteringKnowledgeGraph.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  activate,
  LLM_PROVIDER_POOL_SERVICE,
  type ChatAgentBundle,
  type OrchestratorPluginHandle,
} from '../packages/harness-orchestrator/src/plugin.js';
import {
  RunTraceOutcomeStats,
  RUN_TRACE_STATS_SERVICE,
} from '../packages/harness-orchestrator/src/runTraceObservability.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { createAdminRouter } from '../src/routes/admin.js';

/**
 * #1082 — the PUBLISH pin. `adminRunTraceRoute.test.ts` drives the route with a
 * hand-held tally and `buildOrchestrator.test.ts` pins that every built Agent
 * shares `deps.runTraceStats`; neither notices when the orchestrator plugin
 * stops publishing that tally. The route would then answer 503 forever, with
 * every other test green. So here the REAL `activate()` runs against a real
 * `ServiceRegistry`, and the admin route is wired exactly as `src/index.ts`
 * wires it: per request, through the registry.
 */

const TOKEN = 'test-admin-token';
const services = new ServiceRegistry();
let handle: OrchestratorPluginHandle;
let server: Server;
let base: string;

/** The kernel services `activate()` hard-requires, plus a pool that hands out
 *  a provider without a vault. The knowledge graph sits behind the capture
 *  decorator (what `@omadia/orchestrator-extras` installs in production) and
 *  scores every turn below the threshold, so each logged turn is tail-only. */
function provideKernelServices(): void {
  const provider = createAnthropicProvider({
    client: createAnthropicClient({ apiKey: 'test-key' }),
  });
  const pool = { get: async () => provider } as unknown as LlmProviderPool;
  services.provide(LLM_PROVIDER_POOL_SERVICE, pool);
  const filter = new CaptureFilter({
    captureLevel: 'normal',
    defaultVisibility: 'team',
    significanceThreshold: 0.2,
    significanceScorer: { score: async () => ({ score: 0 }) },
    log: () => {},
  });
  services.provide(
    'knowledgeGraph',
    new CaptureFilteringKnowledgeGraph({
      inner: new InMemoryKnowledgeGraph(),
      filter,
      log: () => {},
    }),
  );
  services.provide('memoryStore', new InMemoryMemoryStore());
  services.provide('entityRefBus', {} as EntityRefBus);
  services.provide('nativeToolRegistry', new NativeToolRegistry());
}

function pluginContext(): PluginContext {
  return {
    log: () => {},
    config: { get: () => undefined },
    secrets: { get: async () => undefined },
    services: {
      get: <T>(name: string): T | undefined => services.get<T>(name),
      getOptional: <T>(name: string): T | undefined => services.get<T>(name),
      provide: <T>(name: string, impl: T): (() => void) =>
        services.provide(name, impl, '@omadia/orchestrator'),
    },
  } as unknown as PluginContext;
}

const getRunTrace = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${base}/admin/run-trace`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

before(async () => {
  provideKernelServices();
  const app = express();
  app.use(express.json());
  app.use(
    '/admin',
    createAdminRouter({
      token: TOKEN,
      store: {} as never, // this route touches no store
      runTraceStats: () => services.get<RunTraceOutcomeStats>(RUN_TRACE_STATS_SERVICE),
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await handle?.close();
  server.close();
});

describe('#1082 orchestrator publishes its run-trace tally', () => {
  it('the route answers 503 until the orchestrator is active', async () => {
    const { status } = await getRunTrace();
    assert.equal(status, 503);
  });

  it('activate() publishes the tally its Agent loggers count into', async () => {
    handle = await activate(pluginContext());

    const published = services.get<RunTraceOutcomeStats>(RUN_TRACE_STATS_SERVICE);
    assert.ok(
      published instanceof RunTraceOutcomeStats,
      `activate() must provide "${RUN_TRACE_STATS_SERVICE}" — without it GET /api/admin/run-trace is permanently 503`,
    );
    const bundle = services.get<ChatAgentBundle>('chatAgent');
    assert.ok(bundle, 'activate() must publish chatAgent@1 for this test to mean anything');
    assert.equal(
      bundle.sessionLogger.runTraceStats,
      published,
      'the published tally must be the instance the default Agent logs into',
    );

    await bundle.sessionLogger.log({
      scope: 'sess-1082-publish',
      userMessage: 'ok',
      assistantAnswer: 'ok',
      time: '2026-09-25T10:00:00.000Z',
    });

    const { status, body } = await getRunTrace();
    assert.equal(status, 200);
    assert.equal(body['captureTailOnlyTurns'], 1);
    assert.equal(body['droppedTotal'], 0);
  });

  it('deactivation withdraws the tally, so a reactivation starts from zero', async () => {
    await handle.close();
    assert.equal(services.get(RUN_TRACE_STATS_SERVICE), undefined);
    assert.equal((await getRunTrace()).status, 503);

    handle = await activate(pluginContext());
    const { status, body } = await getRunTrace();
    assert.equal(status, 200);
    assert.equal(body['captureTailOnlyTurns'], 0);
  });
});
