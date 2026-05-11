import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { FORBIDDEN_INTERNAL_PACKAGES } from '../forbiddenInternalPackages.js';
import type { BuilderTool } from './types.js';

/**
 * List the `.d.ts` type-declaration files an npm package ships, so the
 * agent can pick which one to read via `read_package_types` before
 * writing slot code that imports from it.
 *
 * Why this exists: the Builder agent has been observed hallucinating
 * methods on third-party SDK Client types (e.g. `client.streamText`,
 * `client.runAgenticLoop` on `@anthropic-ai/sdk` — none exist), then
 * burning 10+ slot-typecheck iterations trying to "fix" the code with
 * more invented methods. Giving the agent first-party access to the
 * actual `.d.ts` surface short-circuits that loop: the agent is supposed
 * to call `list_package_types` + `read_package_types` BEFORE the first
 * `fill_slot` that imports from an unfamiliar package.
 *
 * Resolution model:
 *   - Resolves `<templateRoot>/node_modules/<packageName>` (the shared
 *     install — per-staging dirs symlink back to the same node_modules,
 *     so reading from the template root is correct for every draft).
 *   - Reads the package's `package.json` `types` / `typings` field for
 *     the canonical entrypoint; falls back to `index.d.ts`.
 *   - Walks the package directory for additional `.d.ts` files (capped
 *     at `MAX_FILES`) so the agent can navigate to specific resources
 *     (e.g. `resources/messages/messages.d.ts` on `@anthropic-ai/sdk`).
 *
 * Allowlist: any package present in `<templateRoot>/node_modules`. We
 * deliberately do NOT restrict to `package.json#dependencies` — most
 * useful types come from transitive deps of the boilerplate (the agent
 * might want to read `@types/node`'s `http.d.ts` for instance), and the
 * existence-in-node_modules check is enough to prevent the agent from
 * looking up things it cannot actually import.
 */

const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

