import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  registerExternalModels,
  type LlmProvider,
  type LlmProviderPool,
  type LlmRequest,
  type LlmResponse,
} from '@omadia/llm-provider';

import { activate } from '../packages/harness-orchestrator-extras/src/plugin.js';
import type { MemoryFeatureStatus } from '../packages/harness-orchestrator-extras/src/memoryFeatureStatus.js';

import { BUILTIN_LLM_PROVIDERS } from '../src/platform/builtinLlmProviders.js';

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
 *
 * The model half (`coerceModel`: the Anthropic default/configured refs turned
 * into the provider's same-class model) needs the model catalog the kernel
 * registers at boot. The model suite registers the SHIPPED anthropic +
 * claude-cli descriptors through the public `registerExternalModels` overlay
 * (the same seam `llmProviderModelOverlay.test.ts` uses) and disposes them
 * afterwards, then watches the model id that reaches the provider's
 * `complete()` through the published capture filter's significance scorer.
 */

const CLI = 'claude-cli';

function kernelPoolServing(
  ids: readonly string[],
  complete?: (req: LlmRequest) => Promise<LlmResponse>,
): LlmProviderPool {
  return {
    get: async (id: string) =>
      ids.includes(id) ? ({ id, ...(complete ? { complete } : {}) } as unknown as LlmProvider) : undefined,
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

async function activateWith(
  services: Record<string, unknown>,
  config: Record<string, unknown> = {},
) {
  const fake = fakePluginContext({
    config,
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
      // The model half is pinned in the suite below, with the catalog loaded.
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

  it('blames the missing LLM, not the embeddings, when both are missing', async () => {
    const { provided, handle } = await activateWith({
      installedPluginConfigReader: orchestratorAssigned(CLI),
      llmProviderPool: kernelPoolServing([]),
      // no embeddingClient either
    });
    try {
      const status = provided.get('memoryFeatureStatus') as MemoryFeatureStatus | undefined;
      assert.ok(status);
      assert.equal(status.reasons?.factExtractor, 'no_llm_provider');
      // The LLM guard is the one that disabled the detector first.
      assert.equal(status.reasons?.topicDetector, 'no_llm_provider');
      assert.equal(provided.has('topicDetector'), false);
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

/** The shipped model catalog of the providers this suite runs on. */
function shippedModels(...providerIds: readonly string[]) {
  return BUILTIN_LLM_PROVIDERS.filter((p) => providerIds.includes(p.id)).flatMap((p) => p.models ?? []);
}

interface CaptureFilterLike {
  classify(input: { userMessage: string; assistantAnswer: string }): Promise<unknown>;
}

describe('OM-102 — orchestrator-extras activate() model wiring', () => {
  /** Activates on claude-cli and returns the model the scorer sends. */
  async function modelSentWith(config: Record<string, unknown>) {
    const dispose = registerExternalModels(shippedModels('anthropic', CLI));
    const models: string[] = [];
    const complete = async (req: LlmRequest): Promise<LlmResponse> => {
      models.push(req.model);
      return {
        content: [{ type: 'text', text: '{"score":0.9,"entry_type":"memory"}' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as unknown as LlmResponse;
    };
    try {
      const { provided, logs, handle } = await activateWith(
        {
          installedPluginConfigReader: orchestratorAssigned(CLI),
          llmProviderPool: kernelPoolServing([CLI], complete),
          embeddingClient: {},
        },
        config,
      );
      try {
        const filter = provided.get('captureFilter') as CaptureFilterLike | undefined;
        assert.ok(filter, 'captureFilter must be published');
        await filter.classify({
          userMessage: 'We moved the release to Friday.',
          assistantAnswer: 'Noted, the release is on Friday now.',
        });
        return { models, logs };
      } finally {
        await handle.close();
      }
    } finally {
      dispose();
    }
  }

  const coercionLogs = (logs: readonly string[]) => logs.filter((l) => l.includes('is not served by provider'));

  it('runs the default Anthropic haiku ref as claude-cli’s haiku-cli, silently', async () => {
    const { models, logs } = await modelSentWith({});
    assert.deepEqual(models, ['haiku-cli']);
    // Coercing the DEFAULT ref is not the operator's business.
    assert.deepEqual(coercionLogs(logs), []);
  });

  it('coerces an operator-typed Anthropic model and says so for each key', async () => {
    const { models, logs } = await modelSentWith({
      fact_extractor_model: 'claude-haiku-4-5-20251001',
      topic_classifier_model: ' claude-haiku-4-5-20251001 ',
    });
    assert.deepEqual(models, ['haiku-cli']);
    assert.deepEqual(coercionLogs(logs), [
      "[harness-orchestrator-extras] fact_extractor_model='claude-haiku-4-5-20251001' is not served by provider 'claude-cli' — using its same-class model 'haiku-cli'",
      "[harness-orchestrator-extras] topic_classifier_model='claude-haiku-4-5-20251001' is not served by provider 'claude-cli' — using its same-class model 'haiku-cli'",
    ]);
    assert.equal(logs.some((l) => l.includes('WARNING')), false, logs.join('\n'));
  });

  it('keeps a model the provider already serves, and a class other than fast', async () => {
    const { models, logs } = await modelSentWith({ fact_extractor_model: 'claude-opus-5' });
    // Frontier stays frontier on the new provider.
    assert.deepEqual(models, ['opus-cli']);
    assert.equal(coercionLogs(logs).length, 1, logs.join('\n'));

    const served = await modelSentWith({ fact_extractor_model: 'sonnet-cli' });
    assert.deepEqual(served.models, ['sonnet-cli']);
    assert.deepEqual(coercionLogs(served.logs), []);
  });
});
