/**
 * Issue #1453 — the activation path runs the plugin's connection probe.
 *
 * Seam: `ToolPluginRuntime.activate()` with a real on-disk package, the way
 * `toolPluginRuntimeDuplicateProvider.test.ts` does it. A mocked activate()
 * would only prove that the runtime calls a function; what has to hold is that
 * a plugin which comes up perfectly but whose credentials are refused ends up
 * visibly broken — and that a probe can never damage the activation it
 * follows.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { PluginStatusRegistry } from '../src/platform/pluginStatusRegistry.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import {
  adaptManifestV1,
  type PluginCatalog,
  type PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { __clearConnectionProbeCache } from '../src/plugins/connectionProbe.js';
import {
  ToolPluginRuntime,
  type ToolPluginRuntimeDeps,
} from '../src/plugins/toolPluginRuntime.js';
import { newTestRouteRegistry } from './_helpers/routeRegistry.js';

const PLUGIN_ID = '@test/integration-probe';

interface Harness {
  readonly runtime: ToolPluginRuntime;
  readonly registry: InMemoryInstalledRegistry;
  readonly statusRegistry: PluginStatusRegistry;
  readonly logs: string[];
  /** Where the fixture package lives, so a test can steer what its probe
   *  answers between two activations (see the reactivation test). */
  readonly packagePath: string;
}

/** `verifyConnectionBody` is spliced into the fixture package as the body of
 *  its exported `verifyConnection`. Omit it for a plugin that declares no
 *  probe — the pre-#1453 shape every installed plugin still has. */
async function makeRuntime(
  t: TestContext,
  verifyConnectionBody?: string,
  /** Vault contents for this plugin. Empty by default, which leaves the
   *  verdict cache off (no fingerprint, no caching) — pass secrets to exercise
   *  the cached path. */
  secrets: Record<string, string> = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'probe-runtime-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const packagePath = join(root, 'integration-probe');
  await mkdir(packagePath);
  const manifest = {
    schema_version: '1',
    identity: {
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      version: '1.0.0',
      kind: 'integration',
      domain: 'test.probe',
    },
    lifecycle: { entry: 'plugin.ts' },
    provides: [],
    requires: [],
  };
  const plugin = adaptManifestV1(manifest);
  assert.ok(plugin, 'fixture manifest must adapt');

  await writeFile(
    join(packagePath, 'plugin.ts'),
    `import type { PluginConnectionVerdict, PluginContext } from '@omadia/plugin-api';
     export async function activate(_ctx: PluginContext): Promise<{ close(): Promise<void> }> {
       return { close: async (): Promise<void> => {} };
     }
     ${
       verifyConnectionBody === undefined
         ? ''
         : `export async function verifyConnection(_ctx: PluginContext): Promise<PluginConnectionVerdict> {
              ${verifyConnectionBody}
            }`
     }
    `,
    'utf8',
  );

  const entry: PluginCatalogEntry = {
    plugin,
    manifest,
    source_path: packagePath,
    source_kind: 'manifest-v1',
    origin: 'installed',
  } as unknown as PluginCatalogEntry;

  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: PLUGIN_ID,
    installed_version: '1.0.0',
    installed_at: '2026-10-01T00:00:00Z',
    status: 'active',
    config: {},
  });

  const statusRegistry = new PluginStatusRegistry();
  const logs: string[] = [];
  const stub = (): (() => void) => (): void => {};
  const deps = {
    catalog: {
      get: (id: string): PluginCatalogEntry | undefined =>
        id === PLUGIN_ID ? entry : undefined,
      list: (): PluginCatalogEntry[] => [entry],
    } as unknown as PluginCatalog,
    registry,
    vault: {
      get: async (_id: string, key: string): Promise<string | undefined> => secrets[key],
      listKeys: async (): Promise<string[]> => Object.keys(secrets),
    },
    uploadedStore: {
      get: (id: string) => (id === PLUGIN_ID ? { id, path: packagePath } : undefined),
      list: () => [{ id: PLUGIN_ID, path: packagePath }],
    },
    serviceRegistry: new ServiceRegistry(),
    nativeToolRegistry: { register: stub, registerHandler: stub },
    pluginRouteRegistry: newTestRouteRegistry(),
    notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
    uiRouteCatalog: new UiRouteCatalog(),
    jobScheduler: { register: stub, stopForPlugin: (): void => {} },
    pluginStatusRegistry: statusRegistry,
    log: (msg: string): void => {
      logs.push(msg);
    },
  } as unknown as ToolPluginRuntimeDeps;

  return {
    runtime: new ToolPluginRuntime(deps),
    registry,
    statusRegistry,
    logs,
    packagePath,
  };
}

