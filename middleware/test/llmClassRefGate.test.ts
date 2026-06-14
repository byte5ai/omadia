/**
 * S4 — class-based LLM model whitelisting in agent manifests.
 *
 * Verifies the runtime whitelist gate (`createLlmAccessor` → `modelMatch` in
 * src/platform/pluginContext.ts) treats a provider-agnostic
 * `class:fast|balanced|frontier` whitelist entry as matching the ACTIVE
 * provider's model for that class, while concrete vendor ids and `*`-suffix
 * wildcards keep gating EXACTLY as before (back-compat).
 *
 * The active provider is read from the orchestrator's `llm_provider` config via
 * the InstalledRegistry — the same source the kernel's dynamic sub-agent wiring
 * uses (`hostProviderId()` in src/index.ts). These tests drive that path by
 * stubbing `registry.get('@omadia/orchestrator').config.llm_provider`.
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { LlmModelNotAllowedError } from '@omadia/plugin-api';
import type { LlmProvider } from '@omadia/plugin-api';
import { modelForClass } from '@omadia/llm-provider';

import type { Plugin } from '../src/api/admin-v1.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { createPluginContext } from '../src/platform/pluginContext.js';

const stubVault = {
  get: async () => undefined,
  list: async () => [],
} as unknown as Parameters<typeof createPluginContext>[0]['vault'];
const stubNativeToolRegistry = {
  register: () => () => {},
  registerHandler: () => () => {},
} as unknown as Parameters<typeof createPluginContext>[0]['nativeToolRegistry'];
const stubRouteRegistry = {
  register: () => () => {},
  disposeBySource: () => 0,
} as unknown as Parameters<typeof createPluginContext>[0]['routeRegistry'];
const stubJobScheduler = {
  register: () => () => {},
  stopForPlugin: () => {},
} as unknown as Parameters<typeof createPluginContext>[0]['jobScheduler'];

/**
 * InstalledRegistry stub whose `@omadia/orchestrator` entry carries the given
 * `llm_provider` config — mirrors how the kernel determines the active
 * provider. `provider: undefined` returns no entry, exercising the default path
 * (resolveActiveProvider falls back to 'anthropic').
 */
function makeRegistry(
  provider: string | undefined,
): Parameters<typeof createPluginContext>[0]['registry'] {
  return {
    has: () => true,
    list: () => [],
    get: (id: string) =>
      id === '@omadia/orchestrator' && provider !== undefined
        ? { config: { llm_provider: provider } }
        : undefined,
    getOrThrow: () => {
      throw new Error('not used');
    },
  } as unknown as Parameters<typeof createPluginContext>[0]['registry'];
}

function makePlugin(id: string, models: string[]): Plugin {
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
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
      llm_models_allowed: models,
    },
    integrations_summary: [],
    install_state: 'available',
    depends_on: [],
    jobs: [],
    provides: [],
    requires: [],
  } as unknown as Plugin;
}

function makeFakeCatalog(plugins: Plugin[]): PluginCatalog {
  const entries: PluginCatalogEntry[] = plugins.map((plugin) => ({
    plugin,
    manifest: {},
    source_path: `/abs/${plugin.id}/manifest.yaml`,
    source_kind: 'manifest-v1',
  })) as unknown as PluginCatalogEntry[];
  return {
    list: () => entries,
    get: (id: string) => entries.find((e) => e.plugin.id === id),
  } as unknown as PluginCatalog;
}

interface Calls {
  count: number;
  lastModel: string;
}
function makeFakeLlm(calls: Calls): LlmProvider {
  return {
    async complete(req) {
      calls.count++;
      calls.lastModel = req.model;
      return {
        text: `ok ${req.model}`,
        model: req.model,
        inputTokens: 1,
        outputTokens: 1,
        finishReason: 'stop',
        stopReason: 'end_turn',
      };
    },
  };
}

/** Build a wired ctx for `models` whitelist with `provider` active. */
function makeCtx(
  models: string[],
  provider: string | undefined,
  registry: ServiceRegistry,
) {
  const catalog = makeFakeCatalog([makePlugin('caller', models)]);
  return createPluginContext({
    agentId: 'caller',
    vault: stubVault,
    registry: makeRegistry(provider),
    catalog,
    serviceRegistry: registry,
    nativeToolRegistry: stubNativeToolRegistry,
    routeRegistry: stubRouteRegistry,
    jobScheduler: stubJobScheduler,
  });
}

