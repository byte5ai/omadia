import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OB-41: single source of truth for external asset paths the runtime needs
 * but that do not live inside `dist/`. Replaces the per-file `process.env.X
 * ?? path.resolve(import.meta.url, '../../../../docs/...')` pattern that
 * produced six path-from-dist bugs on 2026-05-06 — every consumer used a
 * different relative-`..` count, every fix needed its own env-var, and any
 * new asset path reproduced the trap.
 *
 * The rules:
 *   - One env-var per logical bundle. Production sets it via the Dockerfile.
 *   - One dev-fallback path, computed once relative to this module.
 *   - One `verify()` per bundle, run as a Promise.all batch via
 *     `verifyAssetBundles()` BEFORE `PluginCatalog.load()` in `index.ts`.
 *     Failure aborts boot with a clear "set ENV or COPY ..." message rather
 *     than letting the process crashloop on the first read.
 *
 * `previewRuntime.templateNodeModulesPath` is intentionally NOT in here —
 * it points at the build-template's `node_modules`, which is a data-dir
 * (lives under `BUILDER_DIR` from `paths.ts`), not an asset bundle.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIDDLEWARE_ROOT = path.resolve(HERE, '..', '..'); // <repo>/middleware

export interface AssetBundle {
  /** Logical id, e.g. 'boilerplate'. Surfaced in error messages. */
  readonly id: string;
  /** Resolved absolute path. Already `path.resolve()`-d. */
  readonly root: string;
  readonly kind: 'directory' | 'file';
  /** Where `root` came from — useful for boot logs + debugging. */
  readonly source: 'env' | 'devFallback';
  readonly envVar: string;
  /** Existence + kind check. Throws with `set <ENV> or <prodHint>` on miss. */
  verify(): Promise<void>;
}

interface ResolveOpts {
  id: string;
  envVar: string;
  /** Absolute path used when the env-var is unset. */
  devFallback: string;
  /** Free-text Dockerfile/COPY hint surfaced in failure messages. */
  prodHint: string;
  kind: 'directory' | 'file';
}

export function resolveAssetBundle(opts: ResolveOpts): AssetBundle {
  const envValue = process.env[opts.envVar];
  const useEnv = typeof envValue === 'string' && envValue.length > 0;
  const root = useEnv ? path.resolve(envValue) : opts.devFallback;
  const source: AssetBundle['source'] = useEnv ? 'env' : 'devFallback';
  return {
    id: opts.id,
    root,
    kind: opts.kind,
    source,
    envVar: opts.envVar,
    async verify(): Promise<void> {
      let stat;
      try {
        stat = await fs.stat(root);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const reason = code === 'ENOENT' ? 'not found' : (err as Error).message;
        throw new Error(
          `Asset bundle '${opts.id}' (${opts.kind}) missing at ${root} (${reason}). ` +
            `Set ${opts.envVar} or ensure: ${opts.prodHint}.`,
        );
      }
      if (opts.kind === 'directory' && !stat.isDirectory()) {
        throw new Error(
          `Asset bundle '${opts.id}' at ${root} is not a directory. ` +
            `Set ${opts.envVar} or ensure: ${opts.prodHint}.`,
        );
      }
      if (opts.kind === 'file' && !stat.isFile()) {
        throw new Error(
          `Asset bundle '${opts.id}' at ${root} is not a file. ` +
            `Set ${opts.envVar} or ensure: ${opts.prodHint}.`,
        );
      }
    },
  };
}

/**
 * Eager registry. Callers reach for `ASSETS.boilerplate.root` directly —
 * the resolver has already happened at module-load. Tests that need a
 * different root must set the env-var BEFORE importing any module that
 * pulls in assets.ts (that is the existing convention for paths.ts and
 * boilerplateSource.ts).
 */
