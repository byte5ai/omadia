/**
 * Epic #470 — hardening the C2b service gate: issues #788 and #789.
 *
 * Both bugs come from the same root: the gate trusted a STRING the plugin
 * author chose. #788 trusted `provides:` — a self-declaration that costs
 * nothing at activation — as proof the plugin held the implementation. #789
 * trusted `identity.id` as proof a package was the package that id belongs to,
 * even though `PluginCatalog` lets an upload win an id collision outright.
 *
 * WHAT EACH TEST WOULD LOOK LIKE IF THE FIX WERE REVERTED (the counter-proofs
 * are in this file, not only in the PR body, because a gate test that cannot
 * fail is decoration):
 *
 *   - drop the `isRegisteredByPlugin(name)` call in `classifyServiceGrant` and
 *     go back to returning 'self-provided' → §1's throw cases resolve the other
 *     plugin's object instead;
 *   - read `LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20[agentId]` directly
 *     instead of going through `legacyServiceGrantsFor` → §2's shadowing cases
 *     inherit all nineteen of `@omadia/orchestrator`'s grandfathered names;
 *   - delete the `isBundledId` branch in `PackageUploadService.ingest` → §3's
 *     upload lands.
 *
 * Each of those three reversions is asserted against here from BOTH sides: the
 * case that must throw AND the neighbouring case that must still work. A gate
 * is only worth having if it is the narrow one, and "everything now throws" is
 * a way to pass every deny-test at once.
 */

import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, afterEach } from 'node:test';

import yazl from 'yazl';

import { ServiceNotDeclaredError } from '@omadia/plugin-api';

import type { Plugin } from '../src/api/admin-v1.js';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import type {
  UploadedPackage,
  UploadedPackageStore,
} from '../src/plugins/uploadedPackageStore.js';
import { createPluginContext } from '../src/platform/pluginContext.js';
import type { CreatePluginContextOptions } from '../src/platform/pluginContext.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import {
  BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20,
  LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20,
  STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20,
  classifyServiceGrant,
  declaredServiceNames,
  legacyServiceGrantsFor,
} from '../src/platform/pluginServiceGrants.js';

// --- fixtures --------------------------------------------------------------

const rawManifests = new WeakMap<Plugin, unknown>();

/** Built through the real `adaptManifestV1`, never hand-rolled: the gate reads
 *  fields the adapter produces, so a fixture that skipped it could stay green
 *  while the adapter dropped the very entries under test. */
function pluginOf(spec: {
  id: string;
  requires?: string[];
  optional_requires?: string[];
  provides?: string[];
}): Plugin {
  const manifest = {
    schema_version: '1',
    identity: {
      id: spec.id,
      name: spec.id,
      version: '1.0.0',
      kind: 'extension',
      domain: 'test.hardening',
    },
    requires: spec.requires ?? [],
    ...(spec.optional_requires ? { optional_requires: spec.optional_requires } : {}),
    provides: spec.provides ?? [],
    permissions: {},
  };
  const plugin = adaptManifestV1(manifest);
  assert.ok(plugin, `fixture manifest for ${spec.id} must adapt`);
  rawManifests.set(plugin, manifest);
  return plugin;
}

/**
 * A catalog whose `origin` and `isBundledId` set are set INDEPENDENTLY.
 *
 * That independence is the whole fixture. The #789 case is precisely where the
 * two disagree — an installed package occupying an id the image ships — and a
 * helper that derived `isBundledId` from `origin` could not express it.
 */
function catalogOf(
  plugins: Plugin[],
  opts: {
    origin?: 'bundled' | 'installed';
    bundledIds?: readonly string[];
  } = {},
): PluginCatalog {
  const origin = opts.origin ?? 'installed';
  const entries = new Map(
    plugins.map((plugin) => [
      plugin.id,
      {
        plugin,
        manifest: rawManifests.get(plugin) ?? {},
        source_path: 'test',
        source_kind: 'manifest-v1',
        origin,
      },
    ]),
  );
  const bundled = new Set(
    opts.bundledIds ?? (origin === 'bundled' ? plugins.map((p) => p.id) : []),
  );
  return {
    get: (id: string) => entries.get(id),
    list: () => [...entries.values()],
    isBundledId: (id: string) => bundled.has(id),
  } as unknown as PluginCatalog;
}

