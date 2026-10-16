import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import { createProviderHealth } from '@omadia/llm-provider';
import { turnContext } from '@omadia/orchestrator';
import type { LlmProvider as PluginLlmProvider } from '@omadia/plugin-api';
import {
  flushUsageRecorder,
  initUsageRecorder,
  recordUsage,
  setUsageContextProvider,
} from '@omadia/usage-telemetry';
import type { Pool } from 'pg';

import { completeWithFallback, streamMessageEvents } from '../../packages/harness-orchestrator/src/streaming.js';
import { usageContextFromTurn } from '../../packages/harness-orchestrator/src/turnContext.js';
import type { Plugin } from '../../src/api/admin-v1.js';
import { BuilderAgent } from '../../src/plugins/builder/builderAgent.js';
import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { createPreviewLlmAccessor } from '../../src/plugins/builder/previewRuntime.js';
import { SpecEventBus } from '../../src/plugins/builder/specEventBus.js';
import type { PluginCatalog, PluginCatalogEntry } from '../../src/plugins/manifestLoader.js';
import { createPluginContext } from '../../src/platform/pluginContext.js';
import { ServiceRegistry } from '../../src/platform/serviceRegistry.js';
import { noopSlotTypechecker } from '../builder/fixtures/noopSlotTypechecker.js';

/**
 * #1390 / #1392 — LLM calls the cost ledger used to miss or could not attribute:
 *   - the orchestrator's buffered path (`completeWithFallback`, behind
 *     `runTurn()`: routines, scheduled runs, `ChatAgent.chat()`) wrote no row;
 *   - plugin `ctx.llm` calls only logged their token counts;
 *   - builder turns ran without a turn scope, so their rows had NULL
 *     `turn_id`/`session_id`.
 * Rows are captured at the recorder's INSERT, the same seam the dashboard reads.
 */

interface CapturedQuery {
  readonly params: readonly unknown[];
}

const captured: CapturedQuery[] = [];
initUsageRecorder({
  query: (_sql: string, params: readonly unknown[]) => {
    captured.push({ params });
    return Promise.resolve({ rows: [] });
  },
} as unknown as Pool);

/** Column order of the INSERT in `recorder.ts`. */
const COL = { source: 0, model: 1, inputTokens: 2, cacheCreationTokens: 5, sessionId: 8, turnId: 10, provider: 11 };
const COLS = 13;

async function flushedRows(): Promise<(readonly unknown[])[]> {
  await flushUsageRecorder();
  return captured.flatMap((q) => {
    const rows: (readonly unknown[])[] = [];
    for (let i = 0; i < q.params.length; i += COLS) rows.push(q.params.slice(i, i + COLS));
    return rows;
  });
}

afterEach(() => {
  setUsageContextProvider(undefined);
  captured.length = 0;
});

const CAPS = {
  tools: true,
  vision: false,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: false,
  parallelToolCalls: false,
} as const;

function respondingProvider(id: string): LlmProvider {
  return {
    id,
    capabilities: CAPS,
    complete: async (req: LlmRequest): Promise<LlmResponse> => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: req.model,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 40 },
    }),
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function rateLimitedProvider(id: string): LlmProvider {
  const err = Object.assign(new Error(`${id} rate_limit`), { status: 429 });
  return {
    id,
    capabilities: CAPS,
    complete: async () => {
      throw err;
    },
    stream: () => {
      throw err;
    },
    classifyError: () => ({ retryable: true, kind: 'rate_limit' as const }),
  } as unknown as LlmProvider;
}

const req = (model: string): LlmRequest => ({ model, maxTokens: 16, messages: [] });

