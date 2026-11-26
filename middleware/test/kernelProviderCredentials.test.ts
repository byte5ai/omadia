/**
 * #2240 / ADR-0215 — provider API keys move from the verifier's and extras'
 * own vault scopes into the kernel scope: copied when the kernel has none,
 * dropped when identical, renamed aside (never lost) when different, and a
 * second run changes nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  consolidateProviderCredentials,
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
  it('moves a key the kernel scope lacks and removes the module copy', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany(EXTRAS, { 'provider:openai/api_key': 'sk-openai', fact_extractor_model: 'x' });
    const report = await consolidateProviderCredentials(vault, quiet);
    assert.deepEqual(report.moved, [`${EXTRAS}/openai`]);
    assert.deepEqual(await snapshot(vault, KERNEL), { 'provider:openai/api_key': 'sk-openai' });
    assert.deepEqual(await snapshot(vault, EXTRAS), { fact_extractor_model: 'x' });
  });

  it('moves the legacy flat Anthropic key under the canonical name', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany(VERIFIER, { anthropic_api_key: 'sk-ant-legacy' });
    await consolidateProviderCredentials(vault, quiet);
    assert.deepEqual(await snapshot(vault, KERNEL), { 'provider:anthropic/api_key': 'sk-ant-legacy' });
    assert.deepEqual(await snapshot(vault, VERIFIER), {});
  });

  it('drops copies identical to the kernel key (the old three-scope fan-out)', async () => {
    const vault = new InMemorySecretVault();
    for (const scope of [KERNEL, VERIFIER, EXTRAS]) {
      await vault.setMany(scope, { 'provider:anthropic/api_key': 'sk-ant-same' });
    }
    const report = await consolidateProviderCredentials(vault, quiet);
    assert.deepEqual(report.deduplicated.sort(), [`${EXTRAS}/anthropic`, `${VERIFIER}/anthropic`]);
    assert.deepEqual(await snapshot(vault, VERIFIER), {});
    assert.deepEqual(await snapshot(vault, EXTRAS), {});
    assert.equal(await vault.get(KERNEL, 'provider:anthropic/api_key'), 'sk-ant-same');
  });

  it('keeps the kernel key and renames a differing copy aside, never losing it', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany(KERNEL, { 'provider:anthropic/api_key': 'sk-ant-kernel' });
    await vault.setMany(EXTRAS, { 'provider:anthropic/api_key': 'sk-ant-dedicated', anthropic_api_key: 'sk-ant-old' });
    const logs: string[] = [];
    const report = await consolidateProviderCredentials(vault, (m) => logs.push(m));
    assert.deepEqual(report.superseded, [`${EXTRAS}/anthropic`]);
    assert.equal(await vault.get(KERNEL, 'provider:anthropic/api_key'), 'sk-ant-kernel');
    assert.deepEqual(await snapshot(vault, EXTRAS), {
      [`${SUPERSEDED_KEY_PREFIX}anthropic_api_key`]: 'sk-ant-old',
      [`${SUPERSEDED_KEY_PREFIX}provider:anthropic/api_key`]: 'sk-ant-dedicated',
    });
    // Only key names reach the log, never a value.
    assert.ok(logs.every((l) => !l.includes('sk-ant')), logs.join('\n'));
    assert.ok(!isProviderApiKeyVaultKey(`${SUPERSEDED_KEY_PREFIX}provider:anthropic/api_key`));
  });

  it('is idempotent: a second run changes nothing', async () => {
    const vault = new InMemorySecretVault();
    await vault.setMany(KERNEL, { 'provider:anthropic/api_key': 'sk-ant-kernel' });
    await vault.setMany(VERIFIER, { 'provider:anthropic/api_key': 'sk-ant-other', 'provider:mistral/api_key': 'm' });
    await consolidateProviderCredentials(vault, quiet);
    const before = {
      kernel: await snapshot(vault, KERNEL),
      verifier: await snapshot(vault, VERIFIER),
    };
    const second = await consolidateProviderCredentials(vault, quiet);
    assert.deepEqual(second, { moved: [], deduplicated: [], superseded: [] });
    assert.deepEqual(
      { kernel: await snapshot(vault, KERNEL), verifier: await snapshot(vault, VERIFIER) },
      before,
    );
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