function makeCtx(
  agentId: string,
  catalog: PluginCatalog,
  registry = new ServiceRegistry(),
): {
  ctx: ReturnType<typeof createPluginContext>;
  registry: ServiceRegistry;
  logs: string[];
} {
  const stub = (): (() => void) => (): void => {};
  const logs: string[] = [];
  const ctx = createPluginContext({
    agentId,
    vault: {
      get: async (): Promise<undefined> => undefined,
      listKeys: async (): Promise<string[]> => [],
    },
    registry: { has: () => true, list: () => [], get: () => undefined },
    catalog,
    serviceRegistry: registry,
    nativeToolRegistry: { register: stub, registerHandler: stub },
    routeRegistry: { register: stub, disposeBySource: () => 0 },
    jobScheduler: { register: stub, stopForPlugin: (): void => {} },
    notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
    uiRouteCatalog: { register: stub, registerNav: stub },
    logger: (...args: unknown[]): void => {
      logs.push(args.map(String).join(' '));
    },
  } as unknown as CreatePluginContextOptions);
  return { ctx, registry, logs };
}

/** `classifyServiceGrant` with the declared set and the registry answer both
 *  derived from the same fixture, so a test cannot accidentally assert against
 *  a declaration set that does not match the manifest it built. */
function classify(
  agentId: string,
  name: string,
  catalog: PluginCatalog,
  registry: ServiceRegistry,
): string {
  return classifyServiceGrant(
    agentId,
    name,
    declaredServiceNames(agentId, catalog),
    catalog,
    (candidate) => registry.providedBy(agentId, candidate),
  );
}

// --- 1. #788: `provides:` grants nothing until it is provided ---------------