describe('S4 — class-ref LLM whitelist gate', () => {
  let registry: ServiceRegistry;
  let calls: Calls;

  beforeEach(() => {
    registry = new ServiceRegistry();
    calls = { count: 0, lastModel: '' };
    registry.provide('llm', makeFakeLlm(calls));
  });

  // ── class:fast resolves against the ACTIVE provider ──────────────────────

  it('class:fast permits the Anthropic fast model on the anthropic default', async () => {
    const fast = modelForClass('fast', 'anthropic');
    assert.equal(fast?.modelId, 'claude-haiku-4-5-20251001');
    const ctx = makeCtx(['class:fast'], undefined, registry); // default → anthropic
    await ctx.llm!.complete({
      model: fast!.modelId,
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
    assert.equal(calls.lastModel, 'claude-haiku-4-5-20251001');
  });

  it('class:fast permits the provider-qualified id too (anthropic default)', async () => {
    const ctx = makeCtx(['class:fast'], 'anthropic', registry);
    await ctx.llm!.complete({
      model: 'anthropic:claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
  });

  it('class:fast permits the OpenAI fast model when openai is the active provider', async () => {
    const fast = modelForClass('fast', 'openai');
    assert.equal(fast?.modelId, 'gpt-4.1-nano');
    const ctx = makeCtx(['class:fast'], 'openai', registry);
    await ctx.llm!.complete({
      model: fast!.modelId,
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
    assert.equal(calls.lastModel, 'gpt-4.1-nano');
  });

  it('class:fast does NOT leak the OTHER provider model (anthropic active rejects gpt-4.1-nano)', async () => {
    const ctx = makeCtx(['class:fast'], 'anthropic', registry);
    await assert.rejects(
      ctx.llm!.complete({
        model: 'gpt-4.1-nano',
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmModelNotAllowedError,
    );
    assert.equal(calls.count, 0);
  });

  it('class:fast rejects a non-fast model on the active provider (claude-opus under anthropic)', async () => {
    const ctx = makeCtx(['class:fast'], 'anthropic', registry);
    await assert.rejects(
      ctx.llm!.complete({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmModelNotAllowedError,
    );
    assert.equal(calls.count, 0);
  });

  it('class:frontier resolves to claude-opus under the anthropic default', async () => {
    const frontier = modelForClass('frontier', 'anthropic');
    assert.equal(frontier?.modelId, 'claude-opus-4-8');
    const ctx = makeCtx(['class:frontier'], undefined, registry); // default → anthropic
    await ctx.llm!.complete({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
    assert.equal(calls.lastModel, 'claude-opus-4-8');
    // frontier must not admit the fast model
    await assert.rejects(
      ctx.llm!.complete({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmModelNotAllowedError,
    );
  });

  it('class:frontier resolves to gpt-4.1 when openai is active', async () => {
    const frontier = modelForClass('frontier', 'openai');
    assert.equal(frontier?.modelId, 'gpt-4.1');
    const ctx = makeCtx(['class:frontier'], 'openai', registry);
    await ctx.llm!.complete({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
  });

  // ── Back-compat: concrete ids + wildcards gate EXACTLY as before ──────────

  it('back-compat: wildcard claude-haiku-4-5* matches the dated id, regardless of active provider', async () => {
    // Even with openai active, a concrete/wildcard string is matched raw —
    // an existing installed agent behaves identically to today.
    const ctx = makeCtx(['claude-haiku-4-5*'], 'openai', registry);
    await ctx.llm!.complete({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
  });

  it('back-compat: wildcard claude-haiku-4-5* still rejects a non-matching id', async () => {
    const ctx = makeCtx(['claude-haiku-4-5*'], undefined, registry);
    await assert.rejects(
      ctx.llm!.complete({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmModelNotAllowedError,
    );
    assert.equal(calls.count, 0);
  });

  it('back-compat: exact concrete id matches only exactly', async () => {
    const ctx = makeCtx(['claude-sonnet-4-6'], undefined, registry);
    await ctx.llm!.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
    await assert.rejects(
      ctx.llm!.complete({
        model: 'claude-sonnet-4-6-20251001',
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmModelNotAllowedError,
    );
  });

  it('mixed whitelist: class:fast + a concrete id both work under anthropic default', async () => {
    const ctx = makeCtx(['class:fast', 'claude-opus-4-8'], undefined, registry);
    await ctx.llm!.complete({
      model: 'claude-haiku-4-5-20251001', // via class:fast
      messages: [{ role: 'user', content: 'x' }],
    });
    await ctx.llm!.complete({
      model: 'claude-opus-4-8', // via concrete id
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 2);
  });
});
