import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yazl from 'yazl';

import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type {
  UploadedPackage,
  UploadedPackageStore,
} from '../src/plugins/uploadedPackageStore.js';

/**
 * Ingest-path coverage for the scan-scheduler seam (issue #453): the
 * advisory code scan is fire-and-forget and must never affect the ingest
 * result — present, absent, throwing, or rejecting.
 */

const MANIFEST_YAML = `schema_version: "1"

identity:
  id: "@test/scan-target"
  name: "Scan Target"
  version: "1.0.0"
  kind: "tool"
  description: "Fixture plugin for ingest tests."

compat:
  core: ">=1.0 <2.0"

lifecycle:
  entry: "dist/plugin.js"
`;

function buildZip(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    for (const [name, content] of Object.entries(files)) {
      zip.addBuffer(Buffer.from(content, 'utf-8'), name, { mtime: new Date(0) });
    }
    zip.end();
  });
}

function fixtureZip(): Promise<Buffer> {
  return buildZip({
    'manifest.yaml': MANIFEST_YAML,
    'dist/plugin.js': 'module.exports = { activate() {} };\n',
  });
}

function fakeStore(): UploadedPackageStore {
  const packages = new Map<string, UploadedPackage>();
  return {
    get: (id: string) => packages.get(id),
    list: () => [...packages.values()],
    register: async (pkg: UploadedPackage) => {
      packages.set(pkg.id, pkg);
    },
  } as unknown as UploadedPackageStore;
}

function fakeCatalog(): PluginCatalog {
  return {
    get: () => undefined,
    load: async () => undefined,
    list: () => [],
    // #789 — see the note on the shared helper in _helpers/pluginPackageZip.ts.
    // This fixture's plugin id is `@test/scan-target`, which nothing bundles.
    isBundledId: () => false,
  } as unknown as PluginCatalog;
}

describe('PackageUploadService ingest × scan scheduler (issue #453)', () => {
  let packagesDir: string;

  beforeEach(async () => {
    packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-test-'));
  });

  afterEach(async () => {
    await fs.rm(packagesDir, { recursive: true, force: true });
  });

  function service(
    scanScheduler?: ConstructorParameters<typeof PackageUploadService>[0]['scanScheduler'],
  ): PackageUploadService {
    return new PackageUploadService({
      store: fakeStore(),
      catalog: fakeCatalog(),
      packagesDir,
      limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
      hostDependencies: {},
      ...(scanScheduler ? { scanScheduler } : {}),
      log: () => undefined,
    });
  }

  it('invokes the scheduler with the ZIP sha256, plugin id, and final dir', async () => {
    const calls: { sha256: string; pluginId: string; installedDir: string }[] = [];
    let resolveScheduled: () => void;
    const scheduled = new Promise<void>((r) => {
      resolveScheduled = r;
    });
    const svc = service({
      scheduleScan: async (input) => {
        calls.push(input);
        resolveScheduled();
      },
    });

    const buffer = await fixtureZip();
    const result = await svc.ingest({
      fileBuffer: buffer,
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });

    assert.equal(result.ok, true);
    await scheduled;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.pluginId, '@test/scan-target');
    assert.equal(
      calls[0]!.sha256,
      createHash('sha256').update(buffer).digest('hex'),
    );
    assert.ok(calls[0]!.installedDir.startsWith(packagesDir));
    // The scheduler receives the post-move location, and the package is
    // actually there (scan runs against the final dir, not staging).
    await fs.access(path.join(calls[0]!.installedDir, 'manifest.yaml'));
  });

  it('ingest succeeds without a scheduler (dep is optional)', async () => {
    const result = await service().ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, true);
  });

  it('ingest succeeds when the scheduler throws synchronously', async () => {
    const svc = service({
      scheduleScan: () => {
        throw new Error('scheduler exploded');
      },
    });
    const result = await svc.ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, true);
  });

  it('ingest succeeds when the scheduler rejects asynchronously', async () => {
    const svc = service({
      scheduleScan: async () => {
        throw new Error('async scheduler failure');
      },
    });
    const result = await svc.ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, true);
  });

  // #453 codex review fix — the scanner skips node_modules, so an entry
  // point there would execute code the scan never saw while the store shows
  // a clean badge. Such packages are rejected at upload time.
  function manifestWithEntry(entry: string): string {
    return MANIFEST_YAML.replace('entry: "dist/plugin.js"', `entry: "${entry}"`);
  }

  it('rejects a lifecycle.entry inside node_modules (scanner blind spot)', async () => {
    const buffer = await buildZip({
      'manifest.yaml': manifestWithEntry('node_modules/payload/plugin.js'),
      'node_modules/payload/plugin.js': 'module.exports = { activate() {} };\n',
      'dist/plugin.js': '// decoy at the boilerplate location\n',
    });
    const result = await service().ingest({
      fileBuffer: buffer,
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'package.entry_unscannable');
  });

  it('rejects a lifecycle.entry inside a hidden directory', async () => {
    const buffer = await buildZip({
      'manifest.yaml': manifestWithEntry('.hidden/plugin.js'),
      '.hidden/plugin.js': 'module.exports = { activate() {} };\n',
    });
    const result = await service().ingest({
      fileBuffer: buffer,
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'package.entry_unscannable');
  });

  it('still accepts the boilerplate dist/plugin.js entry', async () => {
    const result = await service().ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, true);
  });

  // #1401 — the rejection text is German (no request locale); `params` lets
  // the web UI render the code in the operator's locale instead.
  it('sends params with a duplicate-version rejection', async () => {
    const svc = service();
    const upload = async (): Promise<unknown> =>
      svc.ingest({
        fileBuffer: await fixtureZip(),
        originalFilename: 'scan-target.zip',
        uploadedBy: 'test@example.com',
      });
    assert.equal((await upload() as { ok: boolean }).ok, true);
    const second = (await upload()) as { ok: boolean; code: string; params?: unknown };
    assert.equal(second.ok, false);
    assert.equal(second.code, 'package.duplicate_version');
    assert.deepEqual(second.params, { pluginId: '@test/scan-target', version: '1.0.0' });
  });

  it('sends the missing entry path as a param', async () => {
    const buffer = await buildZip({ 'manifest.yaml': manifestWithEntry('dist/missing.js') });
    const result = (await service().ingest({
      fileBuffer: buffer,
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    })) as { code: string; params?: unknown };
    assert.equal(result.code, 'package.entry_missing');
    assert.deepEqual(result.params, { entry: 'dist/missing.js' });
  });

  it('sends the size limit as a param', async () => {
    const result = (await service().ingest({
      fileBuffer: Buffer.alloc(1024 * 1024 + 1),
      originalFilename: 'big.zip',
      uploadedBy: 'test@example.com',
    })) as { code: string; params?: unknown };
    assert.equal(result.code, 'package.too_large');
    assert.deepEqual(result.params, { maxBytes: String(1024 * 1024) });
  });
});