export const ASSETS = {
  /** middleware/assets/boilerplate/ — codegen template tree. */
  boilerplate: resolveAssetBundle({
    id: 'boilerplate',
    envVar: 'BUILDER_BOILERPLATE_DIR',
    devFallback: path.join(MIDDLEWARE_ROOT, 'assets', 'boilerplate'),
    prodHint: 'COPY middleware/assets/boilerplate ./boilerplate (Dockerfile)',
    kind: 'directory',
  }),
  /** middleware/assets/entity-registry.v1.yaml — vocabulary autocomplete. */
  entityRegistry: resolveAssetBundle({
    id: 'entityRegistry',
    envVar: 'BUILDER_ENTITY_REGISTRY_PATH',
    devFallback: path.join(
      MIDDLEWARE_ROOT,
      'assets',
      'entity-registry.v1.yaml',
    ),
    prodHint:
      'COPY middleware/assets/entity-registry.v1.yaml ./entity-registry.v1.yaml (Dockerfile)',
    kind: 'file',
  }),
  /** middleware/packages/agent-reference-maximum — Builder pattern source. */
  referencePackage: resolveAssetBundle({
    id: 'referencePackage',
    envVar: 'BUILDER_REFERENCE_PACKAGE_DIR',
    devFallback: path.join(MIDDLEWARE_ROOT, 'packages', 'agent-reference-maximum'),
    prodHint:
      'COPY middleware/packages → /app/packages (Dockerfile, already covered by packages/-tree COPY)',
    kind: 'directory',
  }),
} as const;

export type AssetBundleId = keyof typeof ASSETS;

/**
 * Boot-time gate. Run BEFORE `pluginCatalog.load()` in `index.ts`. On
 * failure throws an aggregated Error so the operator sees every missing
 * bundle in one shot instead of fixing them one boot at a time.
 */
export async function verifyAssetBundles(): Promise<void> {
  const results = await Promise.allSettled(
    Object.values(ASSETS).map((bundle) => bundle.verify()),
  );
  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
  if (failures.length > 0) {
    throw new Error(
      `Asset bundle verification failed (${failures.length} of ${results.length}):\n` +
        failures.map((m) => `  - ${m}`).join('\n'),
    );
  }
}

/**
 * Test-only: rebuild ASSETS from the current `process.env` snapshot. Avoids
 * a full module reload when a unit test wants to mutate env-vars between
 * cases without reaching for `vi.resetModules()`. NOT exported through the
 * platform barrel; tests import the symbol directly.
 */
export function _rebuildAssetsForTests(): void {
  const next = {
    boilerplate: resolveAssetBundle({
      id: 'boilerplate',
      envVar: 'BUILDER_BOILERPLATE_DIR',
      devFallback: path.join(MIDDLEWARE_ROOT, 'assets', 'boilerplate'),
      prodHint: 'COPY middleware/assets/boilerplate ./boilerplate (Dockerfile)',
      kind: 'directory',
    }),
    entityRegistry: resolveAssetBundle({
      id: 'entityRegistry',
      envVar: 'BUILDER_ENTITY_REGISTRY_PATH',
      devFallback: path.join(
        MIDDLEWARE_ROOT,
        'assets',
        'entity-registry.v1.yaml',
      ),
      prodHint:
        'COPY middleware/assets/entity-registry.v1.yaml ./entity-registry.v1.yaml (Dockerfile)',
      kind: 'file',
    }),
    referencePackage: resolveAssetBundle({
      id: 'referencePackage',
      envVar: 'BUILDER_REFERENCE_PACKAGE_DIR',
      devFallback: path.join(
        MIDDLEWARE_ROOT,
        'packages',
        'agent-reference-maximum',
      ),
      prodHint:
        'COPY middleware/packages → /app/packages (Dockerfile, already covered by packages/-tree COPY)',
      kind: 'directory',
    }),
  };
  (ASSETS as unknown as Record<AssetBundleId, AssetBundle>).boilerplate = next.boilerplate;
  (ASSETS as unknown as Record<AssetBundleId, AssetBundle>).entityRegistry = next.entityRegistry;
  (ASSETS as unknown as Record<AssetBundleId, AssetBundle>).referencePackage = next.referencePackage;
}
