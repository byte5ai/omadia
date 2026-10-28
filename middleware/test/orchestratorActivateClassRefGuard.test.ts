/**
 * #1451 — the orchestrator plugin must never publish a CLASS REF as its model.
 *
 * `plugin.ts` resolved `orchestrator_model` (default `class:frontier`) against
 * the live catalog and fell through to the configured ref RAW when nothing
 * resolved, three lines under a comment promising "the turn loop only ever
 * sends a concrete vendor id". With the provider's catalog entry gone — a
 * provider plugin that had shadowed a built-in id was uninstalled — the
 * orchestrator published `model=class:balanced` and every turn came back as an
 * Anthropic 404 `model: class:balanced`.
 *
 * Seam: the real `activate()` → the published `chatAgent@1` and the model it
 * logs, which is the id the turn loop sends.
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  clearExternalModels,
  type LlmProvider,
  type LlmProviderPool,
} from '@omadia/llm-provider';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import { activate } from '../packages/harness-orchestrator/src/plugin.js';
import { registerBuiltinProvidersIntoOverlay } from './_helpers/builtinProviders.js';
import { fakePluginContext } from './_helpers/fakePluginContext.js';
import { fakeNativeToolRegistry } from './subscriptionParity/orchestratorActivateFixture.js';

const PROVIDER_ID = 'anthropic';

function fakeAnthropicPool(): LlmProviderPool {
  const provider = { id: PROVIDER_ID } as unknown as LlmProvider;
  return {
    get: async (id: string) => (id === PROVIDER_ID ? provider : undefined),
    usable: async (id: string) => id === PROVIDER_ID,
    invalidate: () => undefined,
    invalidateAll: () => undefined,
    cachedIds: () => [PROVIDER_ID],
  } as unknown as LlmProviderPool;
}

function contextFor(model: string): ReturnType<typeof fakePluginContext> {
  return fakePluginContext({
    config: { llm_provider: PROVIDER_ID, orchestrator_model: model },
    services: {
      llmProviderPool: fakeAnthropicPool(),
      knowledgeGraph: {} as KnowledgeGraph,
      memoryStore: {} as MemoryStore,
      entityRefBus: {} as EntityRefBus,
      nativeToolRegistry: fakeNativeToolRegistry(),
    },
  });
}

/** The model the plugin logged as published, from its own publish line. */
function publishedModel(logs: readonly string[]): string | undefined {
  for (const line of logs) {
    const hit = /chatAgent@1 published \(model=([^,]+),/.exec(line);
    if (hit) return hit[1];
  }
  return undefined;
}

beforeEach(() => clearExternalModels());
afterEach(() => clearExternalModels());

describe('#1451 orchestrator activate() and class refs', () => {
  it('publishes the provider concrete model for a class ref the catalog serves', async () => {
    registerBuiltinProvidersIntoOverlay();

    const { ctx, provided, logs } = contextFor('class:balanced');
    const handle = await activate(ctx);
    try {
      assert.ok(provided.get('chatAgent'), 'chatAgent@1 must be published');
      const model = publishedModel(logs);
      assert.ok(model, 'the plugin must log the model it published');
      assert.ok(!model.startsWith('class:'), `expected a concrete vendor id, got ${model}`);
    } finally {
      await handle.close();
    }
  });

  it('fails activation instead of publishing a class ref nothing can serve', async () => {
    // The #1451 state: the provider serves no model in the registry at all.
    const { ctx, provided, logs } = contextFor('class:balanced');

    await assert.rejects(
      activate(ctx),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /class:balanced/);
        assert.match(err.message, /anthropic/);
        assert.match(err.message, /orchestrator_model/);
        return true;
      },
      'activation must fail loudly, naming the setting to fix',
    );
    assert.equal(provided.get('chatAgent'), undefined, 'nothing may be published');
    assert.equal(
      publishedModel(logs),
      undefined,
      'a class ref must never reach the published model',
    );
  });
});
