/**
 * Spec 2042 §6 criterion 37 — the enforcement boundary, through a real
 * plugin context.
 *
 *   - a test archetype plugin makes no model call through `ctx.llm`
 *     without an execution scope, none through the raw `llm`,
 *     `anthropicClient` or provider-pool services, none past its scope's
 *     budget and none with the kill switch on;
 *   - a test capability plugin's model call through `ctx.llm` runs in the
 *     calling agent's turn: it is charged to that agent and limited by its
 *     envelope.
 *
 * The direct HTTP path to a model provider is `test/pluginEgressGuard.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { admitModelCall, isModelCallNotCovered } from '@omadia/llm-provider';
import { LlmScopeRequiredError, RawModelServiceRefusedError, ServiceNotDeclaredError } from '@omadia/plugin-api';
import type { LlmCompleteRequest, LlmCompleteResult } from '@omadia/plugin-api';
import {
  currentExecutionContext,
  meterModelCalls,
  resetModelGatewayForTests,
  runInExecutionContext,
  setModelCallHalts,
  setModelGatewayMode,
  type ModelExecutionContext,
} from '@omadia/usage-telemetry';

import type { Plugin } from '../src/api/admin-v1.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import { createPluginContext, type CreatePluginContextOptions } from '../src/platform/pluginContext.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';

afterEach(() => resetModelGatewayForTests());

const RAW_SERVICES = ['llm', 'anthropicClient', 'llmProviderPool'] as const;

function pluginOf(id: string, kind: 'archetype' | 'tool'): { plugin: Plugin; manifest: Record<string, unknown> } {
  const manifest: Record<string, unknown> = {
    schema_version: '1',
    identity: { id, name: id, version: '1.0.0', kind, domain: 'test.boundary' },
    requires: RAW_SERVICES.map((s) => `${s}@^1`),
    permissions: { llm: { models_allowed: ['*'], calls_per_invocation: 50 } },
    ...(kind === 'archetype' ? { archetype: { id: 'coach', omits: [] } } : {}),
  };
  const plugin = adaptManifestV1(manifest, () => undefined);
  assert.ok(plugin, `fixture ${id} must adapt`);
  return { plugin, manifest };
}

/** A model provider behind the gate: every backend call is counted only
 *  after the gate admitted it, like the real adapters. */
function fakeProvider(): { complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>; calls: ModelExecutionContext[] } {
  const calls: ModelExecutionContext[] = [];
  return {
    calls,
    complete(): Promise<LlmCompleteResult> {
      try {
        admitModelCall('complete');
      } catch (err) {
        return Promise.reject(err);
      }
      const context = currentExecutionContext();
      if (context) calls.push(context);
      return Promise.resolve({ text: 'ok', model: 'test', inputTokens: 1, outputTokens: 1 } as unknown as LlmCompleteResult);
    },
  };
}

function contextFor(id: string, kind: 'archetype' | 'tool') {
  const { plugin, manifest } = pluginOf(id, kind);
  const catalog = {
    get: (key: string) => (key === id ? { plugin, manifest, source_path: 'test', source_kind: 'manifest-v1', origin: 'installed' } : undefined),
    list: () => [],
    isBundledId: () => false,
  } as unknown as PluginCatalog;
  const registry = new ServiceRegistry();
  const provider = fakeProvider();
  registry.provide('llm', provider);
  registry.provide('anthropicClient', { messages: { create: () => provider.complete({} as LlmCompleteRequest) } });
  registry.provide('llmProviderPool', { complete: () => provider.complete({} as LlmCompleteRequest) });
  const stub = (): (() => void) => (): void => {};
  const ctx = createPluginContext({
    agentId: id,
    vault: { get: async (): Promise<undefined> => undefined, listKeys: async (): Promise<string[]> => [] },
    registry: { has: () => true, list: () => [], get: () => undefined },
    catalog,
    serviceRegistry: registry,
    nativeToolRegistry: { register: stub, registerHandler: stub },
    routeRegistry: { register: stub, disposeBySource: () => 0 },
    jobScheduler: { register: stub, stopForPlugin: (): void => {} },
    notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
    uiRouteCatalog: { register: stub, registerNav: stub },
    logger: (): void => {},
  } as unknown as CreatePluginContextOptions);
  return { ctx, provider };
}

