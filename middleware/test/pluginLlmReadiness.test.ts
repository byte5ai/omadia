/**
 * #884 — this module is the single source of truth for "does this provider
 * have a working credential". Before #884 one route answered that inline, and
 * the Hub's ready count did not answer it at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { providerApiKeyVaultKey } from '@omadia/llm-provider';

import {
  DEFAULT_PROVIDER,
  LLM_PLUGINS,
  findProviderKey,
  resolvePluginLlmReadiness,
  resolveProviderVerification,
  type LlmProviderCatalogView,
} from '../src/platform/pluginLlmReadiness.js';
import { __clearVerificationCache } from '../src/platform/providerCredentialVerifier.js';
import type {
  CliBackendsSnapshot,
  CliBackendStatus,
  CliLoginState,
} from '../src/platform/cliBackendDetector.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

function catalogRecording(
  calls: string[],
  descriptor: ReturnType<LlmProviderCatalogView['get']> = { label: 'provider' },
): LlmProviderCatalogView {
  return {
    get(id: string) {
      calls.push(id);
      return descriptor;
    },
  };
}

/** A fully-populated snapshot fixture. The unrelated fields (`label`, `bin`,
 *  `billing`, `detail`, `installable`) are filled in rather than cast away:
 *  `CliBackendStatus` is the real host-probe DTO, and a partial cast here would
 *  keep compiling if the verdict logic ever started reading one of them. */
function snapshot(
  backends: Array<{ id: string; loggedIn: CliLoginState }>,
): CliBackendsSnapshot {
  return {
    backends: backends.map(
      (backend): CliBackendStatus => ({
        id: backend.id,
        label: backend.id,
        bin: backend.id,
        installed: true,
        loggedIn: backend.loggedIn,
        billing: 'subscription',
        detail: `${backend.id} probe fixture`,
        installable: true,
      }),
    ),
    generatedAt: 0,
    cliToolsDir: '/tmp/cli-tools',
  };
}

test('resolvePluginLlmReadiness returns undefined for non-LLM plugins without touching deps', async () => {
  const verdict = await resolvePluginLlmReadiness(
    'de.byte5.integration.google-workspace',
    {},
    {
      vault: {
        get: async (): Promise<string | undefined> => {
          throw new Error('vault should not be read');
        },
      },
      llmProviderCatalog: {
        get: (): never => {
          throw new Error('catalog should not be read');
        },
      },
    },
  );
  assert.equal(verdict, undefined);
});

test('every registered LLM plugin id resolves to a defined provider verdict', async () => {
  __clearVerificationCache();
  for (const desc of LLM_PLUGINS) {
    const verdict = await resolvePluginLlmReadiness(desc.id, {}, {
      vault: { get: async (): Promise<string | undefined> => undefined },
      llmProviderCatalog: { get: () => ({ label: 'Anthropic' }) },
      cliSnapshot: undefined,
    });
    assert.notEqual(verdict, undefined, desc.id);
  }
});

test('default provider falls back to anthropic when llm_provider is absent, empty, or not a string', async () => {
  __clearVerificationCache();
  const calls: string[] = [];
  const catalog = catalogRecording(calls);

  await resolvePluginLlmReadiness('@omadia/orchestrator', {}, {
    vault: { get: async (): Promise<string | undefined> => undefined },
    llmProviderCatalog: catalog,
    cliSnapshot: undefined,
  });
  await resolvePluginLlmReadiness('@omadia/orchestrator', { llm_provider: '' }, {
    vault: { get: async (): Promise<string | undefined> => undefined },
    llmProviderCatalog: catalog,
    cliSnapshot: undefined,
  });
  await resolvePluginLlmReadiness(
    '@omadia/orchestrator',
    { llm_provider: 42 },
    {
      vault: { get: async (): Promise<string | undefined> => undefined },
      llmProviderCatalog: catalog,
      cliSnapshot: undefined,
    },
  );

  assert.deepEqual(calls, [
    DEFAULT_PROVIDER,
    DEFAULT_PROVIDER,
    DEFAULT_PROVIDER,
  ]);
});

