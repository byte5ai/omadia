/**
 * #1359 — after a restart the orchestrator ran on the seed's frontier model
 * (`claude-opus-5`) instead of the discovered default (`claude-opus-5-5`): the
 * plugins activate on the built-in seed, and the fire-and-forget boot
 * discovery lands a fraction of a second later. A discovery run that moves a
 * class default now rebuilds the LLM plugins that resolved a class ref
 * against the older catalog.
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  LlmAdapterRegistryImpl,
  LlmProviderCatalog,
  clearExternalModels,
  resolveConfiguredModel,
  type LlmProviderDescriptor,
} from '@omadia/llm-provider';

import {
  createClassDefaultRebuilder,
  type ClassDefaultRebuilder,
} from '../src/platform/classDefaultRebuild.js';
import { createModelCatalogSync } from '../src/platform/modelCatalogSync.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';

const ORCH = '@omadia/orchestrator';
const VERIFIER = '@omadia/verifier';
const EXTRAS = '@omadia/orchestrator-extras';

const SEED: LlmProviderDescriptor = {
  id: 'anthropic',
  label: 'Anthropic',
  wireFormat: 'anthropic',
  baseURL: 'https://api.anthropic.com',
  models: [
    {
      id: 'anthropic:claude-opus-5',
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      label: 'Claude Opus 5',
      class: 'frontier',
      maxTokens: 32_000,
      contextWindow: 200_000,
      vision: true,
    },
    {
      id: 'anthropic:claude-haiku-4-5-20251001',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5',
      class: 'fast',
      maxTokens: 8_192,
      contextWindow: 200_000,
      vision: true,
    },
  ],
  discovery: {
    include: ['^claude-'],
    classify: [
      { match: '^claude-opus-', class: 'frontier' },
      { match: '^claude-haiku-', class: 'fast' },
    ],
  },
};

async function installed(
  plugins: Array<{ id: string; config?: Record<string, unknown> }>,
): Promise<InMemoryInstalledRegistry> {
  const registry = new InMemoryInstalledRegistry();
  for (const p of plugins) {
    await registry.register({
      id: p.id,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: p.config ?? {},
    });
  }
  return registry;
}

function recordingRebuilder(
  registry: InMemoryInstalledRegistry,
  ready: Promise<void> = Promise.resolve(),
): { rebuilder: ClassDefaultRebuilder; reactivated: string[] } {
  const reactivated: string[] = [];
  const rebuilder = createClassDefaultRebuilder({
    installedRegistry: registry,
    ready,
    log: () => undefined,
    reactivate: async (id) => {
      reactivated.push(id);
    },
  });
  return { rebuilder, reactivated };
}

function gate(): { ready: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const ready = new Promise<void>((r) => {
    release = r;
  });
  return { ready, release };
}

describe('class-default rebuild (#1359)', () => {
  let catalog: LlmProviderCatalog;
  beforeEach(() => {
    clearExternalModels();
    catalog = new LlmProviderCatalog();
    catalog.register(SEED);
  });
  afterEach(() => {
    catalog.clear();
    clearExternalModels();
  });

  it('boot: the orchestrator built on the seed is rebuilt on the discovered frontier default', async () => {
    const registry = await installed([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    // Stands in for the orchestrator plugin's activate(): resolve its default
    // `class:frontier` against the catalog as it is NOW.
    let orchestratorModel: string | undefined;
    const reactivated: string[] = [];
    const rebuilder = createClassDefaultRebuilder({
      installedRegistry: registry,
      ready: Promise.resolve(),
      log: () => undefined,
      reactivate: async (id) => {
        reactivated.push(id);
        activate(id);
      },
    });
    // `onActivating` stamps before the plugin's activate() reads the catalog.
    function activate(id: string): void {
      rebuilder.noteActivated(id);
      if (id === ORCH) orchestratorModel = resolveConfiguredModel('class:frontier', 'anthropic');
    }
    for (const id of [EXTRAS, VERIFIER, ORCH]) activate(id);
    assert.equal(orchestratorModel, 'claude-opus-5', 'boot activation sees the seed');

    // The boot discovery run lands after activation.
    const adapters = new LlmAdapterRegistryImpl();
    adapters.register({
      wireFormat: 'anthropic',
      build: () => {
        throw new Error('not used');
      },
      listModels: async () => [
        { modelId: 'claude-opus-5', label: 'Claude Opus 5', createdAt: '2026-08-01T00:00:00Z' },
        { modelId: 'claude-opus-5-5', label: 'Claude Opus 5.5', createdAt: '2026-10-01T00:00:00Z' },
        { modelId: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      ],
    });
    let pending: Promise<string[]> | undefined;
    const sync = createModelCatalogSync({
      catalog,
      adapters,
      getSecret: async (k) => (k === 'provider:anthropic/api_key' ? 'sk-ant-test' : undefined),
      log: () => undefined,
      warn: () => undefined,
      onDefaultsChanged: (id) => {
        pending = rebuilder.onDefaultsChanged(id);
      },
    });
    await sync.refresh('anthropic');
    assert.ok(pending, 'the discovery run reported a class-default change');
    // Extras and the verifier default to concrete vendor ids: left alone.
    assert.deepEqual(await pending, [ORCH]);
    assert.deepEqual(reactivated, [ORCH]);
    assert.equal(orchestratorModel, 'claude-opus-5-5');
  });

  it('a plugin that activated AFTER the change is not rebuilt', async () => {
    const registry = await installed([{ id: ORCH }]);
    const { ready, release } = gate();
    const { rebuilder, reactivated } = recordingRebuilder(registry, ready);
    // Discovery finishes first (before the boot wiring); the orchestrator
    // activates afterwards, on the already-discovered catalog.
    const pending = rebuilder.onDefaultsChanged('anthropic');
    rebuilder.noteActivated(ORCH);
    release();
    assert.deepEqual(await pending, []);
    assert.deepEqual(reactivated, []);
  });

  it('a discovery run landing WHILE the plugin activates still rebuilds it (stamped at start)', async () => {
    const registry = await installed([{ id: ORCH }]);
    const { rebuilder, reactivated } = recordingRebuilder(registry);
    rebuilder.noteActivated(ORCH); // onActivating: activate() starts on the seed
    const pending = rebuilder.onDefaultsChanged('anthropic'); // lands mid-activation
    // activate() finishes here; nothing re-stamps on completion.
    assert.deepEqual(await pending, [ORCH]);
    assert.deepEqual(reactivated, [ORCH]);
  });

  it('serializes overlapping runs and rebuilds a plugin once when a previous run already did', async () => {
    const registry = await installed([{ id: ORCH }]);
    const reactivated: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const rebuilder: ClassDefaultRebuilder = createClassDefaultRebuilder({
      installedRegistry: registry,
      ready: Promise.resolve(),
      log: () => undefined,
      reactivate: async (id) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        rebuilder.noteActivated(id); // the real activation stamps itself
        await new Promise((r) => setImmediate(r));
        reactivated.push(id);
        inFlight -= 1;
      },
    });
    rebuilder.noteActivated(ORCH);
    const [a, b] = await Promise.all([
      rebuilder.onDefaultsChanged('anthropic'),
      rebuilder.onDefaultsChanged('anthropic'),
    ]);
    assert.deepEqual(a, [ORCH]);
    assert.deepEqual(b, [], 'the second run sees the rebuild the first one did');
    assert.deepEqual(reactivated, [ORCH]);
    assert.equal(maxInFlight, 1);
  });

  it('waits for the boot wiring before it rebuilds anything', async () => {
    const registry = await installed([{ id: ORCH }]);
    const { ready, release } = gate();
    const { rebuilder, reactivated } = recordingRebuilder(registry, ready);
    rebuilder.noteActivated(ORCH);
    const pending = rebuilder.onDefaultsChanged('anthropic');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(reactivated, [], 'nothing before ready');
    release();
    assert.deepEqual(await pending, [ORCH]);
  });

  it('skips a concrete model, another provider, and a plugin that never activated', async () => {
    const registry = await installed([
      { id: ORCH, config: { orchestrator_model: 'claude-opus-5' } },
      { id: VERIFIER, config: { llm_provider: 'openai', verifier_model: 'class:fast' } },
      { id: EXTRAS, config: { fact_extractor_model: 'class:fast' } },
    ]);
    const { rebuilder, reactivated } = recordingRebuilder(registry);
    rebuilder.noteActivated(ORCH);
    rebuilder.noteActivated(VERIFIER);
    assert.deepEqual(await rebuilder.onDefaultsChanged('anthropic'), []);
    assert.deepEqual(reactivated, []);
  });

  it('a rebuild that leaves the plugin errored is reported, not counted as done', async () => {
    const registry = await installed([{ id: ORCH }]);
    const logs: string[] = [];
    const rebuilder = createClassDefaultRebuilder({
      installedRegistry: registry,
      ready: Promise.resolve(),
      log: (m) => logs.push(m),
      // Like `InstallService.reactivate`: no throw, the entry flips to errored.
      reactivate: async (id) => {
        await registry.markActivationFailed(id, 'activate() exploded');
        const entry = registry.get(id);
        if (entry) await registry.register({ ...entry, status: 'errored' });
      },
    });
    rebuilder.noteActivated(ORCH);
    assert.deepEqual(await rebuilder.onDefaultsChanged('anthropic'), []);
    assert.match(logs.join('\n'), /left it errored: activate\(\) exploded/);
  });

  it('a class-ref extras inheriting the orchestrator provider is rebuilt before the orchestrator', async () => {
    const registry = await installed([
      { id: ORCH, config: { llm_provider: 'openai', orchestrator_model: 'gpt-5.5' } },
      { id: EXTRAS, config: { fact_extractor_model: 'class:fast' } },
    ]);
    const { rebuilder, reactivated } = recordingRebuilder(registry);
    rebuilder.noteActivated(ORCH);
    rebuilder.noteActivated(EXTRAS);
    // Extras runs on openai (inherited). The orchestrator is pinned to a
    // concrete id but captures extras, so it is rebuilt after it.
    assert.deepEqual(await rebuilder.onDefaultsChanged('openai'), [EXTRAS, ORCH]);
    assert.deepEqual(reactivated, [EXTRAS, ORCH]);
  });
});