describe('#1390 — the buffered orchestrator path writes a ledger row', () => {
  it('writes one orchestrator row per successful complete(), with cache writes', async () => {
    setUsageContextProvider(() => ({ turnId: 'turn-r', sessionId: 'routine:abc' }));
    await completeWithFallback({
      provider: respondingProvider('anthropic'),
      request: req('claude-sonnet-5-5'),
      streamLabel: 'orchestrator',
    });

    const rows = await flushedRows();
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row?.[COL.source], 'orchestrator');
    assert.equal(row?.[COL.model], 'claude-sonnet-5-5');
    assert.equal(row?.[COL.provider], 'anthropic');
    assert.equal(row?.[COL.inputTokens], 100);
    assert.equal(row?.[COL.cacheCreationTokens], 40);
    assert.equal(row?.[COL.turnId], 'turn-r');
    assert.equal(row?.[COL.sessionId], 'routine:abc');
  });

  it("records a fallback hop under the fallback's provider and model, and only that", async () => {
    await completeWithFallback({
      provider: rateLimitedProvider('anthropic'),
      request: req('claude-sonnet-5-5'),
      fallback: { provider: respondingProvider('openai'), request: req('gpt-5.4') },
      streamLabel: 'orchestrator',
    });

    const rows = await flushedRows();
    assert.equal(rows.length, 1, 'the failed primary call produced no usage');
    assert.equal(rows[0]?.[COL.provider], 'openai');
    assert.equal(rows[0]?.[COL.model], 'gpt-5.4');
  });

  it('records a cooldown completion on the fallback too', async () => {
    const health = createProviderHealth({ now: () => 0 });
    health.markFailed('anthropic', 'auth');
    await completeWithFallback({
      provider: respondingProvider('anthropic'),
      request: req('claude-sonnet-5-5'),
      fallback: { provider: respondingProvider('openai'), request: req('gpt-5.4'), health },
      streamLabel: 'orchestrator',
    });

    const rows = await flushedRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.[COL.provider], 'openai');
  });

  it('skips claude-cli on the streamed path too (its adapter writes the row)', async () => {
    const cli = {
      ...respondingProvider('claude-cli'),
      stream: (r: LlmRequest) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'final',
            response: {
              content: [{ type: 'text', text: 'ok' }],
              finishReason: 'stop',
              model: r.model,
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        },
      }),
    } as unknown as LlmProvider;
    for await (const _ev of streamMessageEvents({
      provider: cli,
      params: { model: 'sonnet', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] },
      observer: undefined,
      iteration: 0,
      streamLabel: 'sub-agent x',
    })) {
      // drain
    }
    assert.equal((await flushedRows()).length, 0);
  });

  it('skips a provider that records its own rows (claude-cli), so nothing is counted twice', async () => {
    await completeWithFallback({
      provider: respondingProvider('claude-cli'),
      request: req('sonnet'),
      streamLabel: 'orchestrator',
    });
    assert.equal((await flushedRows()).length, 0);
  });
});

function pluginWithLlm(id: string): Plugin {
  return {
    id,
    kind: 'agent',
    name: id,
    version: '0.1.0',
    latest_version: '0.1.0',
    description: '',
    authors: [],
    license: 'Proprietary',
    icon_url: null,
    categories: [],
    domain: 'test',
    compat_core: '>=1.0 <2.0',
    signed: false,
    signed_by: null,
    setup_fields: [],
    integrations_summary: [],
    install_state: 'available',
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
      llm_models_allowed: ['claude-haiku-4-5*'],
    },
    depends_on: [],
    jobs: [],
    provides: [],
    requires: [],
  } as unknown as Plugin;
}

function pluginCtx(services: ServiceRegistry, globalProvider?: string) {
  const entries = [
    { plugin: pluginWithLlm('acme-classifier'), manifest: {}, source_path: '/x', source_kind: 'manifest-v1', origin: 'installed' },
  ] as unknown as PluginCatalogEntry[];
  const catalog = {
    list: () => entries,
    get: (id: string) => entries.find((e) => e.plugin.id === id),
  } as unknown as PluginCatalog;
  const stub = <T>(v: unknown): T => v as T;
  type Opts = Parameters<typeof createPluginContext>[0];
  return createPluginContext({
    agentId: 'acme-classifier',
    vault: stub<Opts['vault']>({ get: async () => undefined, list: async () => [] }),
    registry: stub<Opts['registry']>({
      has: () => true,
      list: () => [],
      get: (id: string) =>
        id === '@omadia/orchestrator' && globalProvider
          ? { config: { llm_provider: globalProvider } }
          : undefined,
    }),
    catalog,
    serviceRegistry: services,
    nativeToolRegistry: stub<Opts['nativeToolRegistry']>({ register: () => () => {}, registerHandler: () => () => {} }),
    routeRegistry: stub<Opts['routeRegistry']>({ register: () => () => {}, disposeBySource: () => 0 }),
    jobScheduler: stub<Opts['jobScheduler']>({ register: () => () => {}, stopForPlugin: () => {} }),
  } as unknown as Opts);
}

const fakeLlm: PluginLlmProvider = {
  async complete(r) {
    return {
      text: 'yes',
      model: r.model,
      inputTokens: 120,
      outputTokens: 4,
      finishReason: 'stop',
      stopReason: 'end_turn',
    };
  },
};