const ask = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] } as unknown as LlmCompleteRequest;
const scope: ModelExecutionContext = { kind: 'execution_scope', ownerId: 'scope-1', agentSlug: 'coach-1' };

describe('criterion 37 — a test archetype plugin', () => {
  it('makes no model call through ctx.llm without an execution scope, not even inside an agent turn', async () => {
    const { ctx, provider } = contextFor('@test/archetype-coach', 'archetype');
    assert.ok(ctx.llm, 'the manifest declares permissions.llm');
    await assert.rejects(ctx.llm.complete(ask), LlmScopeRequiredError);
    await assert.rejects(
      runInExecutionContext({ kind: 'agent_turn', ownerId: 'mira', agentSlug: 'mira' }, () => ctx.llm!.complete(ask)),
      LlmScopeRequiredError,
    );
    assert.equal(provider.calls.length, 0);
  });

  it('calls in its own scoped turn: an agent turn nested in the execution scope', async () => {
    const { ctx, provider } = contextFor('@test/archetype-coach', 'archetype');
    await runInExecutionContext(scope, () =>
      runInExecutionContext({ kind: 'agent_turn', ownerId: 'coach-1', agentSlug: 'coach-1' }, () => ctx.llm!.complete(ask)),
    );
    assert.deepEqual(provider.calls.map((c) => c.kind), ['agent_turn']);
  });

  it('never gets the raw model services, declared or not, in observe and enforce', () => {
    for (const mode of ['observe', 'enforce'] as const) {
      setModelGatewayMode(mode);
      const { ctx } = contextFor('@test/archetype-coach', 'archetype');
      for (const name of RAW_SERVICES) {
        assert.throws(
          () => ctx.services.get(name),
          (err: unknown) => err instanceof RawModelServiceRefusedError || err instanceof ServiceNotDeclaredError,
          `${mode}: ${name}`,
        );
      }
    }
  });

  it('calls through its scope, and none past the scope’s budget or with the kill switch on', async () => {
    const { ctx, provider } = contextFor('@test/archetype-coach', 'archetype');
    const counted = await meterModelCalls(
      async () => {
        await ctx.llm!.complete(ask);
        await ctx.llm!.complete(ask);
        await assert.rejects(ctx.llm!.complete(ask), (err: unknown) => isModelCallNotCovered(err));
      },
      { context: scope, limit: 2 },
    );
    assert.equal(counted.modelCalls, 2);
    assert.equal(counted.refused, 1);
    assert.equal(provider.calls.length, 2);
    assert.ok(provider.calls.every((c) => c.kind === 'execution_scope'));

    setModelCallHalts({ instance: 'operator stop' });
    await assert.rejects(
      runInExecutionContext(scope, () => ctx.llm!.complete(ask)),
      (err: unknown) => isModelCallNotCovered(err),
    );
    assert.equal(provider.calls.length, 2, 'no call with the kill switch on');
  });
});

describe('criterion 37 — a test capability plugin', () => {
  it('calls in the calling agent’s turn, charged to and limited by its envelope', async () => {
    setModelGatewayMode('enforce');
    const { ctx, provider } = contextFor('@test/tool-summariser', 'tool');
    const turn: ModelExecutionContext = { kind: 'agent_turn', ownerId: 'mira', agentSlug: 'mira' };
    const counted = await meterModelCalls(
      async () => {
        await ctx.llm!.complete(ask);
        await assert.rejects(ctx.llm!.complete(ask), (err: unknown) => isModelCallNotCovered(err));
      },
      { context: turn, limit: 1 },
    );
    assert.equal(counted.modelCalls, 1);
    assert.deepEqual(provider.calls.map((c) => c.agentSlug), ['mira']);
    // Outside any agent turn the gateway refuses it.
    await assert.rejects(ctx.llm!.complete(ask), (err: unknown) => isModelCallNotCovered(err));
    // The kill switch of that agent stops it.
    setModelCallHalts({ agents: new Map([['mira', 'operator stop']]) });
    await assert.rejects(
      runInExecutionContext(turn, () => ctx.llm!.complete(ask)),
      (err: unknown) => isModelCallNotCovered(err),
    );
    assert.equal(provider.calls.length, 1);
  });
});