/**
 * #1452 — an activation failure at the upload seam must not read as `active`.
 *
 * `ingest()` calls `onPackageReady` for a plugin whose registry entry is
 * already `active` (the update / re-upload path). That hook is the thing that
 * actually (re)activates the plugin, and its throw used to be caught, logged,
 * and dropped: the registry kept `status: 'active'` with
 * `last_activation_error: null` over a plugin whose `undo()` had already rolled
 * everything back, and the store badge kept showing the last SUCCESSFUL
 * activation. Only the third failed boot activation flipped the entry, via the
 * circuit breaker.
 *
 * This is the same bug `installServiceActivationTruthful.test.ts` pins for the
 * install path (#799 / #825); the upload path was never part of that change.
 *
 * The real `InMemoryInstalledRegistry` is used rather than a fake, so the
 * assertion that ONE failure flips the status is made against the authentic
 * `CIRCUIT_BREAKER_THRESHOLD = 3` counting — a fake would make the bug
 * unreachable by construction.
 */
describe('PackageUploadService ingest × activation failure (issue #1452)', () => {
  let packagesDir: string;

  beforeEach(async () => {
    packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-activation-'));
  });

  afterEach(async () => {
    await fs.rm(packagesDir, { recursive: true, force: true });
  });

  const PLUGIN_ID = '@test/scan-target';

  /** A plugin that is installed and running — the state an update lands on. */
  async function activeRegistry(): Promise<InMemoryInstalledRegistry> {
    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: PLUGIN_ID,
      installed_version: '1.0.0',
      installed_at: '2026-10-01T00:00:00.000Z',
      status: 'active',
      config: {},
      last_activated_at: '2026-10-01T00:00:00.000Z',
    });
    return registry;
  }

  function service(
    registry: InMemoryInstalledRegistry,
    onPackageReady: (agentId: string) => Promise<void>,
  ): PackageUploadService {
    return new PackageUploadService({
      store: fakeStore(),
      catalog: fakeCatalog(),
      packagesDir,
      limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
      hostDependencies: {},
      registry,
      onPackageReady,
      log: () => undefined,
    });
  }

  async function ingest(svc: PackageUploadService) {
    return svc.ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
  }

  it('flips the entry to errored and records the reason when the hook throws', async () => {
    const registry = await activeRegistry();
    const result = await ingest(
      service(registry, async () => {
        throw new Error(
          "plugin '@test/scan-target' called ctx.services.get('entityRefBus') but its manifest does not declare that capability",
        );
      }),
    );

    assert.equal(result.ok, true, 'the ingest itself succeeded');
    const entry = registry.get(PLUGIN_ID);
    assert.equal(entry?.status, 'errored');
    assert.match(entry?.last_activation_error ?? '', /entityRefBus/);
    assert.equal(
      entry?.activation_failure_count,
      1,
      'one failure is enough — the operator must not wait for the circuit breaker',
    );
    assert.equal(
      (result as { activation_error?: string }).activation_error,
      entry?.last_activation_error,
      'the caller is told the same thing the registry was told',
    );
  });

  it('lifts a previous errored state when the next update activates', async () => {
    const registry = await activeRegistry();
    await registry.register({
      ...registry.get(PLUGIN_ID)!,
      status: 'errored',
      activation_failure_count: 1,
      last_activation_error: 'boom',
      last_activation_error_at: '2026-10-02T00:00:00.000Z',
    });

    const result = await ingest(service(registry, async () => undefined));

    assert.equal(result.ok, true);
    assert.equal((result as { activation_error?: string }).activation_error, undefined);
    const entry = registry.get(PLUGIN_ID);
    assert.equal(entry?.status, 'active', 'the fixed version must stop reading errored');
    assert.equal(entry?.last_activation_error, undefined);
    assert.ok(entry?.last_activated_at, 'and the successful activation is stamped');
  });

  it('keeps the unresolved_requires list when the update fails again', async () => {
    // A tool plugin latched `errored` at boot because a provider was missing:
    // `toolPluginRuntime` stored the requires list alongside the error, and
    // `bootstrap.retryErroredPlugins` reads exactly that list to auto-reset the
    // plugin once the operator installs the provider. `markActivationFailed`
    // treats an omitted list as "clear it", so recording a second failure
    // without forwarding it would strand the plugin: skipped on every
    // subsequent boot with nothing left to re-check.
    const registry = await activeRegistry();
    await registry.register({
      ...registry.get(PLUGIN_ID)!,
      status: 'errored',
      activation_failure_count: 1,
      last_activation_error: 'unresolved: @omadia/foo@1',
      unresolved_requires: ['@omadia/foo@1'],
    });

    await ingest(
      service(registry, async () => {
        throw new Error('still unresolved: @omadia/foo@1');
      }),
    );

    assert.deepEqual(registry.get(PLUGIN_ID)?.unresolved_requires, ['@omadia/foo@1']);
  });

  it('records a reason even when the hook throws without a message', async () => {
    // `new Error()` → `err.message` is ''. Every consumer tests truthiness:
    // the UI would show no error, `computeReadiness` would emit no
    // `error_detail`, and the entry would sit `errored` with the reason
    // available nowhere — the exact state this change exists to remove.
    const registry = await activeRegistry();
    const result = await ingest(
      service(registry, async () => {
        throw new Error('');
      }),
    );

    const reported = (result as { activation_error?: string }).activation_error;
    assert.ok(reported && reported.length > 0, 'the caller gets something to show');
    assert.ok(
      (registry.get(PLUGIN_ID)?.last_activation_error ?? '').length > 0,
      'and so does the next operator reading the registry',
    );
  });

  it('leaves a plugin that is not installed to the install flow', async () => {
    const registry = new InMemoryInstalledRegistry();
    let called = false;
    const result = await ingest(
      service(registry, async () => {
        called = true;
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(called, false, 'nothing to reactivate — the install flow activates and reports');
    assert.equal(registry.get(PLUGIN_ID), undefined, 'and no entry is invented');
  });

  it('does not reactivate a plugin whose activation was blocked', async () => {
    // OM-87 `markActivationBlocked` is documented as non-retryable ("retries
    // cannot fix the configuration conflict") and the conflict is re-checked
    // at boot in `resolveEligiblePlugins`, not in `activate()`. It shares the
    // `errored` status with a plain failure, and floors the failure count at
    // the circuit-breaker threshold — which is the signal the gate reads.
    // Without it, any re-upload would activate a blocked plugin and the
    // success write would clear the block until the next boot.
    const registry = await activeRegistry();
    await registry.markActivationBlocked(PLUGIN_ID, 'two providers claim office@1');
    let called = false;
    await ingest(
      service(registry, async () => {
        called = true;
      }),
    );

    assert.equal(called, false);
    assert.equal(registry.get(PLUGIN_ID)?.status, 'errored');
    assert.match(registry.get(PLUGIN_ID)?.last_activation_error ?? '', /two providers/);
  });

  it('does not reactivate a plugin the circuit breaker has latched', async () => {
    // Three consecutive boot failures: the breaker exists so a plugin that
    // cannot come up stops being retried on every boot. An upload must not
    // walk around it — `bootstrap.retryErroredPlugins` is what lifts this
    // state, on evidence (manifest mtime, resolvable capability, transient
    // error fingerprint).
    const registry = await activeRegistry();
    for (let i = 0; i < 3; i++) {
      await registry.markActivationFailed(PLUGIN_ID, 'boom');
    }
    let called = false;
    await ingest(
      service(registry, async () => {
        called = true;
      }),
    );

    assert.equal(called, false);
    assert.equal(registry.get(PLUGIN_ID)?.status, 'errored');
  });

  it('does not restart a plugin that was deliberately stood down', async () => {
    const registry = await activeRegistry();
    await registry.register({ ...registry.get(PLUGIN_ID)!, status: 'inactive' });
    let called = false;
    await ingest(
      service(registry, async () => {
        called = true;
      }),
    );

    assert.equal(called, false);
    assert.equal(registry.get(PLUGIN_ID)?.status, 'inactive');
  });
});