describe('#788 — a `provides:` entry is a claim, not a grant', () => {
  const VICTIM = '@test/real-pool-owner';
  const CLAIMANT = '@test/claims-to-provide';

  /**
   * The attack from the issue, in one fixture: someone ELSE registered
   * `tigrisStore`, and the claimant's only connection to the name is a YAML
   * line it wrote about itself.
   *
   * `tigrisStore` rather than `graphPool` ON PURPOSE, even though the issue
   * names the pool. `graphPool` is pool-shaped, so C7's SQL gate throws at it
   * independently of anything C2b decides — a fixture built on it passes these
   * tests with the #788 fix reverted, which would make them decoration. The
   * capability under test has to be one where THIS gate is the only thing
   * standing in the way. `graphPool`'s second lock is asserted separately
   * below, as a second lock rather than as this one.
   */
  function attackFixture(): {
    catalog: PluginCatalog;
    registry: ServiceRegistry;
    victimImpl: { theRealOne: boolean };
  } {
    const catalog = catalogOf([
      pluginOf({ id: VICTIM, provides: ['tigrisStore@1'] }),
      pluginOf({ id: CLAIMANT, provides: ['tigrisStore@1'] }),
    ]);
    const registry = new ServiceRegistry();
    const victimImpl = { theRealOne: true };
    registry.provide('tigrisStore', victimImpl, VICTIM);
    return { catalog, registry, victimImpl };
  }

  it('throws when the plugin declares `provides:` but never provided it', () => {
    const { catalog, registry } = attackFixture();
    const { ctx } = makeCtx(CLAIMANT, catalog, registry);

    assert.throws(
      () => ctx.services.get('tigrisStore'),
      (err: unknown) => {
        assert.ok(
          err instanceof ServiceNotDeclaredError,
          'must be the typed error so a plugin can tell a manifest bug from a missing provider',
        );
        assert.equal(err.capability, 'tigrisStore');
        assert.equal(err.pluginId, CLAIMANT);
        assert.equal(
          err.reason,
          'provides-not-registered',
          'the reason must name the DISTINCTION — this author has declared the capability, their bug is the order of two calls, and sending them to the manifest would be sending them to the wrong file',
        );
        assert.match(err.message, /provides:/);
        assert.match(err.message, /ctx\.services\.provide/);
        return true;
      },
    );
  });

  it('does not leak the real provider\'s object through the failed read', () => {
    // The counter-proof for the counter-proof: it is not enough that a throw
    // happens somewhere, the OTHER plugin's implementation must never be
    // reachable. Reverting the fix makes this return `pool`.
    const { catalog, registry, victimImpl } = attackFixture();
    const { ctx } = makeCtx(CLAIMANT, catalog, registry);
    let resolved: unknown = 'not-called';
    try {
      resolved = ctx.services.get('tigrisStore');
    } catch {
      resolved = 'threw';
    }
    assert.equal(resolved, 'threw');
    assert.notEqual(
      resolved,
      victimImpl,
      "the claimant must never hold the victim's implementation",
    );
  });

  it('still lets C7 refuse graphPool independently, once C2b lets it through', () => {
    // The capability the issue actually names, asserted as what it is: a
    // capability behind TWO locks that retire on different schedules. Here the
    // #788 lock is satisfied — the plugin really did provide `graphPool` — and
    // the SQL gate must still refuse, because a `provides:` line is not an
    // operator's consent to hand over the database. This is also what keeps
    // the fixture choice above honest: it documents why the other tests in
    // this block deliberately do NOT use `graphPool`.
    const catalog = catalogOf([
      pluginOf({ id: CLAIMANT, provides: ['graphPool@1'] }),
    ]);
    const { ctx, registry } = makeCtx(CLAIMANT, catalog);
    ctx.services.provide('graphPool', { pool: true });
    assert.equal(
      classify(CLAIMANT, 'graphPool', catalog, registry),
      'self-provided',
      'the #788 gate is satisfied — the plugin genuinely registered the name',
    );
    assert.throws(
      () => ctx.services.get('graphPool'),
      /permissions\.sql|SqlPermission/,
      'C7 must refuse the pool on its own terms even when C2b is satisfied',
    );
  });

  it('resolves once the plugin has actually provided the name', () => {
    const catalog = catalogOf([
      pluginOf({ id: CLAIMANT, provides: ['memoryStore@1'] }),
    ]);
    const { ctx, registry } = makeCtx(CLAIMANT, catalog);

    assert.throws(
      () => ctx.services.get('memoryStore'),
      ServiceNotDeclaredError,
      'before provide(): nothing of this plugin\'s exists to read back',
    );

    const impl = { own: true };
    ctx.services.provide('memoryStore', impl);

    assert.equal(
      ctx.services.get('memoryStore'),
      impl,
      'after provide(): the gate must get out of the way — a provider that could not read back its own registration would be a worse bug than the one being fixed',
    );
    assert.equal(classify(CLAIMANT, 'memoryStore', catalog, registry), 'self-provided');
  });

  it('is evaluated per call, not snapshotted when the context is built', () => {
    // The ordering trap. `createPluginContext` runs at ACTIVATION, before the
    // plugin's `activate()` has provided anything. A gate that computed the
    // registration set once at construction would deny every provider its own
    // capability forever — and would still pass the "throws before provide"
    // test above.
    const catalog = catalogOf([
      pluginOf({ id: CLAIMANT, provides: ['reportStore@1'] }),
    ]);
    const { ctx } = makeCtx(CLAIMANT, catalog);
    const impl = { reports: true };
    const dispose = ctx.services.provide('reportStore', impl);
    assert.equal(ctx.services.get('reportStore'), impl);
    dispose();
    assert.throws(
      () => ctx.services.get('reportStore'),
      ServiceNotDeclaredError,
      'releasing the registration must close the grant again — otherwise "provided once" would be a permanent capability',
    );
  });

  it('leaves a name declared under `requires:` alone, even unprovided', () => {
    // The narrowness proof. #788 must not turn into "everything throws": a
    // dependency declaration was already paid for at activation and grants the
    // name outright.
    const catalog = catalogOf([
      pluginOf({ id: CLAIMANT, requires: ['knowledgeGraph@^1'] }),
    ]);
    const { ctx, registry } = makeCtx(CLAIMANT, catalog);
    const kg = { graph: true };
    registry.provide('knowledgeGraph', kg, VICTIM);
    assert.equal(ctx.services.get('knowledgeGraph'), kg);
    assert.equal(classify(CLAIMANT, 'knowledgeGraph', catalog, registry), 'declared');
  });

  it('leaves a name in BOTH `requires:` and `provides:` alone', () => {
    // The `replace()` wrapping pattern (orchestrator-extras wraps
    // `knowledgeGraph`). It consumes the capability AND re-registers a
    // decorated version, so it must be able to read the original BEFORE it has
    // provided anything of its own.
    const catalog = catalogOf([
      pluginOf({
        id: CLAIMANT,
        requires: ['knowledgeGraph@^1'],
        provides: ['knowledgeGraph@1'],
      }),
    ]);
    const { ctx, registry } = makeCtx(CLAIMANT, catalog);
    const original = { original: true };
    registry.provide('knowledgeGraph', original, VICTIM);
    assert.equal(
      ctx.services.get('knowledgeGraph'),
      original,
      'a wrapper must reach the thing it wraps',
    );
    assert.equal(classify(CLAIMANT, 'knowledgeGraph', catalog, registry), 'declared');
  });

  it('leaves `optional_requires:` alone', () => {
    const catalog = catalogOf([
      pluginOf({ id: CLAIMANT, optional_requires: ['turnContext@1'] }),
    ]);
    const { ctx, registry } = makeCtx(CLAIMANT, catalog);
    assert.equal(
      ctx.services.get('turnContext'),
      undefined,
      'an optional dependency with no provider answers undefined, it does not throw',
    );
    assert.equal(classify(CLAIMANT, 'turnContext', catalog, registry), 'declared');
  });

  it('attributes registrations by the KERNEL id, not by the asking plugin', () => {
    // `providedBy` must not be satisfiable by somebody else's registration of
    // the same name. Both plugins declare `provides: graphPool@1`; only one
    // registered.
    const { catalog, registry } = attackFixture();
    assert.equal(registry.providedBy(VICTIM, 'tigrisStore'), true);
    assert.equal(
      registry.providedBy(CLAIMANT, 'tigrisStore'),
      false,
      'a registration belongs to the plugin that made it — otherwise every `provides:` claimant would ride on the first real provider',
    );
    assert.equal(classify(VICTIM, 'tigrisStore', catalog, registry), 'self-provided');
    assert.equal(
      classify(CLAIMANT, 'tigrisStore', catalog, registry),
      'provides-not-registered',
    );
  });

  it('survives a stacked replace: one disposal does not revoke a live grant', () => {
    // `replace` stacks, so a plugin can hold two registrations for one name.
    // A boolean "has this owner registered?" flag would flip to false on the
    // first disposal and silently revoke a grant that is still live.
    const registry = new ServiceRegistry();
    registry.provide('diagrams', { v: 1 }, VICTIM);
    const undoReplace = registry.replace('diagrams', { v: 2 }, VICTIM);
    assert.equal(registry.providedBy(VICTIM, 'diagrams'), true);
    undoReplace();
    assert.equal(
      registry.providedBy(VICTIM, 'diagrams'),
      true,
      'the original provide() is still live after the replacement is unwound',
    );
  });

  it('reports nothing provided after disposeBySource', () => {
    const registry = new ServiceRegistry();
    registry.provide('diagrams', { v: 1 }, VICTIM);
    registry.provide('memoryStore', { v: 1 }, VICTIM);
    assert.equal(registry.disposeBySource(VICTIM), 2);
    assert.equal(registry.providedBy(VICTIM, 'diagrams'), false);
    assert.equal(registry.providedBy(VICTIM, 'memoryStore'), false);
  });

  it('does not credit core\'s own unowned registrations to any plugin', () => {
    const registry = new ServiceRegistry();
    registry.provide('graphPool', { core: true });
    assert.equal(registry.providedBy('@omadia/core', 'graphPool'), false);
    assert.equal(registry.providedBy(CLAIMANT, 'graphPool'), false);
  });
});

