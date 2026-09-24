import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmProviderPool } from '@omadia/llm-provider';

import { activate } from '../packages/harness-orchestrator-extras/src/plugin.js';
import type { MemoryFeatureStatus } from '../packages/harness-orchestrator-extras/src/memoryFeatureStatus.js';

import { fakePluginContext } from './_helpers/fakePluginContext.js';

/**
 * OM-102 / #1077 — the orchestrator-extras plugin's REAL `activate()`: which
 * LLM the background memory features run on, and what it tells the dashboard
 * about them (`memoryFeatureStatus@1`).
 *
 * The candidate chain itself is unit-tested in `llmProviderResolution`'s own
 * suite; what no test covered was the wiring in `activate()` — reading the
 * orchestrator's assignment through `installedPluginConfigReader`, resolving
 * it through the kernel pool, and publishing the status the card renders. An
 * abo-only install (orchestrator on `claude-cli`, no key on this plugin) is
 * exactly the case OM-102 was about, so it is case (a).
 *
 * No `graphPool` is published, so the scratch-promotion reaper stays off with
 * `no_graph_pool` and nothing here opens a database connection or a timer.
 */

const CLI = 'claude-cli';

function kernelPoolServing(ids: readonly string[]): LlmProviderPool {
  return {
    get: async (id: string) =>
      ids.includes(id) ? ({ id } as unknown as LlmProvider) : undefined,
    usable: async (id: string) => ids.includes(id),
    invalidate: () => undefined,
    invalidateAll: () => undefined,
    cachedIds: () => [...ids],
  } as unknown as LlmProviderPool;
}

/** The kernel's cross-plugin config reader, answering for the orchestrator. */
function orchestratorAssigned(providerId: string | undefined) {
  return (agentId: string, key: string): unknown =>
    agentId === '@omadia/orchestrator' && key === 'llm_provider' ? providerId : undefined;
}

async function activateWith(services: Record<string, unknown>) {
  const fake = fakePluginContext({
    services: { knowledgeGraph: {}, ...services },
  });
  const handle = await activate(fake.ctx);
  return { ...fake, handle };
}

describe('OM-102 — orchestrator-extras activate() provider wiring', () => {
  it('runs the memory features on the orchestrator’s claude-cli via the kernel pool', async () => {
    const { provided, logs, handle } = await activateWith({
      installedPluginConfigReader: orchestratorAssigned(CLI),
      llmProviderPool: kernelPoolServing([CLI]),
      embeddingClient: {},
    });
    try {
      const status = provided.get('memoryFeatureStatus') as MemoryFeatureStatus | undefined;
      assert.deepEqual(status, {
        factExtractor: 'active',
        topicDetector: 'active',
        scratchReaper: 'disabled',
        providerId: CLI,
        reasons: { scratchReaper: 'no_graph_pool' },
      });
      // The model coercion (`coerceModelToProvider`) is deliberately not
      // asserted: without the kernel's model registration it leaves the
      // Anthropic id unchanged, so the value here would pin test setup, not
      // production behaviour.
      assert.ok(provided.has('factExtractor'), 'factExtractor@1 must be published');
      assert.ok(provided.has('topicDetector'), 'topicDetector@1 must be published');
      assert.ok(provided.has('sessionBriefing'));
      assert.ok(
        logs.some((l) => l.includes(`llmProvider=${CLI} via kernel-pool`)),
        `ready log must name the source; got: ${logs.filter((l) => l.includes('ready (')).join(' | ')}`,
      );
    } finally {
      await handle.close();
    }
  });

  it('states every feature off, and why, when no provider resolves anywhere', async () => {
    const { provided, handle } = await activateWith({
      // The orchestrator names a provider the kernel cannot build, and this
      // plugin holds no key of its own.
      installedPluginConfigReader: orchestratorAssigned(CLI),
      llmProviderPool: kernelPoolServing([]),
      embeddingClient: {},
    });
    try {
      const status = provided.get('memoryFeatureStatus') as MemoryFeatureStatus | undefined;
      assert.ok(status);
      assert.equal(status.factExtractor, 'disabled');
      assert.equal(status.topicDetector, 'disabled');
      assert.equal(status.scratchReaper, 'disabled');
      assert.equal(status.providerId, undefined);
      assert.deepEqual(status.reasons, {
        factExtractor: 'no_llm_provider',
        // The detector waits on the LLM, not the embeddings it does have.
        topicDetector: 'no_llm_provider',
        scratchReaper: 'no_graph_pool',
      });
      // The whole chain that was tried — the assignment first, then the default.
      assert.equal(status.detail, `tried: ${CLI}, anthropic`);
      assert.equal(provided.has('factExtractor'), false);
      assert.equal(provided.has('topicDetector'), false);
      // ContextRetriever does not need an LLM and stays published.
      assert.ok(provided.has('contextRetriever'));
    } finally {
      await handle.close();
    }
  });

  it('blames the missing embedding provider, not the LLM, for the topic detector', async () => {
    const { provided, handle } = await activateWith({
      installedPluginConfigReader: orchestratorAssigned(CLI),
      llmProviderPool: kernelPoolServing([CLI]),
      // no embeddingClient
    });
    try {
      const status = provided.get('memoryFeatureStatus') as MemoryFeatureStatus | undefined;
      assert.ok(status);
      assert.equal(status.factExtractor, 'active');
      assert.equal(status.topicDetector, 'disabled');
      assert.equal(status.reasons?.topicDetector, 'no_embedding_provider');
      assert.equal(status.reasons?.factExtractor, undefined);
      assert.equal(status.providerId, CLI);
      assert.equal(provided.has('topicDetector'), false);
    } finally {
      await handle.close();
    }
  });

  it('releases everything it published on close()', async () => {
    const { provided, replaced, handle } = await activateWith({
      installedPluginConfigReader: orchestratorAssigned(CLI),
      llmProviderPool: kernelPoolServing([CLI]),
      embeddingClient: {},
    });
    assert.ok(replaced.has('knowledgeGraph'), 'the capture-filter wraps the KG');
    await handle.close();
    // A reactivate (provider switch) must be able to re-publish every name.
    assert.deepEqual([...provided.keys()], []);
    assert.equal(replaced.has('knowledgeGraph'), false);
  });
});
