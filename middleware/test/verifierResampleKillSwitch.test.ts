/**
 * `verifier_resample_on_borderline` — the operator's switch for the borderline
 * resample in `enforce` mode.
 *
 * The resample doubles the model cost of a borderline turn and re-enters it.
 * It used to be hard-wired on: `VerifierService` defaulted
 * `resampleOnBorderline` to true and nothing in the verifier bundle could
 * change that. The setup field (seeded on first boot from
 * `VERIFIER_RESAMPLE_ON_BORDERLINE`) now reaches the bundle the kernel builds
 * the service from; on by default, off only for an explicit `false`.
 * (`verifierServiceWriteSafety.test.ts` shows the service then runs the turn
 * once.)
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';

import { activate, type VerifierBundle } from '../packages/harness-verifier/src/plugin.js';
import type { Config } from '../src/config.js';
import { bootstrapVerifierFromEnv } from '../src/plugins/bootstrap.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { SecretVault } from '../src/secrets/vault.js';
import { useBuiltinProviders } from './_helpers/builtinProviders.js';

useBuiltinProviders();

async function publishedBundle(config: Record<string, string>): Promise<VerifierBundle | undefined> {
  let bundle: VerifierBundle | undefined;
  const ctx = {
    agentId: '@omadia/verifier',
    config: { get: (key: string) => config[key] },
    secrets: { get: async () => 'sk-test' },
    services: {
      get: (name: string) => (name === 'knowledgeGraph' ? {} : undefined),
      provide: (name: string, value: unknown) => {
        if (name === 'verifier') bundle = value as VerifierBundle;
        return () => {};
      },
    },
    log: () => undefined,
  } as unknown as PluginContext;
  await activate(ctx);
  return bundle;
}

describe('verifier_resample_on_borderline reaches the verifier bundle', () => {
  it('on by default, off only for an explicit false', async () => {
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, true],
      ['true', true],
      ['', true],
      ['false', false],
      [' FALSE ', false],
    ];
    for (const [value, expected] of cases) {
      const bundle = await publishedBundle({
        verifier_enabled: 'true',
        verifier_mode: 'enforce',
        ...(value !== undefined ? { verifier_resample_on_borderline: value } : {}),
      });
      assert.ok(bundle, 'verifier@1 published');
      assert.equal(bundle.resampleOnBorderline, expected, `field value ${JSON.stringify(value)}`);
    }
  });
});

describe('first boot seeds verifier_resample_on_borderline from the environment', () => {
  function deps(resample: boolean) {
    const registry = new InMemoryInstalledRegistry();
    const catalog = {
      get: (id: string) =>
        id === '@omadia/verifier' ? { plugin: { id, version: '0.1.0' } } : undefined,
      list: () => [],
    } as unknown as PluginCatalog;
    const vault = new Proxy({} as Record<string, unknown>, {
      get: () => () => Promise.resolve(undefined),
    }) as unknown as SecretVault;
    const config = {
      VERIFIER_ENABLED: true,
      VERIFIER_MODE: 'enforce',
      VERIFIER_MODEL: 'claude-haiku-4-5-20251001',
      VERIFIER_MAX_CLAIMS: 20,
      VERIFIER_AMOUNT_TOLERANCE: 0.01,
      VERIFIER_MAX_RETRIES: 1,
      VERIFIER_RESAMPLE_ON_BORDERLINE: resample,
    } as unknown as Config;
    return { registry, catalog, vault, config, log: () => undefined };
  }

  it('writes the env value into the plugin config', async () => {
    for (const resample of [true, false]) {
      const d = deps(resample);
      await bootstrapVerifierFromEnv(d);
      const entry = d.registry.get('@omadia/verifier');
      assert.equal(
        entry?.config['verifier_resample_on_borderline'],
        resample ? 'true' : 'false',
      );
    }
  });
});