// --- 2. #789: the legacy allowlist is not inheritable by id ----------------

describe('#789 — the dated legacy allowlist is keyed by more than an id', () => {
  const BUNDLED_ID = '@omadia/orchestrator';
  const STANDALONE_ID = '@omadia/channel-teams';

  it('grants a bundled package its bundled row', () => {
    const catalog = catalogOf([pluginOf({ id: BUNDLED_ID })], {
      origin: 'bundled',
    });
    assert.ok(
      legacyServiceGrantsFor(BUNDLED_ID, catalog).includes('graphPool'),
      'the ramp must still work for the code we ship, or this stops being a fix and becomes an outage',
    );
    const { ctx, registry } = makeCtx(BUNDLED_ID, catalog);
    const pool = { pool: true };
    registry.provide('graphPool', pool);
    assert.equal(ctx.services.get<typeof pool>('graphPool')?.pool, true);
  });

  it('grants an UPLOAD claiming that bundled id nothing at all', () => {
    // The reported bug. Same id, same manifest-free package; the only
    // difference is that the loader found it in the uploads directory.
    const catalog = catalogOf([pluginOf({ id: BUNDLED_ID })], {
      origin: 'installed',
      bundledIds: [BUNDLED_ID],
    });
    assert.deepEqual(legacyServiceGrantsFor(BUNDLED_ID, catalog), []);

    const { ctx, registry } = makeCtx(BUNDLED_ID, catalog);
    registry.provide('graphPool', { pool: true });
    assert.throws(
      () => ctx.services.get('graphPool'),
      ServiceNotDeclaredError,
      'an uploaded package must not inherit the grandfathered capabilities of the bundled plugin whose id it borrowed',
    );
  });

  it('refuses every one of the nineteen names, not just graphPool', () => {
    // A partial fix that closed only the capability named in the issue would
    // still hand over `tigrisStore`, `privacyRedact`, `processMemory`, …
    const catalog = catalogOf([pluginOf({ id: BUNDLED_ID })], {
      origin: 'installed',
      bundledIds: [BUNDLED_ID],
    });
    const { ctx } = makeCtx(BUNDLED_ID, catalog);
    const row = BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20[BUNDLED_ID] ?? [];
    assert.ok(row.length >= 19, 'fixture assumption: the orchestrator row is the big one');
    for (const name of row) {
      assert.throws(
        () => ctx.services.get(name),
        ServiceNotDeclaredError,
        `uploaded package inherited '${name}'`,
      );
    }
  });

  it('keeps granting a genuinely-installed Hub plugin its standalone row', () => {
    // The narrowness proof, and the reason this is not a blanket
    // "bundled-only" rule. `@omadia/channel-teams` ships from the Hub and is
    // ALWAYS `origin: 'installed'`; a blanket rule would strip thirteen
    // capabilities from a shipped plugin at the first turn after upgrade.
    const catalog = catalogOf([pluginOf({ id: STANDALONE_ID })], {
      origin: 'installed',
      bundledIds: [],
    });
    assert.ok(
      legacyServiceGrantsFor(STANDALONE_ID, catalog).includes('graphPool'),
      'a Hub plugin that this repo does not bundle must keep its ramp until its own manifest declares the capability',
    );
  });

  it('grants nothing to a bundled package sitting on a standalone-only id', () => {
    // The reverse carry-over. If `@omadia/channel-teams` ever moved back
    // in-tree it would need a fresh audit, not an inherited row.
    const catalog = catalogOf([pluginOf({ id: STANDALONE_ID })], {
      origin: 'bundled',
    });
    assert.deepEqual(legacyServiceGrantsFor(STANDALONE_ID, catalog), []);
  });

  it('grants nothing for an id the catalog cannot resolve', () => {
    assert.deepEqual(legacyServiceGrantsFor(BUNDLED_ID, catalogOf([])), []);
  });

  it('keeps the union in step with its two halves', () => {
    const union = Object.keys(LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20).sort();
    const halves = [
      ...Object.keys(BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20),
      ...Object.keys(STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20),
    ].sort();
    assert.deepEqual(union, halves, 'the audit record must not drift from what is enforced');
    // Disjoint: an id in both halves would make the union lossy and the
    // origin branch ambiguous.
    for (const id of Object.keys(BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20)) {
      assert.equal(
        STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20[id],
        undefined,
        `${id} appears in both halves`,
      );
    }
  });

  it('freezes both halves, so nothing can widen them at runtime', () => {
    for (const table of [
      BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20,
      STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20,
    ]) {
      assert.equal(Object.isFrozen(table), true);
      assert.throws(() => {
        (table as Record<string, readonly string[]>)['@test/attacker'] = ['graphPool'];
      });
      for (const row of Object.values(table)) {
        assert.throws(() => (row as string[]).push('graphPool'));
      }
    }
  });
});