const InputSchema = z
  .object({
    /**
     * npm package name. Supports scoped packages (`@anthropic-ai/sdk`).
     * Path segments past the package name are rejected — use
     * `read_package_types` with the `file` argument for sub-paths.
     */
    packageName: z
      .string()
      .min(1, 'packageName must be non-empty')
      .max(214, 'packageName too long')
      .refine((v) => PACKAGE_NAME_RE.test(v), {
        message: 'invalid npm package name (no path segments, lowercase, scoped allowed)',
      }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface OkResult {
  ok: true;
  packageName: string;
  /** Package version from `package.json` — useful for the agent to
   *  know whether its training-data API knowledge is outdated. */
  version: string;
  /**
   * Root-relative path to the canonical entry from `package.json`'s
   * `types` / `typings` field. `null` when neither is set and there is
   * no `index.d.ts` — agent should treat this as "package has no types,
   * may need `@types/<name>`".
   */
  mainTypes: string | null;
  /**
   * All `.d.ts` files in the package, root-relative, sorted, capped at
   * `MAX_FILES`. The agent calls `read_package_types({ packageName, file })`
   * with one of these strings to fetch the actual declarations.
   */
  files: ReadonlyArray<string>;
  /** Whether the file list was truncated. */
  truncated: boolean;
}

interface ErrResult {
  ok: false;
  error: string;
  hint?: string;
}

type Result = OkResult | ErrResult;

const MAX_FILES = 80;

export const listPackageTypesTool: BuilderTool<Input, Result> = {
  id: 'list_package_types',
  description:
    'List the .d.ts type-declaration files of an npm package installed in the build template. ' +
    'Call this BEFORE writing fill_slot code that imports from a third-party package whose API ' +
    'you are not 100% sure about — then call read_package_types({packageName, file}) to read the ' +
    'actual declarations. This prevents hallucinating methods that do not exist on the real ' +
    'type. Returns mainTypes (the canonical entry), files (all .d.ts in the package), and version.',
  input: InputSchema,
  async run({ packageName }, ctx) {
    const internal = matchInternalForbidden(packageName);
    if (internal) {
      return { ok: false, error: internal.error, hint: internal.hint };
    }

    const pkgDir = path.resolve(ctx.templateRoot, 'node_modules', packageName);
    // Re-confirm the resolved path is inside node_modules (defence
    // against a packageName that somehow gets past the regex).
    const nodeModulesRoot = path.resolve(ctx.templateRoot, 'node_modules');
    if (
      pkgDir !== nodeModulesRoot &&
      !pkgDir.startsWith(nodeModulesRoot + path.sep)
    ) {
      return {
        ok: false,
        error: `packageName '${packageName}' resolves outside node_modules`,
      };
    }

    let pkgJson: { types?: unknown; typings?: unknown; version?: unknown };
    try {
      const raw = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8');
      pkgJson = JSON.parse(raw) as typeof pkgJson;
    } catch {
      return {
        ok: false,
        error: `package '${packageName}' is not installed in the build template`,
        hint:
          'Only packages already in <templateRoot>/node_modules can be looked up. ' +
          'If you need a new dependency, ask the user to add it to the template manifest.',
      };
    }

    const version = typeof pkgJson.version === 'string' ? pkgJson.version : 'unknown';

    // `types` (modern) and `typings` (legacy) are interchangeable per
    // TypeScript spec. Prefer the explicit field; fall back to a
    // conventional `index.d.ts` only if it exists on disk.
    const declaredTypes =
      typeof pkgJson.types === 'string'
        ? pkgJson.types
        : typeof pkgJson.typings === 'string'
          ? pkgJson.typings
          : null;

    let mainTypes: string | null = null;
    if (declaredTypes !== null) {
      const normalized = declaredTypes.replace(/^\.\//, '');
      const abs = path.resolve(pkgDir, normalized);
      if (abs === pkgDir || abs.startsWith(pkgDir + path.sep)) {
        try {
          const stat = await fs.stat(abs);
          if (stat.isFile()) {
            mainTypes = path.relative(pkgDir, abs).replace(/\\/g, '/');
          }
        } catch {
          // Declared but missing — leave mainTypes null, agent sees it
          // alongside the file list and can pick another.
        }
      }
    }
    if (mainTypes === null) {
      try {
        const stat = await fs.stat(path.join(pkgDir, 'index.d.ts'));
        if (stat.isFile()) mainTypes = 'index.d.ts';
      } catch {
        // No fallback found.
      }
    }

    const { files, truncated } = await collectDtsFiles(pkgDir);

    return {
      ok: true,
      packageName,
      version,
      mainTypes,
      files,
      truncated,
    };
  },
};

function matchInternalForbidden(
  packageName: string,
): { error: string; hint: string } | null {
  const reason = FORBIDDEN_INTERNAL_PACKAGES.get(packageName);
  if (reason === undefined) return null;
  return {
    error:
      `package '${packageName}' is intentionally not installed in the build ` +
      'template — plugins must compile standalone (zip-upload contract).',
    hint: reason,
  };
}

/**
 * Walk `pkgDir` and collect every `.d.ts` (excluding `.d.cts` /
 * `.d.mts` for now — most packages duplicate them, and the agent
 * almost always wants the ESM `.d.ts`). Skips `node_modules/`,
 * `__tests__/`, and dotfiles. Returned root-relative, sorted, capped
 * at `MAX_FILES` entries.
 */
async function collectDtsFiles(
  pkgDir: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const out: string[] = [];
  let truncated = false;

  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.')) continue;
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name === 'test')
        continue;
      const nextRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const nextAbs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(nextAbs, nextRel);
      } else if (e.isFile() && e.name.endsWith('.d.ts')) {
        out.push(nextRel);
      }
    }
  }
  await walk(pkgDir, '');
  return { files: out, truncated };
}
