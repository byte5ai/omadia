/**
 * OM-75 / OM-78 (#1000, #1001) — the readiness banner's `cause`.
 *
 * Round-4 beta test: the tester had a working subscription login and every
 * operator surface still 503ed, because the orchestrator was assigned to the
 * default `anthropic` provider for which no key existed. The banner told him to
 * "add a key or subscription", which he had already done. These tests pin the
 * verdict that lets the banner name the actual remedy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { providerApiKeyVaultKey } from '@omadia/llm-provider';

import {
  computeRuntimeReadinessCause,
  resolveRuntimeReadinessCause,
  type LlmProviderCatalogView,
} from '../src/platform/pluginLlmReadiness.js';
import { __clearVerificationCache } from '../src/platform/providerCredentialVerifier.js';
import type {
  CliBackendsSnapshot,
  CliBackendStatus,
  CliLoginState,
} from '../src/platform/cliBackendDetector.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

const statuses = (
  entries: Array<[string, 'no_key' | 'unverified' | 'verified' | 'invalid']>,
): ReadonlyMap<string, 'no_key' | 'unverified' | 'verified' | 'invalid'> =>
  new Map(entries);

test('computeRuntimeReadinessCause: nothing has access → no_llm_access', () => {
  assert.equal(
    computeRuntimeReadinessCause({
      providerStatuses: statuses([
        ['anthropic', 'no_key'],
        ['openai', 'no_key'],
        ['claude-cli', 'no_key'],
      ]),
      assignedProvider: 'anthropic',
    }),
    'no_llm_access',
  );
});

test('computeRuntimeReadinessCause: an empty provider list is no access, not unknown', () => {
  assert.equal(
    computeRuntimeReadinessCause({
      providerStatuses: statuses([]),
      assignedProvider: 'anthropic',
    }),
    'no_llm_access',
  );
});

test('computeRuntimeReadinessCause: CLI logged in, orchestrator still on anthropic → no_assignment (the round-4 case)', () => {
  assert.equal(
    computeRuntimeReadinessCause({
      providerStatuses: statuses([
        ['anthropic', 'no_key'],
        ['claude-cli', 'verified'],
      ]),
      assignedProvider: 'anthropic',
    }),
    'no_assignment',
  );
});

test('computeRuntimeReadinessCause: assigned to a provider the list does not know → no_assignment', () => {
  assert.equal(
    computeRuntimeReadinessCause({
      providerStatuses: statuses([['claude-cli', 'verified']]),
      assignedProvider: 'some-uninstalled-plugin-provider',
    }),
    'no_assignment',
  );
});

test('computeRuntimeReadinessCause: an unverified key still counts as access — the runtime does not gate on the probe', () => {
  assert.equal(
    computeRuntimeReadinessCause({
      providerStatuses: statuses([['anthropic', 'unverified']]),
      assignedProvider: 'anthropic',
    }),
    'unknown',
  );
});

test('computeRuntimeReadinessCause: access and assignment line up → unknown (down for another reason)', () => {
  assert.equal(
    computeRuntimeReadinessCause({
      providerStatuses: statuses([
        ['anthropic', 'verified'],
        ['claude-cli', 'verified'],
      ]),
      assignedProvider: 'claude-cli',
    }),
    'unknown',
  );
});

// ── The I/O wrapper ─────────────────────────────────────────────────────────

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
  };
}

const catalog: LlmProviderCatalogView = {
  get(id: string) {
    return id === 'claude-cli'
      ? { label: 'Claude (subscription CLI)', policy: { requiresApiKey: false } }
      : { label: id };
  },
};

test('resolveRuntimeReadinessCause: fresh install, nothing configured → no_llm_access', async () => {
  __clearVerificationCache();
  const cause = await resolveRuntimeReadinessCause({
    providerIds: ['anthropic', 'claude-cli'],
    orchestratorConfig: {},
    vault: new InMemorySecretVault(),
    llmProviderCatalog: catalog,
    detectCli: async () => snapshot([{ id: 'claude', loggedIn: 'no' }]),
  });
  assert.equal(cause, 'no_llm_access');
});

test('resolveRuntimeReadinessCause: CLI logged in, llm_provider unset (defaults to anthropic) → no_assignment', async () => {
  __clearVerificationCache();
  const cause = await resolveRuntimeReadinessCause({
    providerIds: ['anthropic', 'claude-cli'],
    orchestratorConfig: {},
    vault: new InMemorySecretVault(),
    llmProviderCatalog: catalog,
    detectCli: async () => snapshot([{ id: 'claude', loggedIn: 'yes' }]),
  });
  assert.equal(cause, 'no_assignment');
});

test('resolveRuntimeReadinessCause: CLI logged in AND assigned → unknown', async () => {
  __clearVerificationCache();
  const cause = await resolveRuntimeReadinessCause({
    providerIds: ['anthropic', 'claude-cli'],
    orchestratorConfig: { llm_provider: 'claude-cli' },
    vault: new InMemorySecretVault(),
    llmProviderCatalog: catalog,
    detectCli: async () => snapshot([{ id: 'claude', loggedIn: 'yes' }]),
  });
  assert.equal(cause, 'unknown');
});

test('resolveRuntimeReadinessCause: a stored anthropic key on the default assignment → unknown', async () => {
  __clearVerificationCache();
  const vault = new InMemorySecretVault();
  await vault.set(
    '@omadia/orchestrator',
    providerApiKeyVaultKey('anthropic'),
    'sk-ant-test',
  );
  const cause = await resolveRuntimeReadinessCause({
    providerIds: ['anthropic', 'claude-cli'],
    orchestratorConfig: {},
    vault,
    llmProviderCatalog: catalog,
    detectCli: async () => snapshot([{ id: 'claude', loggedIn: 'no' }]),
  });
  assert.equal(cause, 'unknown');
});

test('resolveRuntimeReadinessCause: a throwing lookup degrades to unknown instead of failing the 503', async () => {
  __clearVerificationCache();
  const cause = await resolveRuntimeReadinessCause({
    providerIds: ['anthropic'],
    orchestratorConfig: {},
    vault: {
      get: async () => {
        throw new Error('vault exploded');
      },
    },
    llmProviderCatalog: catalog,
    detectCli: async () => undefined,
  });
  assert.equal(cause, 'unknown');
});
