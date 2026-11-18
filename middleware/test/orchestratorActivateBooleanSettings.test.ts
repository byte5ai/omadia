/**
 * #1958 — the orchestrator's `boolean` setup fields arrive as real booleans.
 *
 * `ctx.config.get` hands a declared `boolean` field back as a boolean (and the
 * post-install editor has stored real booleans since #1464). The plugin read
 * `orchestrator_model_routing` as a string and called `.trim()` on it, so a
 * stored `false` threw and the whole activation failed: no orchestrator, no
 * chat. The legacy string spelling must keep working too.
 *
 * Seam: the real `activate()` with the config value as the kernel delivers it.
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

function contextWith(
  settings: Record<string, unknown>,
): ReturnType<typeof fakePluginContext> {
  return fakePluginContext({
    config: { llm_provider: PROVIDER_ID, orchestrator_model: 'class:balanced', ...settings },
    services: {
      llmProviderPool: fakeAnthropicPool(),
      knowledgeGraph: {} as KnowledgeGraph,
      memoryStore: {} as MemoryStore,
      entityRefBus: {} as EntityRefBus,
      nativeToolRegistry: fakeNativeToolRegistry(),
    },
  });
}

beforeEach(() => {
  clearExternalModels();
  registerBuiltinProvidersIntoOverlay();
});
afterEach(() => clearExternalModels());

describe('#1958 orchestrator activate() reads boolean settings of either spelling', () => {
  const cases: ReadonlyArray<{ value: unknown; routing: boolean }> = [
    { value: false, routing: false },
    { value: true, routing: true },
    { value: 'false', routing: false },
    { value: 'true', routing: true },
  ];

  for (const { value, routing } of cases) {
    it(`activates with orchestrator_model_routing = ${JSON.stringify(value)}`, async (t) => {
      const consoleLog = t.mock.method(console, 'log', () => undefined);
      const { ctx, provided } = contextWith({
        orchestrator_model_routing: value,
        orchestrator_direct_line_sticky: value,
      });
      const handle = await activate(ctx);
      try {
        assert.ok(provided.get('chatAgent'), 'chatAgent@1 must be published');
        const lines = consoleLog.mock.calls.map((c) => String(c.arguments[0]));
        assert.equal(
          lines.some((l) => l.includes('per-turn model routing ON')),
          routing,
          'model routing follows the setting',
        );
        assert.equal(
          lines.some((l) => l.includes('direct-line sticky mode ON')),
          routing,
          'sticky Direct Line follows the setting',
        );
      } finally {
        await handle.close();
      }
    });
  }
});