describe('#1390 — plugin ctx.llm calls write a ledger row', () => {
  it("writes one row sourced 'plugin <id>' on the serving provider", async () => {
    const services = new ServiceRegistry();
    services.provide('llm', fakeLlm);
    setUsageContextProvider(() => ({ turnId: 'turn-c', sessionId: 'sess-c' }));

    const ctx = pluginCtx(services);
    await ctx.llm!.complete({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'classify' }],
    });

    const rows = await flushedRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.[COL.source], 'plugin acme-classifier');
    assert.equal(rows[0]?.[COL.model], 'claude-haiku-4-5-20251001');
    assert.equal(rows[0]?.[COL.provider], 'anthropic');
    assert.equal(rows[0]?.[COL.inputTokens], 120);
    assert.equal(rows[0]?.[COL.turnId], 'turn-c');
  });

  it('writes nothing for a refused call (model outside the whitelist)', async () => {
    const services = new ServiceRegistry();
    services.provide('llm', fakeLlm);
    const ctx = pluginCtx(services);
    await assert.rejects(
      ctx.llm!.complete({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'x' }] }),
    );
    assert.equal((await flushedRows()).length, 0);
  });
});

describe('#1390 — builder preview ctx.llm calls write a ledger row', () => {
  it("writes one row sourced 'plugin <id> (preview)' on the host's Anthropic service", async () => {
    const llm = createPreviewLlmAccessor({
      agentId: 'draft-agent',
      config: { modelsAllowed: ['claude-haiku-4-5-20251001'], callsPerInvocation: 5, maxTokensPerCall: 256 },
      provider: fakeLlm as unknown as Parameters<typeof createPreviewLlmAccessor>[0]['provider'],
      log: () => {},
    });
    await llm.complete({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'x' }] });

    const rows = await flushedRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.[COL.source], 'plugin draft-agent (preview)');
    assert.equal(rows[0]?.[COL.provider], 'anthropic');
  });
});

describe('#1392 — builder turns carry turn_id and session_id', () => {
  it('stamps every sub-agent row of a turn with its turnId and builder:<draftId>', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'builder-usage-'));
    const referenceRoot = path.join(tmpRoot, 'reference');
    mkdirSync(referenceRoot, { recursive: true });
    const draftStore = new DraftStore({ dbPath: path.join(tmpRoot, 'drafts.db') });
    await draftStore.open();
    try {
      const draft = await draftStore.create('tester@example.com', 'Usage Draft');
      // The real provider the orchestrator plugin registers, minus its module:
      // `usageContextFromTurn` over the turn scope the builder opens.
      setUsageContextProvider(() =>
        usageContextFromTurn(turnContext.current() as Parameters<typeof usageContextFromTurn>[0]),
      );

      const agent = new BuilderAgent({
        resolveProvider: async () => ({ provider: {} as never, modelId: 'claude-haiku-4-5-20251001' }),
        draftStore,
        bus: new SpecEventBus(),
        rebuildScheduler: { schedule() {} },
        catalogToolNames: () => [],
        knownPluginIds: () => [],
        slotTypechecker: noopSlotTypechecker,
        referenceCatalog: { 'seo-analyst': { root: referenceRoot, description: 'test' } },
        systemPromptSeed: async () => 'TEST-SEED',
        templateRoot: referenceRoot,
        tools: [],
        // Stands in for LocalSubAgent: two streamed iterations, each writing
        // its row the way `streamMessageEvents` does.
        buildSubAgent: (opts) => ({
          async ask(): Promise<string> {
            for (let i = 0; i < 2; i += 1) {
              recordUsage({
                source: `sub-agent ${opts.name}`,
                model: 'claude-haiku-4-5-20251001',
                inputTokens: 10,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              });
              await new Promise((resolve) => setImmediate(resolve));
            }
            return 'done';
          },
        }),
      });

      for await (const _ev of agent.runTurn({
        draftId: draft.id,
        userEmail: 'tester@example.com',
        userMessage: 'hello',
        modelChoice: 'claude-haiku-4-5-20251001',
        turnId: 'builder-turn-1',
      })) {
        // drain
      }

      const rows = await flushedRows();
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row[COL.source], `sub-agent builder-${draft.id}`);
        assert.equal(row[COL.turnId], 'builder-turn-1');
        assert.equal(row[COL.sessionId], `builder:${draft.id}`);
      }
      // The scope ends with the turn: nothing leaks into the caller.
      assert.equal(turnContext.current(), undefined);
    } finally {
      await draftStore.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