// --- 3. #789: the ingest refusal ------------------------------------------

describe('#789 — uploads may not claim a bundled plugin id', () => {
  const OVERRIDE_ENV = 'PLUGIN_ALLOW_BUNDLED_ID_OVERRIDE';
  const BUNDLED_ID = '@omadia/orchestrator';
  const tempDirs: string[] = [];

  afterEach(async () => {
    delete process.env[OVERRIDE_ENV];
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  /** A minimal but REAL zip, built the same way `packageUploadService.test.ts`
   *  builds its fixtures — the refusal has to hold on the actual ingest path,
   *  not on a stub of it. */
  function zipOf(pluginId: string): Promise<Buffer> {
    const manifest = [
      'schema_version: "1"',
      '',
      'identity:',
      `  id: "${pluginId}"`,
      '  name: "Shadow Package"',
      '  version: "9.9.9"',
      '  kind: "tool"',
      '  description: "Fixture claiming a bundled id."',
      '',
      'compat:',
      '  core: ">=1.0 <2.0"',
      '',
      'lifecycle:',
      '  entry: "dist/plugin.js"',
      '',
    ].join('\n');
    return new Promise((resolve, reject) => {
      const zip = new yazl.ZipFile();
      const chunks: Buffer[] = [];
      zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
      zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
      zip.outputStream.on('error', reject);
      zip.addBuffer(Buffer.from(manifest, 'utf-8'), 'manifest.yaml', {
        mtime: new Date(0),
      });
      zip.addBuffer(
        Buffer.from('module.exports = { activate() {} };\n', 'utf-8'),
        'dist/plugin.js',
        { mtime: new Date(0) },
      );
      zip.end();
    });
  }

  async function ingest(
    pluginId: string,
    bundledIds: readonly string[],
  ): Promise<{ ok: boolean; code?: string }> {
    const packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omadia-789-'));
    tempDirs.push(packagesDir);
    const bundled = new Set(bundledIds);
    const stored = new Map<string, UploadedPackage>();
    const service = new PackageUploadService({
      store: {
        get: (id: string) => stored.get(id),
        list: () => [...stored.values()],
        register: async (pkg: UploadedPackage) => {
          stored.set(pkg.id, pkg);
        },
      } as unknown as UploadedPackageStore,
      catalog: {
        get: () => undefined,
        list: () => [],
        load: async () => undefined,
        isBundledId: (id: string) => bundled.has(id),
      } as unknown as PluginCatalog,
      packagesDir,
      limits: {
        maxBytes: 1024 * 1024,
        maxExtractedBytes: 4 * 1024 * 1024,
        maxEntries: 50,
      },
      hostDependencies: {},
      log: () => undefined,
    });

    const result = await service.ingest({
      fileBuffer: await zipOf(pluginId),
      originalFilename: 'shadow.zip',
      uploadedBy: 'test@byte5.de',
    });
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  }

  it('refuses a package whose identity.id is a bundled id', async () => {
    const result = await ingest(BUNDLED_ID, [BUNDLED_ID]);
    assert.equal(result.ok, false);
    assert.equal(
      result.code,
      'package.id_conflict_bundled',
      'a distinct code, because the operator fix is distinct: pick another id, or opt in deliberately',
    );
  });

  it('accepts the same package once the operator sets the override to exactly 1', async () => {
    process.env[OVERRIDE_ENV] = '1';
    const result = await ingest(BUNDLED_ID, [BUNDLED_ID]);
    assert.equal(
      result.ok,
      true,
      'an operator with a genuine need must have a documented way through, or they will patch the gate out',
    );
  });

  it('is not disarmed by a near-miss override value', async () => {
    for (const value of ['true', 'yes', 'TRUE', '0', '']) {
      process.env[OVERRIDE_ENV] = value;
      const result = await ingest(BUNDLED_ID, [BUNDLED_ID]);
      assert.equal(result.ok, false, `override accepted '${value}'`);
      assert.equal(result.code, 'package.id_conflict_bundled');
    }
  });

  it('leaves an ordinary, non-bundled id alone', async () => {
    // Narrowness again: the refusal must not become "no uploads".
    const result = await ingest('@acme/my-own-plugin', [BUNDLED_ID]);
    assert.equal(result.ok, true);
  });

  it('does NOT grant the override-installed package the bundled legacy rows', async () => {
    // The two locks are independent, and this is the one that matters. Even
    // when the operator waves the package through ingest, it arrives as
    // `origin: 'installed'` on a bundled id — so the grant gate still gives it
    // nothing. An override that also handed over `graphPool` would have turned
    // an install decision into a database decision.
    const catalog = catalogOf([pluginOf({ id: BUNDLED_ID })], {
      origin: 'installed',
      bundledIds: [BUNDLED_ID],
    });
    assert.deepEqual(legacyServiceGrantsFor(BUNDLED_ID, catalog), []);
  });
});
