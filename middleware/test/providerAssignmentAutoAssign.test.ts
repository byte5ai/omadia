/**
 * OM-79 (#994) — subscription-login hand-off.
 *
 * After a successful `claude auth login`, everything needed to run the
 * orchestrator on the subscription already exists except the assignment:
 * `llm_provider` still points at `anthropic`, the orchestrator asks the vault
 * for a key, finds none and never publishes chatAgent@1. `autoAssignSubscriptionCli`
 * flips that assignment to the CLI provider — but ONLY where there is nothing to
 * lose: the plugin still sits on the platform default (`llm_provider` unset or
 * `anthropic`) AND that default has no credential. An explicit operator choice
 * is never overridden, credential or not; a plugin already on the CLI is left
 * alone (idempotent); a failing reactivate is reported, not thrown.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  LlmProviderCatalog,
  clearExternalModels,
  providerApiKeyVaultKey,
} from '@omadia/llm-provider';

import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';
import { registerBuiltinLlmProviders } from '../src/platform/builtinLlmProviders.js';
import {
  autoAssignSubscriptionCli,
  SUBSCRIPTION_CLI_PROVIDER,
  defaultSubscriptionCliModel,
} from '../src/platform/providerAssignment.js';

const ORCH = '@omadia/orchestrator';
const VERIFIER = '@omadia/verifier';
const EXTRAS = '@omadia/orchestrator-extras';

async function makeDeps(
  installed: Array<{ id: string; config?: Record<string, unknown> }>,
  opts: { reactivateThrows?: boolean } = {},
) {
  const vault = new InMemorySecretVault();
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
    vault,
    registry,
    reactivated,
    deps: {
      installedRegistry: registry,
      vault,
      llmProviderCatalog,
      reactivate: async (id: string) => {
        if (opts.reactivateThrows) throw new Error('activation exploded');
        reactivated.push(id);
      },
    },
  };
}

describe('autoAssignSubscriptionCli (OM-79)', () => {
  afterEach(() => {
    clearExternalModels();
  });

  it('assigns the CLI when the orchestrator sits on the default provider without a credential', async () => {
    const { registry, reactivated, deps } = await makeDeps([
      { id: ORCH, config: {} }, // llm_provider unset → default anthropic, no key
    ]);

    const outcome = await autoAssignSubscriptionCli(deps);

    assert.deepEqual(outcome.assigned, [ORCH]);
    const cfg = registry.get(ORCH)?.config ?? {};
    assert.equal(cfg['llm_provider'], SUBSCRIPTION_CLI_PROVIDER);
    const model = defaultSubscriptionCliModel();
    assert.ok(model, 'expected a default CLI model to exist');
    assert.equal(cfg['orchestrator_model'], model.modelId);
    // Per-turn model routing must be forced off for a non-Anthropic provider.
    assert.equal(cfg['orchestrator_model_routing'], 'false');
    assert.deepEqual(reactivated, [ORCH]);
  });

  it('also assigns when llm_provider is explicitly the default (anthropic) without a key', async () => {
    const { registry, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: 'anthropic' } },
    ]);
    const outcome = await autoAssignSubscriptionCli(deps);
    assert.deepEqual(outcome.assigned, [ORCH]);
    assert.equal(registry.get(ORCH)?.config?.['llm_provider'], SUBSCRIPTION_CLI_PROVIDER);
  });

  it('does NOT override the default provider when an API key is stored', async () => {
    const { vault, registry, reactivated, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: 'anthropic' } },
    ]);
    // A present key makes the verification `unverified` (not `no_key`), which
    // counts as "has a credential the operator chose" — leave it alone.
    await vault.setMany(ORCH, {
      [providerApiKeyVaultKey('anthropic')]: 'sk-ant-test-key',
    });

    const outcome = await autoAssignSubscriptionCli(deps);

    assert.deepEqual(outcome.assigned, []);
    assert.equal(registry.get(ORCH)?.config?.['llm_provider'], 'anthropic');
    assert.equal(reactivated.length, 0);
    assert.ok(
      outcome.skipped.some(
        (s) => s.pluginId === ORCH && s.reason.startsWith('provider_has_credential:'),
      ),
    );
  });

  it('leaves an explicit non-default provider alone even when it has no key', async () => {
    const { registry, reactivated, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: 'openai' } }, // chosen, no key
    ]);

    const outcome = await autoAssignSubscriptionCli(deps);

    assert.deepEqual(outcome.assigned, []);
    assert.equal(registry.get(ORCH)?.config?.['llm_provider'], 'openai');
    assert.equal(reactivated.length, 0);
    assert.ok(
      outcome.skipped.some((s) => s.pluginId === ORCH && s.reason === 'explicit_provider:openai'),
    );
  });

  it('leaves an OAuth-connected provider alone', async () => {
    const { registry, reactivated, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: 'openai-chatgpt' } },
    ]);
    const outcome = await autoAssignSubscriptionCli(deps);
    assert.deepEqual(outcome.assigned, []);
    assert.equal(registry.get(ORCH)?.config?.['llm_provider'], 'openai-chatgpt');
    assert.equal(reactivated.length, 0);
  });

  it('leaves a keyless local provider alone', async () => {
    const { registry, reactivated, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: 'local-ollama' } },
    ]);
    const outcome = await autoAssignSubscriptionCli(deps);
    assert.deepEqual(outcome.assigned, []);
    assert.equal(registry.get(ORCH)?.config?.['llm_provider'], 'local-ollama');
    assert.equal(reactivated.length, 0);
  });

  it('is idempotent: a plugin already on the CLI is skipped, and a second run assigns nothing', async () => {
    const { reactivated, deps } = await makeDeps([{ id: ORCH, config: {} }]);

    const first = await autoAssignSubscriptionCli(deps);
    assert.deepEqual(first.assigned, [ORCH]);

    const second = await autoAssignSubscriptionCli(deps);
    assert.deepEqual(second.assigned, []);
    assert.ok(second.skipped.some((s) => s.pluginId === ORCH && s.reason === 'already_cli'));
    assert.deepEqual(reactivated, [ORCH], 'no second reactivation');
  });

  it('switches every installed LLM plugin that is still on the credential-less default', async () => {
    const { registry, reactivated, deps } = await makeDeps([
      { id: ORCH, config: {} },
      { id: VERIFIER, config: {} },
      { id: EXTRAS, config: {} },
    ]);

    const outcome = await autoAssignSubscriptionCli(deps);

    assert.deepEqual([...outcome.assigned].sort(), [EXTRAS, ORCH, VERIFIER].sort());
    const model = defaultSubscriptionCliModel();
    assert.ok(model);
    for (const id of [ORCH, VERIFIER, EXTRAS]) {
      assert.equal(registry.get(id)?.config?.['llm_provider'], SUBSCRIPTION_CLI_PROVIDER, id);
    }
    // Extras has two model keys; both must be set.
    assert.equal(registry.get(EXTRAS)?.config?.['fact_extractor_model'], model.modelId);
    assert.equal(registry.get(EXTRAS)?.config?.['topic_classifier_model'], model.modelId);
    assert.equal(reactivated.length, 3);
  });

  it('reports a failing reactivate as apply_failed and does not throw', async () => {
    const { deps } = await makeDeps([{ id: ORCH, config: {} }], { reactivateThrows: true });

    const outcome = await autoAssignSubscriptionCli(deps);

    assert.deepEqual(outcome.assigned, []);
    assert.ok(
      outcome.skipped.some((s) => s.pluginId === ORCH && s.reason === 'providers.apply_failed'),
    );
  });

  it('skips a plugin that is not installed', async () => {
    const { reactivated, deps } = await makeDeps([]); // nothing installed
    const outcome = await autoAssignSubscriptionCli(deps);
    assert.deepEqual(outcome.assigned, []);
    assert.ok(outcome.skipped.every((s) => s.reason === 'not_installed'));
    assert.equal(reactivated.length, 0);
  });
});
