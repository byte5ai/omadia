/**
 * #1076 (OM-102 follow-up) — re-assigning the orchestrator's `llm_provider`
 * must rebuild `@omadia/orchestrator-extras`, and it must rebuild it FIRST.
 *
 * Extras resolves its provider once per `activate()`, and its candidate chain
 * falls back to the orchestrator's assignment. Before this fix only the
 * orchestrator was reactivated, so the background memory features kept the old
 * provider until a restart.
 *
 * The order is not cosmetic. The orchestrator captures extras' `factExtractor`,
 * `contextRetriever` and `sessionBriefing` instances eagerly in its own
 * `activate()`, and nothing re-runs that capture after an extras teardown. So
 * rebuilding extras AFTER the orchestrator would leave chat-turn fact
 * extraction on the old instance. Extras first, then the orchestrator — the
 * same order as at boot.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  LlmProviderCatalog,
  clearExternalModels,
} from '@omadia/llm-provider';
import { INHERITS_PROVIDER_FROM_PLUGIN_ID } from '@omadia/orchestrator-extras';

import { InstallService } from '../src/plugins/installService.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { registerBuiltinLlmProviders } from '../src/platform/builtinLlmProviders.js';
import { LLM_PLUGINS } from '../src/platform/pluginLlmReadiness.js';
import {
  ProviderDependentRebuildError,
  applyProviderAssignment,
  isEffectiveProviderChange,
  providerDependentsOf,
  reactivateAfterProviderWrite,
} from '../src/platform/providerAssignment.js';
import type { SecretVault } from '../src/secrets/vault.js';

const ORCH = '@omadia/orchestrator';
const VERIFIER = '@omadia/verifier';
const EXTRAS = '@omadia/orchestrator-extras';

async function makeDeps(
  installed: Array<{ id: string; config?: Record<string, unknown> }>,
  opts: { throwFor?: string } = {},
) {
  const registry = new InMemoryInstalledRegistry();
  for (const p of installed) {
    await registry.register({
      id: p.id,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: p.config ?? {},
    });
  }
  clearExternalModels();
  const llmProviderCatalog = new LlmProviderCatalog();
  registerBuiltinLlmProviders(llmProviderCatalog);
  const reactivated: string[] = [];
  return {
    registry,
    reactivated,
    deps: {
      installedRegistry: registry,
      llmProviderCatalog,
      reactivate: async (id: string): Promise<void> => {
        reactivated.push(id);
        if (opts.throwFor === id) throw new Error(`${id} activation exploded`);
      },
    },
  };
}

describe('provider re-assignment rebuilds dependents (#1076)', () => {
  afterEach(() => {
    clearExternalModels();
  });

  it('rebuilds extras BEFORE the orchestrator when the orchestrator provider changes', async () => {
    const { reactivated, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: 'anthropic' } },
      { id: EXTRAS },
    ]);
    const result = await applyProviderAssignment(deps, {
      pluginId: ORCH,
      provider: 'openai',
      model: 'gpt-5.5',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(reactivated, [EXTRAS, ORCH]);
  });

  it('only rebuilds the orchestrator when extras is not installed', async () => {
    const { reactivated, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: 'anthropic' } },
    ]);
    const result = await applyProviderAssignment(deps, {
      pluginId: ORCH,
      provider: 'openai',
      model: 'gpt-5.5',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(reactivated, [ORCH]);
  });

  it('a model-only change on the same provider rebuilds only the orchestrator', async () => {
    const { reactivated, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: 'openai', orchestrator_model: 'gpt-5.5' } },
      { id: EXTRAS },
    ]);
    const result = await applyProviderAssignment(deps, {
      pluginId: ORCH,
      provider: 'openai',
      model: 'gpt-5.4-mini',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(reactivated, [ORCH]);
  });

  it('unset → explicit anthropic is not a provider change', async () => {
    const { reactivated, deps } = await makeDeps([
      { id: ORCH, config: {} },
      { id: EXTRAS },
    ]);
    const result = await applyProviderAssignment(deps, {
      pluginId: ORCH,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(reactivated, [ORCH]);
  });

  // Pins TODAY's behaviour, not the intended end state: a direct extras
  // rebuild leaves the running orchestrator on the previous extras instances.
  // That reverse direction is the open follow-up in
  // docs/middleware-agent-handoff.md §13 ("Umgekehrte Richtung").
  it('assigning extras or the verifier directly rebuilds only that plugin', async () => {
    const { reactivated, deps } = await makeDeps([
      { id: ORCH },
      { id: VERIFIER },
      { id: EXTRAS },
    ]);
    const extras = await applyProviderAssignment(deps, {
      pluginId: EXTRAS,
      provider: 'openai',
      model: 'gpt-5.4-mini',
    });
    assert.equal(extras.ok, true, JSON.stringify(extras));
    assert.deepEqual(reactivated, [EXTRAS]);

    reactivated.length = 0;
    const verifier = await applyProviderAssignment(deps, {
      pluginId: VERIFIER,
      provider: 'openai',
      model: 'gpt-5.4-mini',
    });
    assert.equal(verifier.ok, true, JSON.stringify(verifier));
    assert.deepEqual(reactivated, [VERIFIER]);
  });

  it('a dependent the production reactivate leaves errored still rebuilds the orchestrator, then reports apply_failed', async () => {
    // The REAL `InstallService.reactivate`, the function production's
    // `reactivateAgent` awaits. It never throws on an activation failure: it
    // records `markActivationFailed`, flips the entry to `errored` and
    // returns. The helper must read that status, or a failed extras rebuild
    // would leave the orchestrator without its memory services behind a 200.
    const { registry, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: 'anthropic' } },
      { id: EXTRAS },
    ]);
    const activated: string[] = [];
    const installService = new InstallService({
      catalog: {} as PluginCatalog,
      registry,
      vault: {} as SecretVault,
      onUninstall: async () => undefined,
      onInstalled: async (id: string) => {
        activated.push(id);
        if (id === EXTRAS) throw new Error('extras activate() exploded');
      },
    });
    const reactivate = async (id: string): Promise<void> => {
      await installService.reactivate(id);
    };
    const result = await applyProviderAssignment(
      { ...deps, reactivate },
      { pluginId: ORCH, provider: 'openai', model: 'gpt-5.5' },
    );
    assert.deepEqual(activated, [EXTRAS, ORCH]);
    assert.equal(registry.get(EXTRAS)?.status, 'errored');
    assert.equal(registry.get(ORCH)?.status, 'active');
    // The primary's config IS persisted; only the report says "not whole".
    assert.equal(registry.get(ORCH)?.config['llm_provider'], 'openai');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.code : undefined, 'providers.apply_failed');
    const message = result.ok === false ? result.message : '';
    assert.match(message, /@omadia\/orchestrator-extras failed to rebuild/);
    assert.match(message, /extras activate\(\) exploded/);
  });

  it('a dependent that comes back up (errored lifted by the rebuild) is not a failure', async () => {
    const { registry, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: 'anthropic' } },
      { id: EXTRAS },
    ]);
    // Extras was errored BEFORE the change (e.g. no usable provider). A
    // successful rebuild lifts that through `clearActivationError`.
    await registry.markActivationFailed(EXTRAS, 'no provider resolved');
    await registry.register({ ...registry.get(EXTRAS)!, status: 'errored' });
    const installService = new InstallService({
      catalog: {} as PluginCatalog,
      registry,
      vault: {} as SecretVault,
      onInstalled: async () => undefined,
    });
    const result = await applyProviderAssignment(
      {
        ...deps,
        reactivate: async (id: string): Promise<void> => {
          await installService.reactivate(id);
        },
      },
      { pluginId: ORCH, provider: 'openai', model: 'gpt-5.5' },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(registry.get(EXTRAS)?.status, 'active');
  });

  it('a throwing dependent still rebuilds the orchestrator, then reports apply_failed', async () => {
    const { reactivated, deps } = await makeDeps(
      [{ id: ORCH, config: { llm_provider: 'anthropic' } }, { id: EXTRAS }],
      { throwFor: EXTRAS },
    );
    const result = await applyProviderAssignment(deps, {
      pluginId: ORCH,
      provider: 'openai',
      model: 'gpt-5.5',
    });
    assert.deepEqual(reactivated, [EXTRAS, ORCH]);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.code : undefined, 'providers.apply_failed');
    assert.match(result.ok === false ? result.message : '', /orchestrator-extras activation exploded/);
  });
});

describe('providerDependentsOf / reactivateAfterProviderWrite', () => {
  it('names extras as the only dependent of the orchestrator', () => {
    assert.deepEqual(providerDependentsOf(ORCH), [EXTRAS]);
    assert.deepEqual(providerDependentsOf(EXTRAS), []);
    assert.deepEqual(providerDependentsOf(VERIFIER), []);
    assert.deepEqual(providerDependentsOf('de.byte5.agent.unrelated'), []);
  });

  it('the kernel descriptor and the extras constant name the same plugin', () => {
    const extrasDesc = LLM_PLUGINS.find((p) => p.id === EXTRAS);
    const orchDesc = LLM_PLUGINS.find((p) => p.id === ORCH);
    assert.ok(extrasDesc && orchDesc);
    assert.equal(extrasDesc.inheritsProviderFrom, INHERITS_PROVIDER_FROM_PLUGIN_ID);
    assert.equal(INHERITS_PROVIDER_FROM_PLUGIN_ID, orchDesc.id);
  });

  it('does nothing without a reactivate hook', async () => {
    const registry = new InMemoryInstalledRegistry();
    await reactivateAfterProviderWrite({ installedRegistry: registry }, ORCH, {
      providerChanged: true,
    });
  });

  it('throws a typed error naming the dependent when it is left errored', async () => {
    const registry = new InMemoryInstalledRegistry();
    for (const id of [ORCH, EXTRAS]) {
      await registry.register({
        id,
        installed_version: '0.1.0',
        installed_at: new Date().toISOString(),
        status: 'active',
        config: {},
      });
    }
    const reactivated: string[] = [];
    const reactivate = async (id: string): Promise<void> => {
      reactivated.push(id);
      // Mirror `installService.reactivate`: record, flip, never throw.
      if (id === EXTRAS) await registry.markActivationBlocked(id, 'missing llmProviderPool');
    };
    await assert.rejects(
      reactivateAfterProviderWrite({ installedRegistry: registry, reactivate }, ORCH, {
        providerChanged: true,
      }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderDependentRebuildError);
        assert.equal(err.primaryId, ORCH);
        assert.equal(err.dependentId, EXTRAS);
        assert.equal(err.primaryApplied, true);
        assert.match(err.message, /missing llmProviderPool/);
        return true;
      },
    );
    assert.deepEqual(reactivated, [EXTRAS, ORCH]);
  });

  it('a failing primary is the error it throws, even after a failing dependent', async () => {
    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: EXTRAS,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: {},
    });
    const reactivate = async (id: string): Promise<void> => {
      throw new Error(`${id} down`);
    };
    await assert.rejects(
      reactivateAfterProviderWrite({ installedRegistry: registry, reactivate }, ORCH, {
        providerChanged: true,
      }),
      /^Error: @omadia\/orchestrator down$/,
    );
  });

  it('treats an unset provider as the platform default', () => {
    assert.equal(isEffectiveProviderChange({}, { llm_provider: 'anthropic' }), false);
    assert.equal(isEffectiveProviderChange({ llm_provider: 'anthropic' }, {}), false);
    assert.equal(isEffectiveProviderChange({ llm_provider: 'openai' }, {}), true);
    assert.equal(
      isEffectiveProviderChange({ llm_provider: 'openai' }, { llm_provider: ' openai ' }),
      false,
    );
    assert.equal(isEffectiveProviderChange(undefined, { llm_provider: 'claude-cli' }), true);
  });
});
