import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSETS } from '../../platform/assets.js';
import { getKnownServicePackages } from './serviceTypeRegistry.js';

/**
 * BuildTemplateConfig — derives `npmDeps` + `workspaceDeps` from the
 * boilerplate package.json so `ensureBuildTemplate(...)` (Phase B.3-4a) can
 * be wired at boot without a hand-maintained dep catalog.
 *
 * Today the boilerplate ships with `peerDependencies: { zod }` only —
 * `npmDeps = { zod: ... }`, `workspaceDeps = {}`. As the boilerplate gains
 * more deps (e.g. `@omadia/plugin-api`), the helper picks them up
 * automatically: `@byte5/X` is treated as a workspace package living at
 * `middleware/packages/X/` (the platform's package-naming convention).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
// `here` is `middleware/src/plugins/builder/` in dev and `dist/plugins/builder/`
// in prod. 3×`..` resolves to `middleware/` and `/app/` respectively — both
// hold `packages/` (workspace deps live there in the Docker image too).
const MIDDLEWARE_ROOT = path.resolve(HERE, '..', '..', '..');

export const DEFAULT_BOILERPLATE_PACKAGE_JSON = path.join(
  ASSETS.boilerplate.root,
  'agent-integration',
  'package.json',
);

export const DEFAULT_WORKSPACE_PACKAGES_ROOT = path.join(
  MIDDLEWARE_ROOT,
  'packages',
);

/**
 * Build-time-only deps the boilerplate's `scripts/build-zip.mjs` needs but
 * the runtime never imports. Kept middleware-side so the operator-facing
 * boilerplate `package.json` stays runtime-only (devDependencies in the
 * boilerplate would ship into the uploaded zip and confuse `npm install
 * --omit=dev` consumers). The build-template merges these in alongside
 * the boilerplate's runtime deps when it provisions `node_modules` for
 * the staging directory.
 */
export const BUILD_TIME_ONLY_DEPS: Readonly<Record<string, string>> = {
  typescript: '^5.4.0',
  // B.12 — React-SSR pipeline. Shared across all plugin builds via the
  // build-template node_modules; plugins WITHOUT react-ssr ui_routes
  // simply don't import these. The peerDep is added to the plugin
  // package.json by codegen only when ≥1 ui_route uses
  // render_mode='react-ssr'.
  react: '^18.3.1',
  'react-dom': '^18.3.1',
  '@types/react': '^18.3.12',
  '@types/react-dom': '^18.3.1',
  // B.12 production-fix — @types/express is needed at tsc-time for the
  // codegen-emitted UiRouter (`import { Router } from 'express'`) and
  // for any operator-authored admin-ui ctx.routes.register() body. The
  // express runtime itself is now declared as a peerDep on the
  // boilerplate (so it lands in the plugin's npmDeps automatically),
  // but @types/express needs a host-managed pin because the agent's
  // codegen never touches dev-dep type packages.
  '@types/express': '^5.0.0',
};

/**
 * Drift map for workspace packages whose published `name` field doesn't
 * match the on-disk folder. Lookup is name → folder; only used when the
 * folder-segment-after-slash doesn't directly resolve. Add an entry here
 * INSTEAD of renaming the folder when you need to ship a fix urgently
 * (folder-rename touches many files; alias is a 1-line localised fix).
 *
 * Long-term: clear these by moving the folder to match the package name.
 */
const PACKAGE_FOLDER_ALIASES: Readonly<Record<string, string>> = {
  // Package was renamed `@byte5/harness-ui-helpers` → `@omadia/plugin-ui-helpers`
  // but the workspace folder kept its harness-prefixed name. Folder-rename
  // tracked as separate cleanup ticket.
  '@omadia/plugin-ui-helpers': 'harness-ui-helpers',
};

export interface BuildTemplateConfig {
  npmDeps: Record<string, string>;
  workspaceDeps: Record<string, string>;
}

export interface LoadBuildTemplateConfigOptions {
  /** Override boilerplate package.json path (test-only). */
  boilerplatePackageJsonPath?: string;
  /** Override workspace packages directory (test-only). */
  workspacePackagesRoot?: string;
  /** Whether to merge integration packages from `serviceTypeRegistry`
   *  into workspaceDeps (Theme A). Default `true` — production needs
   *  the integration types in the shared build-template `node_modules`
   *  so generated agents using `spec.external_reads` typecheck. Tests
   *  that don't set up the integration package fixtures pass `false`. */
  includeServiceTypeRegistryDeps?: boolean;
}

