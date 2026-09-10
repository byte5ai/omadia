import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DynamicAgentRuntime,
  type DynamicAgentRuntimeDeps,
} from '../src/plugins/dynamicAgentRuntime.js';
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
import type { UploadedPackageStore } from '../src/plugins/uploadedPackageStore.js';

const AGENT_ID = '@test/transient-agent';
const ACTIVATION_ERROR = 'ECONNREFUSED: agent dependency unavailable';
type FailureCall = Parameters<InstalledRegistry['markActivationFailed']>;
type BlockCall = Parameters<InstalledRegistry['markActivationBlocked']>;

class RecordingRegistry extends InMemoryInstalledRegistry {
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
    await super.markActivationBlocked(...args);
  }
}

class ThrowingActivationRuntime extends DynamicAgentRuntime {
  readonly attempts: string[] = [];

  constructor(deps: DynamicAgentRuntimeDeps, private readonly activationError: unknown) {
    super(deps);
  }

  override async activate(id: string): Promise<never> {
    this.attempts.push(id);
    throw this.activationError;
  }
}

async function makeRuntime(activationError: unknown, writeFailure?: unknown) {
  const registry = new RecordingRegistry(writeFailure);
  await registry.register({
    id: AGENT_ID,
    installed_version: '1.0.0',
    installed_at: '2026-09-01T00:00:00Z',
    status: 'active',
    config: {},
    unresolved_requires: ['obsoleteClient@1'],
  });
  const manifest = {
    schema_version: '1',
    identity: {
      id: AGENT_ID,
      name: 'Transient agent',
      version: '1.0.0',
      kind: 'agent',
      domain: 'test.activation',
    },
    lifecycle: { entry: 'plugin.ts' },
    provides: [],
    requires: [],
  };
  const plugin = adaptManifestV1(manifest);
  assert.ok(plugin, 'fixture agent manifest must adapt');
  const entry: PluginCatalogEntry = {
    plugin,
    manifest,
    source_path: '/unused/transient-agent',
    source_kind: 'manifest-v1',
    origin: 'installed',
  };
  const catalog = {
    get: (id: string): PluginCatalogEntry | undefined => id === AGENT_ID ? entry : undefined,
    list: (): PluginCatalogEntry[] => [entry],
  } satisfies Pick<PluginCatalog, 'get' | 'list'>;
  const uploadedStore = {
    list: () => [{
      id: AGENT_ID,
      version: '1.0.0',
      path: entry.source_path,
      uploaded_at: '2026-09-01T00:00:00Z',
      uploaded_by: 'test',
      sha256: '0'.repeat(64),
      peers_missing: [],
      zip_bytes: 0,
      extracted_bytes: 0,
      file_count: 0,
    }],
  } satisfies Pick<UploadedPackageStore, 'list'>;
  const logs: unknown[][] = [];
  // Only activate() is substituted. Boot selection, catch/log handling, and
  // counted registry writes are real; LLM and filesystem activation deps
  // cannot be reached through this override and are deliberately omitted.
  const deps = {
    registry,
    catalog,
    uploadedStore,
    log: (...args: unknown[]): void => { logs.push(args); },
  } as unknown as DynamicAgentRuntimeDeps;
  return { runtime: new ThrowingActivationRuntime(deps, activationError), registry, logs };
}

describe('DynamicAgentRuntime.activateAllInstalled — transient failure regression', () => {
  for (const { label, failure } of [
    { label: 'Error', failure: new Error(ACTIVATION_ERROR) },
    { label: 'non-Error', failure: ACTIVATION_ERROR },
  ]) {
    it(`counts ordinary ${label} activation failures and skips the fourth attempt`, async () => {
      const { runtime, registry, logs } = await makeRuntime(failure);

      for (let attempt = 1; attempt <= CIRCUIT_BREAKER_THRESHOLD; attempt += 1) {
        assert.deepEqual(await runtime.activateAllInstalled(), []);
        const entry = registry.get(AGENT_ID);
        assert.ok(entry);
        assert.equal(entry.status, attempt < CIRCUIT_BREAKER_THRESHOLD ? 'active' : 'errored');
        assert.equal(entry.activation_failure_count, attempt);
        assert.equal(entry.last_activation_error, ACTIVATION_ERROR);
        assert.ok(entry.last_activation_error_at);
        assert.equal(Object.hasOwn(entry, 'unresolved_requires'), false);
        assert.equal(runtime.attempts.length, attempt);
        assert.equal(registry.failureCalls.length, attempt);
        assert.deepEqual(registry.failureCalls.at(-1), [AGENT_ID, ACTIVATION_ERROR]);
        assert.deepEqual(registry.blockCalls, []);
      }

      assert.deepEqual(await runtime.activateAllInstalled(), []);
      assert.deepEqual(runtime.attempts, Array<string>(CIRCUIT_BREAKER_THRESHOLD).fill(AGENT_ID));
      assert.equal(registry.failureCalls.length, CIRCUIT_BREAKER_THRESHOLD);
      assert.deepEqual(logs, Array.from({ length: CIRCUIT_BREAKER_THRESHOLD }, () => [
        `[dynamic-runtime] activate FAILED for ${AGENT_ID}: ${ACTIVATION_ERROR}`,
      ]));
    });

    it(`contains a registry-write failure (${label}) without aborting boot`, async () => {
      const { runtime, registry, logs } = await makeRuntime(new Error(ACTIVATION_ERROR), failure);

      assert.deepEqual(await runtime.activateAllInstalled(), []);
      assert.deepEqual(registry.failureCalls, [[AGENT_ID, ACTIVATION_ERROR]]);
      assert.deepEqual(registry.blockCalls, []);
      assert.deepEqual(logs, [
        [`[dynamic-runtime] activate FAILED for ${AGENT_ID}: ${ACTIVATION_ERROR}`],
        [`[dynamic-runtime] registry markActivationFailed FAILED for ${AGENT_ID}: ${ACTIVATION_ERROR}`],
      ]);
    });
  }
});
