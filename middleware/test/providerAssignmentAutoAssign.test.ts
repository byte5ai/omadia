/**
 * OM-79 (#994) — subscription-login hand-off.
 *
 * After a successful `claude auth login`, everything needed to run the
 * orchestrator on the subscription already exists except the assignment:
 * `llm_provider` still points at `anthropic`, the orchestrator asks the vault
 * for a key, finds none and never publishes chatAgent@1. `autoAssignSubscriptionCli`
 * flips that assignment to the CLI provider — but ONLY where there is nothing to
 * lose (the current provider has no credential). A working key is never
 * overridden, and a plugin already on the CLI is left alone (idempotent).
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

async function makeDeps(
  installed: Array<{ id: string; config?: Record<string, unknown> }>,
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
        reactivated.push(id);
      },
    },
  };
}

describe('autoAssignSubscriptionCli (OM-79)', () => {
  afterEach(() => {
    clearExternalModels();
  });

  it('assigns the CLI when the orchestrator has no credential', async () => {
    const { registry, reactivated, deps } = await makeDeps([
      { id: ORCH, config: {} }, // defaults to anthropic, no key in the vault
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
    assert.ok(reactivated.includes(ORCH), 'plugin must be reactivated');
  });

  it('does NOT override an orchestrator that already has an API key', async () => {
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
  });

  it('is idempotent: a plugin already on the CLI is skipped', async () => {
    const { registry, reactivated, deps } = await makeDeps([
      { id: ORCH, config: { llm_provider: SUBSCRIPTION_CLI_PROVIDER } },
    ]);

    const outcome = await autoAssignSubscriptionCli(deps);

    assert.deepEqual(outcome.assigned, []);
    assert.ok(
      outcome.skipped.some((s) => s.pluginId === ORCH && s.reason === 'already_cli'),
    );
    assert.equal(reactivated.length, 0);
  });

  it('skips a plugin that is not installed', async () => {
    const { reactivated, deps } = await makeDeps([]); // nothing installed
    const outcome = await autoAssignSubscriptionCli(deps);
    assert.deepEqual(outcome.assigned, []);
    assert.ok(outcome.skipped.every((s) => s.reason === 'not_installed'));
    assert.equal(reactivated.length, 0);
  });
});