test('an explicit llm_provider value is the provider that gets probed', async () => {
  __clearVerificationCache();
  const calls: string[] = [];
  const verdict = await resolvePluginLlmReadiness(
    '@omadia/orchestrator',
    { llm_provider: 'openai' },
    {
      vault: { get: async (): Promise<string | undefined> => undefined },
      llmProviderCatalog: catalogRecording(calls),
      cliSnapshot: undefined,
    },
  );
  assert.equal(verdict?.status, 'no_key');
  assert.deepEqual(calls, ['openai']);
});

test('resolveProviderVerification maps claude-cli snapshots to verified or no_key', async () => {
  const verified = await resolveProviderVerification('claude-cli', {
    cliSnapshot: snapshot([{ id: 'claude', loggedIn: 'yes' }]),
  });
  const loggedOut = await resolveProviderVerification('claude-cli', {
    cliSnapshot: snapshot([{ id: 'claude', loggedIn: 'no' }]),
  });
  const unknown = await resolveProviderVerification('claude-cli', {
    cliSnapshot: snapshot([{ id: 'claude', loggedIn: 'unknown' }]),
  });
  const missingBackend = await resolveProviderVerification('claude-cli', {
    cliSnapshot: snapshot([{ id: 'codex', loggedIn: 'yes' }]),
  });
  const missingSnapshot = await resolveProviderVerification('claude-cli', {
    cliSnapshot: undefined,
  });

  assert.equal(verified.status, 'verified');
  assert.equal(loggedOut.status, 'no_key');
  assert.equal(unknown.status, 'no_key');
  assert.equal(missingBackend.status, 'no_key');
  assert.equal(missingSnapshot.status, 'no_key');
});

test('resolvePluginLlmReadiness calls detectCli once when claude-cli is assigned and no cliSnapshot key is present', async () => {
  let detectCalls = 0;
  const verdict = await resolvePluginLlmReadiness(
    '@omadia/orchestrator',
    { llm_provider: 'claude-cli' },
    {
      detectCli: async () => {
        detectCalls += 1;
        return snapshot([{ id: 'claude', loggedIn: 'yes' }]);
      },
    },
  );
  assert.equal(detectCalls, 1);
  assert.equal(verdict?.status, 'verified');
});

test('a descriptor that declares no API key requirement verifies without consulting the vault', async () => {
  const verdict = await resolveProviderVerification('anthropic', {
    vault: {
      get: async (): Promise<string | undefined> => {
        throw new Error('vault should not be read');
      },
    },
    llmProviderCatalog: {
      get: () => ({
        label: 'Ollama',
        policy: { requiresApiKey: false },
      }),
    },
  });
  assert.equal(verdict.status, 'verified');
});

test('a key-based provider with no stored key returns no_key', async () => {
  __clearVerificationCache();
  const verdict = await resolveProviderVerification('anthropic', {
    vault: new InMemorySecretVault(),
    llmProviderCatalog: { get: () => ({ label: 'Anthropic' }) },
  });
  assert.equal(verdict.status, 'no_key');
});

test('a stored key with no probe history returns unverified, which the Hub must not treat as ready', async () => {
  __clearVerificationCache();
  const vault = new InMemorySecretVault();
  await vault.set('@omadia/orchestrator', providerApiKeyVaultKey('anthropic'), 'sk-ant');

  const verdict = await resolveProviderVerification('anthropic', {
    vault,
    llmProviderCatalog: { get: () => ({ label: 'Anthropic' }) },
  });
  assert.equal(verdict.status, 'unverified');
});

test('findProviderKey returns a key stored in a later LLM-plugin scope and reports that scope', async () => {
  __clearVerificationCache();
  const vault = new InMemorySecretVault();
  await vault.set('@omadia/verifier', providerApiKeyVaultKey('anthropic'), 'sk-verifier');

  const found = await findProviderKey(vault, 'anthropic');
  assert.deepEqual(found, {
    scope: '@omadia/verifier',
    apiKey: 'sk-verifier',
  });
});
