/**
 * A failed activation must not read as `active` (epic #470 P5).
 *
 * `completeInstall` writes `status: 'active'` to the registry BEFORE calling
 * `onInstalled`, which is the hook that actually activates the plugin. That
 * hook's failure used to be caught, logged to the console, and dropped — so a
 * plugin whose `activate()` threw was left claiming `active` while its own
 * `undo()` had rolled back every route, tool and nav entry it registered. The
 * operator saw a green plugin serving nothing, and the only trace was one line
 * of stderr.
 *
 * Found by installing a freshly extracted plugin: the registry answered
 * `{"status":"active"}` while every one of its routes 404'd.
 *
 * The boot path has always done this correctly (`toolPluginRuntime.ts` calls
 * `markActivationFailed`); these tests pin the install path to the same
 * behaviour, and pin that a SUCCESSFUL install is still reported as active —
 * without which "never report active" would pass trivially.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { InstallService } from '../src/plugins/installService.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { SecretVault } from '../src/secrets/vault.js';

const MANIFEST = {
  schema_version: '1',
  identity: {
    id: '@test/activation-truthful',
    kind: 'extension',
    domain: 'test',
    name: 'Activation Truthful',
    version: '0.1.0',
  },
  setup: { fields: [] },
};

function makeService(onInstalled: (id: string) => Promise<void>) {
  const plugin = adaptManifestV1(MANIFEST)!;
  const entry = {
    plugin,
    manifest: MANIFEST,
    source_path: '<test>/manifest.yaml',
    source_kind: 'manifest-v1',
  } as unknown as PluginCatalogEntry;
  const catalog = {
    get: (id: string) => (id === plugin.id ? entry : undefined),
    list: () => [entry],
  } as unknown as PluginCatalog;

  const registry = new InMemoryInstalledRegistry();
  const vault = {
    get: async () => undefined,
    set: async () => {},
    setMany: async () => {},
    purge: async () => {},
  } as unknown as SecretVault;

  const service = new InstallService({ catalog, registry, vault, onInstalled });
  return { service, registry, pluginId: plugin.id };
}

/** Drive a plugin through create → configure, which is where activation runs. */
async function install(service: InstallService, pluginId: string) {
  const job = service.create(pluginId);
  return service.configure(job.id, {});
}

void describe('install reports activation truthfully (#470 P5)', () => {
  void it('marks the entry errored when the onInstalled hook throws', async () => {
    const boom = "NativeToolRegistry: duplicate native-tool name 'example_start'";
    const { service, registry, pluginId } = makeService(async () => {
      throw new Error(boom);
    });

    await install(service, pluginId);

    const entry = registry.get(pluginId);
    assert.ok(entry, 'the plugin should still be INSTALLED — only not active');
    assert.equal(
      entry.status,
      'errored',
      'a plugin whose activation threw must not read as active',
    );
    assert.match(
      String(entry.last_activation_error),
      /duplicate native-tool name/,
      'the hook error must be recorded, not just logged to stderr',
    );
  });

  void it('still reports active when the hook succeeds', async () => {
    // The inverse guard. Without it, a change that marked EVERY install errored
    // would pass the assertion above.
    const { service, registry, pluginId } = makeService(async () => {});

    await install(service, pluginId);

    const entry = registry.get(pluginId);
    assert.ok(entry);
    assert.equal(entry.status, 'active');
    assert.equal(
      entry.last_activation_error,
      undefined,
      'a clean install must carry no activation error',
    );
  });

  void it('does not wait for the circuit breaker to flip the status', async () => {
    // `markActivationFailed` alone would NOT do it: CIRCUIT_BREAKER_THRESHOLD
    // is 3, which is right for a boot loop retrying a transient failure and
    // wrong here. An install-time activation failure is a single definitive
    // event an operator is watching, so ONE failure must be enough.
    const { service, registry, pluginId } = makeService(async () => {
      throw new Error('first and only failure');
    });

    await install(service, pluginId);

    const entry = registry.get(pluginId);
    assert.equal(entry?.activation_failure_count, 1, 'exactly one attempt');
    assert.equal(entry?.status, 'errored', 'one failure is enough at install time');
  });
});
