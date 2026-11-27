/**
 * #2240 / ADR-0215 — provider API keys leave the verifier's and extras' own
 * vault scopes: dropped when equal to the kernel's key, renamed aside (never
 * lost, never promoted into the kernel scope) otherwise, and a second run
 * changes nothing. Revoke and provider purge remove the renamed copies too.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { purgeProviderCredentials } from '../src/platform/providerCredentialPurge.js';
import {
  consolidateProviderCredentials,
  deleteSupersededCopies,
  isProviderApiKeyVaultKey,
  KERNEL_PROVIDER_CREDENTIAL_SCOPE,
  SUPERSEDED_KEY_PREFIX,
} from '../src/platform/kernelProviderCredentials.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

const KERNEL = KERNEL_PROVIDER_CREDENTIAL_SCOPE;
const VERIFIER = '@omadia/verifier';
const EXTRAS = '@omadia/orchestrator-extras';

async function snapshot(vault: InMemorySecretVault, scope: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of (await vault.listKeys(scope)).sort()) {
    out[key] = (await vault.get(scope, key)) ?? '';
  }
  return out;
}

const quiet = (): void => undefined;

describe('consolidateProviderCredentials (#2240)', () => {
  it('does NOT promote a key only a module held; it is renamed aside and the log asks for LLM access', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany(EXTRAS, { 'provider:openai/api_key': 'sk-openai', fact_extractor_model: 'x' });
    const logs: string[] = [];
    const report = await consolidateProviderCredentials(vault, (m) => logs.push(m));
    assert.deepEqual(report.superseded, [`${EXTRAS}/provider:openai/api_key`]);
    assert.deepEqual(await snapshot(vault, KERNEL), {});
    assert.deepEqual(await snapshot(vault, EXTRAS), {
      fact_extractor_model: 'x',
      [`${SUPERSEDED_KEY_PREFIX}provider:openai/api_key`]: 'sk-openai',
    });
    assert.ok(logs.some((l) => l.includes('LLM access')), logs.join('\n'));
  });

  it('drops copies identical to the kernel key (the old three-scope fan-out)', async () => {
    const vault = new InMemorySecretVault();
    for (const scope of [KERNEL, VERIFIER, EXTRAS]) {
      await vault.setMany(scope, { 'provider:anthropic/api_key': 'sk-ant-same' });
    }
    await vault.setMany(VERIFIER, { anthropic_api_key: 'sk-ant-same' });
    const report = await consolidateProviderCredentials(vault, quiet);
    assert.equal(report.deduplicated.length, 3);
    assert.deepEqual(report.superseded, []);
    assert.deepEqual(await snapshot(vault, VERIFIER), {});
    assert.deepEqual(await snapshot(vault, EXTRAS), {});
    assert.equal(await vault.get(KERNEL, 'provider:anthropic/api_key'), 'sk-ant-same');
  });

  it('keeps a different legacy value even when the canonical copy matches the kernel', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany(KERNEL, { 'provider:anthropic/api_key': 'sk-ant-kernel' });
    await vault.setMany(EXTRAS, { 'provider:anthropic/api_key': 'sk-ant-kernel', anthropic_api_key: 'sk-ant-old' });
    await consolidateProviderCredentials(vault, quiet);
    assert.deepEqual(await snapshot(vault, EXTRAS), {
      [`${SUPERSEDED_KEY_PREFIX}anthropic_api_key`]: 'sk-ant-old',
    });
  });

  it('renames a differing copy aside, never overwriting an earlier superseded one, and logs no value', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany(KERNEL, { 'provider:anthropic/api_key': 'sk-ant-kernel' });
    await vault.setMany(EXTRAS, {
      'provider:anthropic/api_key': 'sk-ant-dedicated-2',
      [`${SUPERSEDED_KEY_PREFIX}provider:anthropic/api_key`]: 'sk-ant-dedicated-1',
    });
    const logs: string[] = [];
    await consolidateProviderCredentials(vault, (m) => logs.push(m));
    assert.deepEqual(await snapshot(vault, EXTRAS), {
      [`${SUPERSEDED_KEY_PREFIX}provider:anthropic/api_key`]: 'sk-ant-dedicated-1',
      [`${SUPERSEDED_KEY_PREFIX}provider:anthropic/api_key#2`]: 'sk-ant-dedicated-2',
    });
    assert.equal(await vault.get(KERNEL, 'provider:anthropic/api_key'), 'sk-ant-kernel');
    assert.ok(logs.every((l) => !l.includes('sk-ant')), logs.join('\n'));
    assert.ok(!isProviderApiKeyVaultKey(`${SUPERSEDED_KEY_PREFIX}provider:anthropic/api_key`));
  });

  it('is idempotent: a second run changes nothing', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany(KERNEL, { 'provider:anthropic/api_key': 'sk-ant-kernel' });
    await vault.setMany(VERIFIER, { 'provider:anthropic/api_key': 'sk-ant-other', 'provider:mistral/api_key': 'm' });
    await consolidateProviderCredentials(vault, quiet);
    const before = { kernel: await snapshot(vault, KERNEL), verifier: await snapshot(vault, VERIFIER) };
    const second = await consolidateProviderCredentials(vault, quiet);
    assert.deepEqual(second, { deduplicated: [], superseded: [] });
    assert.deepEqual({ kernel: await snapshot(vault, KERNEL), verifier: await snapshot(vault, VERIFIER) }, before);
  });

  it('leaves non-credential keys and other scopes alone', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany('@omadia/plugin-office', { 'provider:openai/api_key': 'sk-office' });
    await vault.setMany(VERIFIER, { 'provider:openai/verified_at': 'x' });
    await consolidateProviderCredentials(vault, quiet);
    assert.deepEqual(await snapshot(vault, KERNEL), {});
    assert.equal(await vault.get('@omadia/plugin-office', 'provider:openai/api_key'), 'sk-office');
    assert.equal(await vault.get(VERIFIER, 'provider:openai/verified_at'), 'x');
  });
});

describe('superseded copies leave with a revoke or a provider purge (#2240)', () => {
  it('deleteSupersededCopies removes every numbered copy of the revoked key only', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany(EXTRAS, {
      [`${SUPERSEDED_KEY_PREFIX}provider:openai/api_key`]: 'a',
      [`${SUPERSEDED_KEY_PREFIX}provider:openai/api_key#2`]: 'b',
      [`${SUPERSEDED_KEY_PREFIX}provider:mistral/api_key`]: 'c',
    });
    await deleteSupersededCopies(vault, ['provider:openai/api_key']);
    assert.deepEqual(await snapshot(vault, EXTRAS), {
      [`${SUPERSEDED_KEY_PREFIX}provider:mistral/api_key`]: 'c',
    });
  });

  it('purgeProviderCredentials removes the superseded copies of that provider', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany(VERIFIER, {
      [`${SUPERSEDED_KEY_PREFIX}provider:acme/api_key#2`]: 'a',
      [`${SUPERSEDED_KEY_PREFIX}provider:acme-cloud/api_key`]: 'b',
    });
    await purgeProviderCredentials(vault, 'acme');
    assert.deepEqual(await snapshot(vault, VERIFIER), {
      [`${SUPERSEDED_KEY_PREFIX}provider:acme-cloud/api_key`]: 'b',
    });
  });
});
