import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';
import {
  retryErroredPlugins,
  type RetryErroredPluginsDeps,
} from '../src/plugins/bootstrap.js';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  InMemoryInstalledRegistry,
  type InstalledRegistry,
} from '../src/plugins/installedRegistry.js';
import {
  adaptManifestV1,
  type PluginCatalog,
  type PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import {
  ToolPluginRuntime,
  type ToolPluginRuntimeDeps,
} from '../src/plugins/toolPluginRuntime.js';
import { newTestRouteRegistry } from './_helpers/routeRegistry.js';

const OLDER = '@test/older-provider';
const YOUNGER = '@test/younger-provider';
const CONSUMER = '@test/consumer';
const DUPLICATE_MESSAGE =
  `capability 'fooClient@1' is also provided by '${OLDER}' — uninstall one`;

type FailureCall = Parameters<InstalledRegistry['markActivationFailed']>;
type BlockCall = Parameters<InstalledRegistry['markActivationBlocked']>;

class RecordingInstalledRegistry extends InMemoryInstalledRegistry {
  readonly failureCalls: FailureCall[] = [];
  readonly blockCalls: BlockCall[] = [];

  constructor(private readonly writeFailure?: unknown) {
    super();
  }

  override async markActivationFailed(...args: FailureCall): Promise<void> {
    this.failureCalls.push(args);
    if (this.writeFailure !== undefined) throw this.writeFailure;
    await super.markActivationFailed(...args);
  }

  override async markActivationBlocked(...args: BlockCall): Promise<void> {
    this.blockCalls.push(args);
    if (this.writeFailure !== undefined) throw this.writeFailure;
    await super.markActivationBlocked(...args);
  }
}

interface RuntimeHarness {
  readonly runtime: ToolPluginRuntime;
  readonly registry: RecordingInstalledRegistry;
  readonly serviceRegistry: ServiceRegistry;
  readonly activated: string[];
  readonly logs: string[];
  readonly retryDeps: RetryErroredPluginsDeps;
}

/**
 * OM-87 / #1053 — reuse the on-disk package + adapted manifest harness from
 * toolPluginRuntimeHandoff.pg.test.ts. A mocked activate() would only prove
 * selection: real providers and a real consumer prove that boot still wires
 * the surviving service before the consumer reads it.
 */
async function makeRuntime(
  t: TestContext,
  options: {
    readonly writeFailure?: unknown;
    readonly previousFailureCount?: number;
    readonly pluginIds?: readonly string[];
    readonly activationError?: string;
  } = {},
): Promise<RuntimeHarness> {
  const root = await mkdtemp(join(tmpdir(), 'om87-runtime-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const registry = new RecordingInstalledRegistry(options.writeFailure);
  const entries = new Map<string, PluginCatalogEntry>();
  const packages = new Map<string, { readonly id: string; readonly path: string }>();
  // Put both the consumer and the younger provider first. Package-store
  // enumeration must not overrule installation age or the dependency edge.
  for (const id of options.pluginIds ?? [CONSUMER, YOUNGER, OLDER]) {
    const packagePath = join(root, id.slice('@test/'.length));
    await mkdir(packagePath);
    const manifest = {
      schema_version: '1',
      identity: {
        id,
        name: id,
        version: '1.0.0',
        kind: 'tool',
        domain: 'test.duplicate',
      },
      lifecycle: { entry: 'plugin.ts' },
      provides: [id === CONSUMER ? 'consumerResult@1' : 'fooClient@1'],
      requires: id === CONSUMER ? ['fooClient@^1'] : [],
    };
    const plugin = adaptManifestV1(manifest);
    assert.ok(plugin, 'fixture manifest must adapt');
    entries.set(id, {
      plugin,
      manifest,
      source_path: packagePath,
      source_kind: 'manifest-v1',
      origin: 'installed',
    });
    packages.set(id, { id, path: packagePath });
    const body = id === CONSUMER
      ? `const provider = ctx.services.get<{ providerId: string }>('fooClient');
         if (!provider) throw new Error('fooClient was not activated first');
         const dispose = ctx.services.provide('consumerResult', provider);`
      : `const dispose = ctx.services.provide('fooClient', { providerId: '${id}' });`;
    const activationBody = options.activationError
      ? `throw new Error(${JSON.stringify(options.activationError)});`
      : `${body}
         return { close: async (): Promise<void> => { dispose(); } };`;
    await writeFile(
      join(packagePath, 'plugin.ts'),
      `import type { PluginContext } from '@omadia/plugin-api';
       export async function activate(ctx: PluginContext): Promise<{ close(): Promise<void> }> {
         ${activationBody}
       }
      `,
      'utf8',
    );
    await registry.register({
      id,
      installed_version: '1.0.0',
      installed_at: id === OLDER ? '2026-08-01T00:00:00Z' : '2026-09-01T00:00:00Z',
      status: 'active',
      config: {},
      ...(id === YOUNGER ? {
        activation_failure_count: options.previousFailureCount ?? 0,
        // Prove that the duplicate path clears stale requires metadata, so
        // bootstrap cannot auto-retry this conflict as a repaired dependency.
        unresolved_requires: ['obsoleteClient@1'],
      } : {}),
    });
  }

  const catalog = {
    get: (id: string): PluginCatalogEntry | undefined => entries.get(id),
    list: (): PluginCatalogEntry[] => [...entries.values()],
  } as unknown as PluginCatalog;
  const serviceRegistry = new ServiceRegistry();
  const activated: string[] = [];
  const logs: string[] = [];
  const stub = (): (() => void) => (): void => {};
  const deps = {
    catalog,
    registry,
    vault: {
      get: async (): Promise<undefined> => undefined,
      listKeys: async (): Promise<string[]> => [],
    },
    uploadedStore: {
      get: (id: string) => packages.get(id),
      list: () => [...packages.values()],
    },
    serviceRegistry,
    nativeToolRegistry: { register: stub, registerHandler: stub },
    pluginRouteRegistry: newTestRouteRegistry(),
    notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
    uiRouteCatalog: new UiRouteCatalog(),
    jobScheduler: { register: stub, stopForPlugin: (): void => {} },
    onActivated: (entry: PluginCatalogEntry): void => {
      activated.push(entry.plugin.id);
    },
    log: (msg: string): void => {
      logs.push(msg);
    },
  } as unknown as ToolPluginRuntimeDeps;
  return {
    runtime: new ToolPluginRuntime(deps),
    registry,
    serviceRegistry,
    activated,
    logs,
    retryDeps: { catalog, registry, uploadedStore: deps.uploadedStore, log: deps.log },
  };
}

function assertSurvivingActivation(harness: RuntimeHarness): void {
  assert.deepEqual(harness.activated, [OLDER, CONSUMER]);
  assert.deepEqual(harness.serviceRegistry.get('fooClient'), { providerId: OLDER });
  assert.deepEqual(harness.serviceRegistry.get('consumerResult'), { providerId: OLDER });
  assert.deepEqual(harness.registry.blockCalls, [[YOUNGER, DUPLICATE_MESSAGE]],
    'duplicate failure must use the terminal path without a requires-array');
  assert.deepEqual(harness.registry.failureCalls, [],
    'deterministic conflicts must not consume transient retries');
  assert.deepEqual(
    harness.logs.filter((line) => line.includes('not activated')),
    [`[tool-runtime] ${YOUNGER} not activated — ${DUPLICATE_MESSAGE}`],
  );
}

describe('ToolPluginRuntime.activateAllInstalled — duplicate providers (OM-87)', () => {
  it('errors the younger provider on the first boot while the older provider and consumer activate', async (t) => {
    const harness = await makeRuntime(t);
    await assert.doesNotReject(harness.runtime.activateAllInstalled());

    assertSurvivingActivation(harness);
    const younger = harness.registry.get(YOUNGER);
    assert.ok(younger);
    assert.equal(younger.last_activation_error, DUPLICATE_MESSAGE);
    assert.equal(younger.activation_failure_count, CIRCUIT_BREAKER_THRESHOLD);
    assert.equal(younger.unresolved_requires, undefined);
    assert.equal(Object.hasOwn(younger, 'unresolved_requires'), false);
    assert.equal(younger.status, 'errored');
    assert.ok(younger.last_activation_error_at);
    assert.equal(harness.registry.get(OLDER)?.status, 'active');
    assert.ok(harness.registry.get(OLDER)?.last_activated_at);
  });

  it('immediately blocks a duplicate that already has transient failures', async (t) => {
    const harness = await makeRuntime(t, {
      previousFailureCount: CIRCUIT_BREAKER_THRESHOLD - 1,
    });
    await assert.doesNotReject(harness.runtime.activateAllInstalled());

    assertSurvivingActivation(harness);
    assert.equal(harness.registry.get(YOUNGER)?.status, 'errored');
    assert.equal(harness.registry.get(YOUNGER)?.activation_failure_count, CIRCUIT_BREAKER_THRESHOLD);
    assert.equal(harness.registry.get(YOUNGER)?.unresolved_requires, undefined);
  });

  it('re-blocks a duplicate after a file-mtime reset and leaves it errored on the next retry pass', async (t) => {
    const harness = await makeRuntime(t);
    await harness.runtime.activateAllInstalled();
    const younger = harness.registry.get(YOUNGER);
    assert.ok(younger);
    assert.equal(younger.status, 'errored');

    // No pending requires means the surviving provider cannot auto-reset a
    // deterministic provides conflict as if it were a repaired dependency.
    await retryErroredPlugins(harness.retryDeps);
    assert.equal(harness.registry.get(YOUNGER)?.status, 'errored');

    // Age the original error and manifest to deterministic dates; the real
    // fs.stat path must observe a manifest touch later than that first error.
    await harness.registry.register({ ...younger, last_activation_error_at: '2000-01-01T00:00:00.000Z' });
    const pkg = harness.retryDeps.uploadedStore?.get(YOUNGER);
    assert.ok(pkg);
    const manifestPath = join(pkg.path, 'manifest.yaml');
    await writeFile(manifestPath, 'schema_version: "1"\n', 'utf8');
    const mtime = new Date('2001-01-01T00:00:00.000Z');
    await utimes(manifestPath, mtime, mtime);

    await retryErroredPlugins(harness.retryDeps);
    assert.equal(harness.registry.get(YOUNGER)?.status, 'active');
    assert.equal(harness.registry.get(YOUNGER)?.activation_failure_count, undefined);
    assert.equal(harness.registry.get(YOUNGER)?.last_activation_error_at, undefined);

    await assert.doesNotReject(harness.runtime.activateAllInstalled());
    const blockedAgain = harness.registry.get(YOUNGER);
    assert.ok(blockedAgain);
    assert.equal(blockedAgain.status, 'errored');
    assert.equal(blockedAgain.activation_failure_count, CIRCUIT_BREAKER_THRESHOLD);
    assert.equal(blockedAgain.unresolved_requires, undefined);
    assert.equal(blockedAgain.last_activation_error, DUPLICATE_MESSAGE);
    assert.ok(blockedAgain.last_activation_error_at && blockedAgain.last_activation_error_at > mtime.toISOString());
    assert.deepEqual(harness.registry.blockCalls, [
      [YOUNGER, DUPLICATE_MESSAGE],
      [YOUNGER, DUPLICATE_MESSAGE],
    ]);
    assert.deepEqual(harness.registry.failureCalls, []);
    assert.equal(harness.registry.get(OLDER)?.status, 'active');
    assert.deepEqual(harness.activated, [OLDER, CONSUMER]);

    await retryErroredPlugins(harness.retryDeps);
    assert.deepEqual(harness.registry.get(YOUNGER), blockedAgain,
      'the refreshed error timestamp prevents another reset for the same manifest touch');
  });

  it('keeps ordinary activate() throws on the counted circuit-breaker path', async (t) => {
    const activationError = 'ECONNREFUSED: provider dependency unavailable';
    const harness = await makeRuntime(t, { pluginIds: [OLDER], activationError });

    for (let attempt = 1; attempt <= CIRCUIT_BREAKER_THRESHOLD; attempt += 1) {
      await assert.doesNotReject(harness.runtime.activateAllInstalled());
      const entry = harness.registry.get(OLDER);
      assert.ok(entry);
      assert.equal(entry.status, attempt < CIRCUIT_BREAKER_THRESHOLD ? 'active' : 'errored');
      assert.equal(entry.activation_failure_count, attempt);
      assert.equal(entry.last_activation_error, activationError);
      assert.equal(entry.unresolved_requires, undefined);
      assert.equal(harness.registry.failureCalls.length, attempt);
      assert.deepEqual(harness.registry.failureCalls.at(-1), [OLDER, activationError]);
      assert.deepEqual(harness.registry.blockCalls, []);
    }

    await harness.runtime.activateAllInstalled();
    assert.equal(harness.registry.failureCalls.length, CIRCUIT_BREAKER_THRESHOLD,
      'errored plugins are skipped until the retry policy resets them');
    assert.deepEqual(harness.activated, []);
  });

  it('keeps unresolved requires persisted on the counted circuit-breaker path', async (t) => {
    const harness = await makeRuntime(t, { pluginIds: [CONSUMER] });
    const requires = ['fooClient@^1'];
    const message = 'unresolved capability requires: fooClient@^1';

    for (let attempt = 1; attempt <= CIRCUIT_BREAKER_THRESHOLD; attempt += 1) {
      await assert.doesNotReject(harness.runtime.activateAllInstalled());
      const entry = harness.registry.get(CONSUMER);
      assert.ok(entry);
      assert.equal(entry.status, attempt < CIRCUIT_BREAKER_THRESHOLD ? 'active' : 'errored');
      assert.equal(entry.activation_failure_count, attempt);
      assert.equal(entry.last_activation_error, message);
      assert.deepEqual(entry.unresolved_requires, requires);
      assert.equal(harness.registry.failureCalls.length, attempt);
      assert.deepEqual(harness.registry.failureCalls.at(-1), [CONSUMER, message, requires]);
      assert.deepEqual(harness.registry.blockCalls, []);
    }

    await harness.runtime.activateAllInstalled();
    assert.equal(harness.registry.failureCalls.length, CIRCUIT_BREAKER_THRESHOLD);
    assert.deepEqual(harness.registry.get(CONSUMER)?.unresolved_requires, requires);
    assert.deepEqual(harness.activated, []);
  });

  for (const { label, failure } of [
    { label: 'Error', failure: new Error('registry unavailable') },
    { label: 'non-Error', failure: 'registry unavailable' },
  ]) {
    it(`continues activation and logs a registry-write failure (${label})`, async (t) => {
      const harness = await makeRuntime(t, { writeFailure: failure });
      await assert.doesNotReject(harness.runtime.activateAllInstalled());

      assertSurvivingActivation(harness);
      assert.ok(harness.logs.includes(
        `[tool-runtime] registry markActivationBlocked FAILED for ${YOUNGER}: registry unavailable`,
      ));
    });
  }
});
