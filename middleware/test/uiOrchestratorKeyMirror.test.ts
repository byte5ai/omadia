import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { providerApiKeyVaultKey } from '@omadia/llm-provider';

import type { Config } from '../src/config.js';
import { runLegacyBootstrap } from '../src/plugins/bootstrap.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

/**
 * The canvas orchestrator (@omadia/ui-orchestrator) left the core and ships as
 * a standalone plugin. Its provider keys are still mirrored from the
 * orchestrator's vault scope at boot — but only into an INSTALLED plugin's
 * scope: with the id no longer bundled, ingest no longer refuses an upload
 * that claims it, so a key must not wait in the scope for whoever does.
 */

const CANVAS = '@omadia/ui-orchestrator';
const FAST_PATH = '@omadia/fast-path';
const KEY = providerApiKeyVaultKey('anthropic');

async function boot(installCanvas: boolean): Promise<InMemorySecretVault> {
  const vault = new InMemorySecretVault();
  await vault.set('@omadia/orchestrator', KEY, 'sk-test');
  const registry = new InMemoryInstalledRegistry();
  if (installCanvas) {
    await registry.register({
      id: CANVAS,
      installed_version: '0.2.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: {},
    });
  }
  const catalog = new PluginCatalog({ manifestDir: '/nonexistent' });
  await catalog.load();
  await runLegacyBootstrap({
    config: {} as Config,
    catalog,
    registry,
    vault,
    log: () => undefined,
  });
  return vault;
}

describe('provider key mirror → standalone canvas plugin', () => {
  it('copies nothing into the scope of a canvas plugin that is not installed', async () => {
    const vault = await boot(false);
    assert.equal(await vault.get(CANVAS, KEY), undefined);
    assert.equal(await vault.get(FAST_PATH, KEY), 'sk-test', 'the built-in fast path is unaffected');
  });

  it('mirrors the keys once the canvas plugin is installed', async () => {
    const vault = await boot(true);
    assert.equal(await vault.get(CANVAS, KEY), 'sk-test');
  });
});