/**
 * Reads the boilerplate package.json and partitions its `dependencies` +
 * `peerDependencies` into `npmDeps` (real registry packages) and
 * `workspaceDeps` (`@byte5/*` packages resolved to absolute paths inside
 * `middleware/packages/`).
 *
 * Fail-loud: missing boilerplate package.json or non-existent workspace dep
 * surfaces as a thrown Error so the boot wiring doesn't silently degrade
 * to a contract-less template.
 */
export async function loadBuildTemplateConfig(
  opts: LoadBuildTemplateConfigOptions = {},
): Promise<BuildTemplateConfig> {
  const pkgPath =
    opts.boilerplatePackageJsonPath ?? DEFAULT_BOILERPLATE_PACKAGE_JSON;
  const workspaceRoot =
    opts.workspacePackagesRoot ?? DEFAULT_WORKSPACE_PACKAGES_ROOT;
  const includeRegistryDeps = opts.includeServiceTypeRegistryDeps ?? true;

  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, 'utf8');
  } catch (err) {
    throw new Error(
      `loadBuildTemplateConfig: cannot read boilerplate package.json at ${pkgPath}: ${(err as Error).message}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `loadBuildTemplateConfig: malformed JSON in ${pkgPath}: ${(err as Error).message}`,
    );
  }

  const declaredDeps = mergeDepMaps(
    parsed['dependencies'],
    parsed['peerDependencies'],
  );

  const npmDeps: Record<string, string> = {};
  const workspaceDeps: Record<string, string> = {};

  for (const [name, range] of Object.entries(declaredDeps)) {
    // Phase 5B: accept any scoped name (`@omadia/x`, `@byte5/x`, …) as
    // a workspace dep. Pre-rename only `@byte5/*` was treated this way;
    // post-rename the workspace ships `@omadia/*` packages and the
    // build template's boilerplate references them under that scope.
    if (name.startsWith('@omadia/') || name.startsWith('@byte5/')) {
      // B.12 production-fix — some packages were renamed (package.json
      // `name` field changed) without renaming the on-disk folder. The
      // PACKAGE_FOLDER_ALIASES below maps published-name → folder for
      // those drift cases. Future rename: drop the alias by moving the
      // folder to match. Until then this keeps the build-template's
      // workspace-symlink path correct.
      const folder = PACKAGE_FOLDER_ALIASES[name] ?? name.slice(name.indexOf('/') + 1);
      const abs = path.join(workspaceRoot, folder);
      try {
        await fs.access(abs);
      } catch {
        throw new Error(
          `loadBuildTemplateConfig: workspace dep '${name}' resolved to '${abs}' but no such directory exists`,
        );
      }
      workspaceDeps[name] = abs;
    } else {
      npmDeps[name] = range;
    }
  }

  // Merge in build-time-only deps (typescript, …) — see comment on
  // BUILD_TIME_ONLY_DEPS above for why these don't live in the boilerplate
  // package.json. Caller-supplied npmDeps (test override) win on
  // conflict — a test pinning a different typescript version stays
  // honoured.
  for (const [name, range] of Object.entries(BUILD_TIME_ONLY_DEPS)) {
    if (!(name in npmDeps)) npmDeps[name] = range;
  }

  // Merge in integration packages from serviceTypeRegistry (Theme A).
  // Generated agents may pull in any subset of these via spec.external_reads;
  // pre-resolving all of them in the shared build-template `node_modules`
  // is the only way to keep `prepareStagingDir` (which symlinks the shared
  // node_modules wholesale) free of per-build setup. Already-declared
  // workspace deps win on conflict. Tests opt out via
  // `includeServiceTypeRegistryDeps: false` since their tmpdir fixtures
  // don't ship the integration package directories.
  if (includeRegistryDeps) {
    for (const pkgName of getKnownServicePackages()) {
      // Phase 5B: accept any scoped package (@omadia/x, @byte5/x,
      // @third-party/x) as well as bare names. The workspace folder
      // convention drops the scope prefix; bare names map 1:1.
      if (pkgName in workspaceDeps) continue;
      const folder = pkgName.startsWith('@')
        ? pkgName.slice(pkgName.indexOf('/') + 1)
        : pkgName;
      const abs = path.join(workspaceRoot, folder);
      try {
        await fs.access(abs);
      } catch {
        throw new Error(
          `loadBuildTemplateConfig: serviceTypeRegistry references '${pkgName}' but ` +
            `'${abs}' does not exist — drop the entry from serviceTypeRegistry or ` +
            'install the integration package.',
        );
      }
      workspaceDeps[pkgName] = abs;
    }
  }

  return { npmDeps, workspaceDeps };
}

function mergeDepMaps(
  ...maps: Array<unknown>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const m of maps) {
    if (!m || typeof m !== 'object') continue;
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      merged[k] = v;
    }
  }
  return merged;
}