describe('ToolPluginRuntime — connection probe (#1453)', () => {
  it('turns a refused credential into an error status without failing the activation', async (t) => {
    const h = await makeRuntime(
      t,
      `return {
         status: 'rejected',
         cause: 'protocol_auth_failure',
         title: 'Nicht verbunden',
         detail: 'Odoo hat den API-Key abgelehnt',
       };`,
    );

    await h.runtime.activate(PLUGIN_ID);
    await h.runtime.whenConnectionProbesSettled();

    // The plugin itself came up — this is not #1452's failed activation.
    assert.equal(h.registry.get(PLUGIN_ID)?.status, 'active');
    assert.equal(h.registry.get(PLUGIN_ID)?.last_activation_error, undefined);

    const status = h.statusRegistry.get(PLUGIN_ID);
    assert.equal(status?.state, 'error');
    assert.equal(status?.title, 'Nicht verbunden');
    assert.ok(status?.checked_at, 'the kernel stamps when the check actually ran');
    assert.equal(
      h.statusRegistry.isReady(PLUGIN_ID),
      false,
      'a plugin with a dead key must not keep offering its tools',
    );
  });

  it('reports a working connection with the plugin’s own copy', async (t) => {
    const h = await makeRuntime(t, `return { status: 'connected', title: 'Verbunden' };`);

    await h.runtime.activate(PLUGIN_ID);
    await h.runtime.whenConnectionProbesSettled();

    const status = h.statusRegistry.get(PLUGIN_ID);
    assert.equal(status?.state, 'ok');
    assert.equal(status?.title, 'Verbunden');
    assert.ok(status?.checked_at);
    assert.equal(h.statusRegistry.isReady(PLUGIN_ID), true);
  });

  it('leaves the plugin alone when the probe itself fails', async (t) => {
    const h = await makeRuntime(t, `throw new Error('ECONNREFUSED 10.0.0.9:8069');`);

    await h.runtime.activate(PLUGIN_ID);
    await h.runtime.whenConnectionProbesSettled();

    assert.equal(h.registry.get(PLUGIN_ID)?.status, 'active');
    assert.equal(
      h.statusRegistry.get(PLUGIN_ID),
      undefined,
      'an unreachable target is not evidence that the credentials are wrong',
    );
    assert.equal(h.statusRegistry.isReady(PLUGIN_ID), true);
  });

  it('is a no-op for a plugin that declares no probe', async (t) => {
    const h = await makeRuntime(t);

    await h.runtime.activate(PLUGIN_ID);
    await h.runtime.whenConnectionProbesSettled();

    assert.equal(h.registry.get(PLUGIN_ID)?.status, 'active');
    assert.equal(h.statusRegistry.get(PLUGIN_ID), undefined);
  });

  it('re-probes on demand without a reactivation', async (t) => {
    // The operator-triggered path: POST /runtime/installed/:id/verify reaches
    // this method, so a key fixed upstream can be re-checked in place.
    const h = await makeRuntime(
      t,
      `return { status: 'rejected', cause: 'http_401', title: 'Nicht verbunden' };`,
    );

    await h.runtime.activate(PLUGIN_ID);
    await h.runtime.whenConnectionProbesSettled();
    assert.equal(h.statusRegistry.get(PLUGIN_ID)?.state, 'error');

    const outcome = await h.runtime.verifyConnectionNow(PLUGIN_ID);
    assert.equal(outcome?.status, 'rejected');
  });

  it('does not let a late verdict haunt a plugin that was deactivated meanwhile', async (t) => {
    // The probe is not awaited by activation, so an uninstall can land while
    // it is still in flight. `deactivate()` clears the status registry — a
    // verdict arriving afterwards would re-create a red badge for a plugin
    // that is no longer there.
    const h = await makeRuntime(
      t,
      `await new Promise((r) => setTimeout(r, 50));
       return { status: 'rejected', cause: 'http_401', title: 'Nicht verbunden' };`,
    );

    await h.runtime.activate(PLUGIN_ID);
    await h.runtime.deactivate(PLUGIN_ID);
    await h.runtime.whenConnectionProbesSettled();

    assert.equal(h.statusRegistry.get(PLUGIN_ID), undefined);
  });

  // -------------------------------------------------------------------------
  // The two reproductions from the issue.
  // -------------------------------------------------------------------------

  it('catches a key revoked upstream on the next boot (issue repro 2)', async (t) => {
    // "Revoke the API key in Odoo or let it expire, then restart the
    // middleware. The integration activates and shows 'Active · configured'
    // with the boot time." Boot goes through activateAllInstalled(), so the
    // probe has to run from there too, not only from a direct activate().
    const h = await makeRuntime(
      t,
      `return { status: 'rejected', cause: 'http_401', title: 'Nicht verbunden' };`,
    );

    await h.runtime.activateAllInstalled();
    await h.runtime.whenConnectionProbesSettled();

    assert.equal(h.registry.get(PLUGIN_ID)?.status, 'active');
    assert.equal(h.statusRegistry.get(PLUGIN_ID)?.state, 'error');
  });

  it('re-checks on the reactivation that follows a credential edit (issue repro 1)', async (t) => {
    // `PATCH /installed/:id/secrets` writes the vault and then reactivates
    // (`reactivateAfterProviderWrite`), which is deactivate + activate. The
    // probe must run again on that second activation and REPLACE the previous
    // verdict — otherwise a corrected key stays red, and a key replaced by a
    // wrong one stays green.
    const h = await makeRuntime(
      t,
      `const { readFile } = await import('node:fs/promises');
       const { join, dirname } = await import('node:path');
       const { fileURLToPath } = await import('node:url');
       const raw = await readFile(
         join(dirname(fileURLToPath(import.meta.url)), 'verdict.json'),
         'utf8',
       );
       return JSON.parse(raw) as PluginConnectionVerdict;`,
    );
    const verdictFile = join(h.packagePath, 'verdict.json');

    await writeFile(
      verdictFile,
      JSON.stringify({
        status: 'rejected',
        cause: 'http_401',
        title: 'Nicht verbunden',
      }),
      'utf8',
    );
    await h.runtime.activate(PLUGIN_ID);
    await h.runtime.whenConnectionProbesSettled();
    assert.equal(h.statusRegistry.get(PLUGIN_ID)?.state, 'error');

    // The operator fixes the key; the secrets route reactivates.
    await writeFile(
      verdictFile,
      JSON.stringify({ status: 'connected', title: 'Verbunden' }),
      'utf8',
    );
    await h.runtime.deactivate(PLUGIN_ID);
    await h.runtime.activate(PLUGIN_ID);
    await h.runtime.whenConnectionProbesSettled();

    const status = h.statusRegistry.get(PLUGIN_ID);
    assert.equal(status?.state, 'ok');
    assert.equal(status?.title, 'Verbunden');
    assert.equal(h.statusRegistry.isReady(PLUGIN_ID), true);
  });

  it('re-probes after a non-secret config edit instead of serving the cached rejection', async (t) => {
    // The fingerprint that keys the verdict cache has to span the NON-SECRET
    // config, not just the vault. `url`/`db`/`login` are as much a part of the
    // connection as the key, and they are written through
    // `PATCH /installed/:id/config` — which reactivates. Keyed on the vault
    // alone, that reactivation was a cache HIT, so the badge kept the rejection
    // the wrong host had earned until the TTL ran out, long after the operator
    // had repaired it.
    __clearConnectionProbeCache();
    t.after(() => {
      __clearConnectionProbeCache();
    });
    const h = await makeRuntime(
      t,
      `const { readFile } = await import('node:fs/promises');
       const { join, dirname } = await import('node:path');
       const { fileURLToPath } = await import('node:url');
       const raw = await readFile(
         join(dirname(fileURLToPath(import.meta.url)), 'verdict.json'),
         'utf8',
       );
       return JSON.parse(raw) as PluginConnectionVerdict;`,
      { odoo_api_key: 'k1' },
    );
    const verdictFile = join(h.packagePath, 'verdict.json');

    await h.registry.updateConfig(PLUGIN_ID, { url: 'https://wrong.example' });
    await writeFile(
      verdictFile,
      JSON.stringify({
        status: 'rejected',
        cause: 'http_401',
        title: 'Nicht verbunden',
      }),
      'utf8',
    );
    await h.runtime.activate(PLUGIN_ID);
    await h.runtime.whenConnectionProbesSettled();
    assert.equal(h.statusRegistry.get(PLUGIN_ID)?.state, 'error');

    // The operator repairs the host — the secret is untouched.
    await writeFile(
      verdictFile,
      JSON.stringify({ status: 'connected', title: 'Verbunden' }),
      'utf8',
    );
    await h.runtime.deactivate(PLUGIN_ID);
    await h.registry.updateConfig(PLUGIN_ID, { url: 'https://right.example' });
    await h.runtime.activate(PLUGIN_ID);
    await h.runtime.whenConnectionProbesSettled();

    const status = h.statusRegistry.get(PLUGIN_ID);
    assert.equal(status?.state, 'ok', 'a repaired host must not keep the cached rejection');
    assert.equal(status?.title, 'Verbunden');
    assert.equal(h.statusRegistry.isReady(PLUGIN_ID), true);
  });

  it('answers undefined when asked to re-probe a plugin that has no probe', async (t) => {
    const h = await makeRuntime(t);
    await h.runtime.activate(PLUGIN_ID);

    assert.equal(await h.runtime.verifyConnectionNow(PLUGIN_ID), undefined);
    assert.equal(await h.runtime.verifyConnectionNow('@test/not-active'), undefined);
  });
});
