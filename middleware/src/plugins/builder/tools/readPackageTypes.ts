import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { BuilderTool } from './types.js';

/**
 * Read a `.d.ts` (or supporting `.json`) file from an installed npm
 * package, so the Builder agent can inspect the actual exported type
 * surface before writing slot code that uses the package.
 *
 * Pairs with `list_package_types` — the agent typically calls
 * `list_package_types('@anthropic-ai/sdk')` first to discover the file
 * layout, then `read_package_types({ packageName, file: 'client.d.ts' })`
 * to read specific declarations.
 *
 * Mirrors `readReference.ts` style: extension whitelist, blocked
 * segments, MAX_BYTES cap, traversal defence. Two extensions allowed:
 *   - `.d.ts` (the actual type declarations)
 *   - `.json` (only the package's own `package.json` — handy when the
 *     agent wants to confirm a peer dep or check `exports` map)
 *
 * Resolution: `<templateRoot>/node_modules/<packageName>/<file>` with
 * a fallback of "use mainTypes" when `file` is omitted.
 */

const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(['.d.ts', '.json']);
const MAX_BYTES = 200 * 1024;

const InputSchema = z
  .object({
    packageName: z
      .string()
      .min(1, 'packageName must be non-empty')
      .max(214, 'packageName too long')
      .refine((v) => PACKAGE_NAME_RE.test(v), {
        message: 'invalid npm package name',
      }),
    /**
     * Path RELATIVE to the package directory. When omitted the tool
     * reads the package's `package.json#types`/`typings` entry, falling
     * back to `index.d.ts`. Get exact paths from `list_package_types`.
     */
    file: z
      .string()
      .min(1, 'file must be non-empty')
      .max(400, 'file path too long')
      .optional(),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface OkResult {
  ok: true;
  packageName: string;
  file: string;
  content: string;
  bytes: number;
}

interface ErrResult {
  ok: false;
  error: string;
  hint?: string;
}

type Result = OkResult | ErrResult;

export const readPackageTypesTool: BuilderTool<Input, Result> = {
  id: 'read_package_types',
  description:
    'Read a .d.ts (or package.json) file from an installed npm package. ' +
    'Use this AFTER list_package_types to inspect the real exported type ' +
    'surface before writing fill_slot code. When `file` is omitted, returns ' +
    "the package's main types entry. Always prefer reading the .d.ts to " +
    'guessing methods on a Client/SDK class — hallucinated methods cause ' +
    'tsc-failures that burn the build budget. Max 200 KB.',
  input: InputSchema,
  async run({ packageName, file }, ctx) {
    const pkgDir = path.resolve(ctx.templateRoot, 'node_modules', packageName);
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
        hint: 'Call list_package_types first to confirm the package name.',
      };
    }

    // When `file` is omitted, resolve the package's main types entry.
    let resolvedFile: string;
    if (file === undefined) {
      const declared =
        typeof pkgJson.types === 'string'
          ? pkgJson.types
          : typeof pkgJson.typings === 'string'
            ? pkgJson.typings
            : null;
      const candidate = declared !== null ? declared.replace(/^\.\//, '') : 'index.d.ts';
      resolvedFile = candidate;
    } else {
      resolvedFile = file;
    }

    if (resolvedFile.startsWith('/') || resolvedFile.startsWith('\\')) {
      return {
        ok: false,
        error: `file '${resolvedFile}' must be relative to the package root`,
      };
    }
    const segments = resolvedFile.split(/[/\\]/);
    if (segments.includes('..')) {
      return { ok: false, error: `file '${resolvedFile}' contains '..'` };
    }
    if (segments.includes('node_modules')) {
      return {
        ok: false,
        error: `file '${resolvedFile}' touches blocked segment 'node_modules'`,
        hint:
          'To read a transitive dep, call list_package_types/read_package_types ' +
          'with the dep name directly.',
      };
    }

    // Extension check is special: `.d.ts` is two extensions, so plain
    // `path.extname` returns `.ts`. Accept both `.d.ts` (any path) and
    // exactly `package.json` at the root.
    const lower = resolvedFile.toLowerCase();
    const isDts = lower.endsWith('.d.ts');
    const isPkgJson = lower === 'package.json';
    if (!isDts && !isPkgJson) {
      return {
        ok: false,
        error: `file '${resolvedFile}' has unsupported extension`,
        hint: `allowed: ${[...ALLOWED_EXTENSIONS].sort().join(' ')} (and only 'package.json' at root for .json)`,
      };
    }

    const resolved = path.resolve(pkgDir, resolvedFile);
    if (resolved !== pkgDir && !resolved.startsWith(pkgDir + path.sep)) {
      return {
        ok: false,
        error: `file '${resolvedFile}' resolves outside the package`,
      };
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return {
        ok: false,
        error: `file '${resolvedFile}' does not exist in package '${packageName}'`,
        hint: 'Call list_package_types to see available .d.ts files.',
      };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `path '${resolvedFile}' is not a regular file` };
    }
    if (stat.size > MAX_BYTES) {
      return {
        ok: false,
        error: `file '${resolvedFile}' exceeds ${String(MAX_BYTES)} bytes (size: ${String(stat.size)})`,
        hint:
          'Large declaration files often re-export from smaller siblings. ' +
          'Look at the file list from list_package_types and read a more specific one.',
      };
    }

    const content = await fs.readFile(resolved, 'utf8');
    return {
      ok: true,
      packageName,
      file: resolvedFile,
      content,
      bytes: stat.size,
    };
  },
};
