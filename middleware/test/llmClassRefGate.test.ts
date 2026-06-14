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

import {
  LlmModelNotAllowedError,
  LlmServiceUnavailableError,
} from '@omadia/plugin-api';
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
  pluginPin?: string,
): Parameters<typeof createPluginContext>[0]['registry'] {
  return {
    has: () => true,
    list: () => [],
    get: (id: string) => {
      // Per-plugin pin on the caller wins over the global orchestrator default.
      if (id === 'caller' && pluginPin !== undefined) {
        return { config: { llm_provider: pluginPin } };
      }
      if (id === '@omadia/orchestrator' && provider !== undefined) {
        return { config: { llm_provider: provider } };
      }
      return undefined;
    },
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

/** Build a wired ctx for `models` whitelist with `provider` as the global
 *  default and an optional per-plugin pin on the caller. */
function makeCtx(
  models: string[],
  provider: string | undefined,
  registry: ServiceRegistry,
  pluginPin?: string,
  vault: Parameters<typeof createPluginContext>[0]['vault'] = stubVault,
) {
  const catalog = makeFakeCatalog([makePlugin('caller', models)]);
  return createPluginContext({
    agentId: 'caller',
    vault,
    registry: makeRegistry(provider, pluginPin),
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

  it('class:fast PERMITS the OpenAI fast model when openai is active (gate passes; build needs a key)', async () => {
    const fast = modelForClass('fast', 'openai');
    assert.equal(fast?.modelId, 'gpt-5.4-mini');
    // With openai active, ctx.llm is built from the vault key via the factory,
    // NOT the shared anthropic 'llm' service. The stub vault has no openai key,
    // so a PERMITTED request fails closed at provider-build with
    // ServiceUnavailable — distinct from ModelNotAllowed, which proves the gate
    // let it through. (The actual openai serving path is verified live via the
    // running stack, not in this unit test.)
    const ctx = makeCtx(['class:fast'], 'openai', registry);
    await assert.rejects(
      ctx.llm!.complete({
        model: fast!.modelId,
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmServiceUnavailableError,
    );
    assert.equal(calls.count, 0); // the fake anthropic 'llm' is never used for openai
  });

  it('class:fast does NOT leak the OTHER provider model (anthropic active rejects gpt-5.4-mini)', async () => {
    const ctx = makeCtx(['class:fast'], 'anthropic', registry);
    await assert.rejects(
      ctx.llm!.complete({
        model: 'gpt-5.4-mini',
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

  it('class:frontier permits gpt-5.5 when openai is active (gate passes; build needs a key)', async () => {
    const frontier = modelForClass('frontier', 'openai');
    assert.equal(frontier?.modelId, 'gpt-5.5');
    const ctx = makeCtx(['class:frontier'], 'openai', registry);
    await assert.rejects(
      ctx.llm!.complete({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmServiceUnavailableError,
    );
    assert.equal(calls.count, 0);
  });

  // ── Back-compat: concrete ids + wildcards gate EXACTLY as before ──────────

  it('back-compat: wildcard claude-haiku-4-5* still MATCHES at the gate regardless of active provider', async () => {
    // The gate-level back-compat: a concrete/wildcard string is matched raw
    // against the candidate, independent of the active provider. With openai
    // active the request gets PAST the gate (so it fails at provider-build with
    // ServiceUnavailable — no openai key — NOT ModelNotAllowed). Serving is now
    // provider-aware, so an openai-pinned plugin no longer borrows the anthropic
    // service; that's the intended new behavior.
    const ctx = makeCtx(['claude-haiku-4-5*'], 'openai', registry);
    await assert.rejects(
      ctx.llm!.complete({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmServiceUnavailableError,
    );
    assert.equal(calls.count, 0);
  });

  it('back-compat: wildcard claude-haiku-4-5* serves via the shared service on the Anthropic default', async () => {
    // The real back-compat case: existing installed agents on the Anthropic
    // default (no pin) keep being served by the shared 'llm' service, identical
    // to today.
    const ctx = makeCtx(['claude-haiku-4-5*'], undefined, registry);
    await ctx.llm!.complete({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
    assert.equal(calls.lastModel, 'claude-haiku-4-5-20251001');
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

  // ── Provider-aware serving + coercion + per-plugin pinning ────────────────

  it('requesting model:"class:fast" is coerced to the served Anthropic model', async () => {
    // New builder-generated plugins request a class ref as the model; under the
    // Anthropic default it is coerced to the concrete served model.
    const ctx = makeCtx(['class:fast'], undefined, registry);
    await ctx.llm!.complete({
      model: 'class:fast',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
    assert.equal(calls.lastModel, 'claude-haiku-4-5-20251001');
  });

  it('Anthropic default is served by the shared "llm" service (not the factory)', async () => {
    // The fake 'llm' provider IS used (calls.count increments) — proving the
    // env/vault-armed shared service path is untouched for the Anthropic default.
    const ctx = makeCtx(['class:frontier'], 'anthropic', registry);
    await ctx.llm!.complete({
      model: 'class:frontier',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
    assert.equal(calls.lastModel, 'claude-opus-4-8');
  });

  it('per-plugin pin to openai overrides the anthropic global default', async () => {
    // global default anthropic, but this plugin is pinned to openai → the gate
    // resolves class:fast against openai (permits gpt-5.4-mini → ServiceUnavailable
    // because the stub vault has no openai key) and rejects a claude model.
    const ctx = makeCtx(['class:fast'], undefined, registry, 'openai');
    await assert.rejects(
      ctx.llm!.complete({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmServiceUnavailableError, // gate passed; build failed (no openai key)
    );
    await assert.rejects(
      ctx.llm!.complete({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmModelNotAllowedError, // openai class:fast ≠ claude → gate rejects
    );
    assert.equal(calls.count, 0); // never falls back to the anthropic 'llm'
  });

  it('per-plugin pin to anthropic overrides an openai global default (served locally)', async () => {
    const ctx = makeCtx(['class:fast'], 'openai', registry, 'anthropic');
    await ctx.llm!.complete({
      model: 'class:fast',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(calls.count, 1);
    assert.equal(calls.lastModel, 'claude-haiku-4-5-20251001');
  });

  it('concurrent first OpenAI calls share one provider build and both succeed', async (t) => {
    let buildCalls = 0;
    const vault = {
      get: async (_agentId: string, key: string) => {
        if (key === 'provider:openai/api_key') {
          buildCalls += 1;
          return 'sk-openai';
        }
        return undefined;
      },
      list: async () => [],
    } as unknown as Parameters<typeof createPluginContext>[0]['vault'];
    t.mock.method(globalThis, 'fetch', async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl_test',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-5.4-mini',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Hallo Welt', refusal: null },
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const ctx = makeCtx(['class:fast'], 'openai', registry, undefined, vault);

    const [first, second] = await Promise.all([
      ctx.llm!.complete({
        model: 'class:fast',
        messages: [{ role: 'user', content: 'x' }],
      }),
      ctx.llm!.complete({
        model: 'class:fast',
        messages: [{ role: 'user', content: 'y' }],
      }),
    ]);

    assert.equal(first.text, 'Hallo Welt');
    assert.equal(second.text, 'Hallo Welt');
    assert.equal(buildCalls, 1);
    assert.equal(calls.count, 0);
  });
});
