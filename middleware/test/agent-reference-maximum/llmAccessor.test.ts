import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import {
  LlmBudgetExceededError,
  LlmModelNotAllowedError,
  LlmServiceUnavailableError,
} from '@omadia/plugin-api';
import type { LlmProvider } from '@omadia/plugin-api';

import type { Plugin } from '../../src/api/admin-v1.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../../src/plugins/manifestLoader.js';
import { ServiceRegistry } from '../../src/platform/serviceRegistry.js';
import { createPluginContext } from '../../src/platform/pluginContext.js';

const stubVault = {
  get: async () => undefined,
  list: async () => [],
} as unknown as Parameters<typeof createPluginContext>[0]['vault'];
const stubInstalledRegistry = {
  has: () => true,
  get: () => undefined,
  list: () => [],
  getOrThrow: () => {
    throw new Error('not used');
  },
} as unknown as Parameters<typeof createPluginContext>[0]['registry'];
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

function makePlugin(
  id: string,
  llm: {
    llm_models_allowed?: string[];
    llm_calls_per_invocation?: number;
    llm_max_tokens_per_call?: number;
  } = {},
): Plugin {
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
    required_secrets: [],
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
      ...llm,
    },
    integrations_summary: [],
    install_state: 'available',
    depends_on: [],
    jobs: [],
    provides: [],
    requires: [],
  };
}

function makeFakeCatalog(plugins: Plugin[]): PluginCatalog {
  const entries: PluginCatalogEntry[] = plugins.map((plugin) => ({
    plugin,
    manifest: {},
    source_path: `/abs/${plugin.id}/manifest.yaml`,
    source_kind: 'manifest-v1',
  }));
  return {
    list: () => entries,
    get: (id: string) => entries.find((e) => e.plugin.id === id),
  } as unknown as PluginCatalog;
}

interface LlmCalls {
  count: number;
  lastModel: string;
  lastMaxTokens: number | undefined;
}

function makeFakeLlm(calls: LlmCalls): LlmProvider {
  return {
    async complete(req) {
      calls.count++;
      calls.lastModel = req.model;
      calls.lastMaxTokens = req.maxTokens;
      return {
        text: `fake-response for ${req.model}`,
        model: req.model,
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end_turn',
      };
    },
  };
}

describe('agent-reference / LlmAccessor (OB-29-3)', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  it('ctx.llm is undefined when manifest has no models_allowed', () => {
    const catalog = makeFakeCatalog([makePlugin('plain', {})]);
    const ctx = createPluginContext({
      agentId: 'plain',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    assert.equal(ctx.llm, undefined);
  });

  it('complete passes through allowed model to provider', async () => {
    const calls: LlmCalls = { count: 0, lastModel: '', lastMaxTokens: undefined };
    registry.provide('llm', makeFakeLlm(calls));
    const catalog = makeFakeCatalog([
      makePlugin('caller', { llm_models_allowed: ['claude-haiku-4-5*'] }),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    assert.ok(ctx.llm);
    const r = await ctx.llm!.complete({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.text, 'fake-response for claude-haiku-4-5-20251001');
    assert.equal(calls.count, 1);
  });

  it('rejects model not in whitelist', async () => {
    const calls: LlmCalls = { count: 0, lastModel: '', lastMaxTokens: undefined };
    registry.provide('llm', makeFakeLlm(calls));
    const catalog = makeFakeCatalog([
      makePlugin('caller', { llm_models_allowed: ['claude-haiku-4-5*'] }),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    await assert.rejects(
      ctx.llm!.complete({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      LlmModelNotAllowedError,
    );
    assert.equal(calls.count, 0);
  });

  it('throws LlmServiceUnavailableError when no provider is registered', async () => {
    const catalog = makeFakeCatalog([
      makePlugin('caller', { llm_models_allowed: ['claude-haiku-4-5*'] }),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    await assert.rejects(
      ctx.llm!.complete({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      LlmServiceUnavailableError,
    );
  });

  it('enforces calls_per_invocation budget', async () => {
    const calls: LlmCalls = { count: 0, lastModel: '', lastMaxTokens: undefined };
    registry.provide('llm', makeFakeLlm(calls));
    const catalog = makeFakeCatalog([
      makePlugin('caller', {
        llm_models_allowed: ['claude-haiku-4-5'],
        llm_calls_per_invocation: 2,
      }),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    await ctx.llm!.complete({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'a' }],
    });
    await ctx.llm!.complete({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'b' }],
    });
    await assert.rejects(
      ctx.llm!.complete({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'c' }],
      }),
      LlmBudgetExceededError,
    );
  });

  it('clamps maxTokens to manifest cap (silent)', async () => {
    const calls: LlmCalls = { count: 0, lastModel: '', lastMaxTokens: undefined };
    registry.provide('llm', makeFakeLlm(calls));
    const catalog = makeFakeCatalog([
      makePlugin('caller', {
        llm_models_allowed: ['claude-haiku-4-5'],
        llm_max_tokens_per_call: 512,
      }),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    await ctx.llm!.complete({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 99_999, // way above the 512 cap
    });
    assert.equal(calls.lastMaxTokens, 512);
  });

  it('exact (non-wildcard) model matches', async () => {
    const calls: LlmCalls = { count: 0, lastModel: '', lastMaxTokens: undefined };
    registry.provide('llm', makeFakeLlm(calls));
    const catalog = makeFakeCatalog([
      makePlugin('caller', { llm_models_allowed: ['claude-sonnet-4-6'] }),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    await ctx.llm!.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'x' }],
    });
    await assert.rejects(
      ctx.llm!.complete({
        model: 'claude-sonnet-4-6-20251001',
        messages: [{ role: 'user', content: 'x' }],
      }),
      LlmModelNotAllowedError,
    );
  });

  it('modelsAllowed exposes manifest declaration', () => {
    const calls: LlmCalls = { count: 0, lastModel: '', lastMaxTokens: undefined };
    registry.provide('llm', makeFakeLlm(calls));
    const catalog = makeFakeCatalog([
      makePlugin('caller', {
        llm_models_allowed: ['claude-haiku-4-5*', 'claude-sonnet-4-6'],
      }),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    assert.deepEqual([...ctx.llm!.modelsAllowed], [
      'claude-haiku-4-5*',
      'claude-sonnet-4-6',
    ]);
  });
});
