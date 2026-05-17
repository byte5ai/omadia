import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

import type { BuildError } from './buildErrorParser.js';
import { FORBIDDEN_INTERNAL_PACKAGES } from './forbiddenInternalPackages.js';

/**
 * Pre-tsc workspace-import resolver (OB-40 PR-A).
 *
 * Why this exists: the slot-typecheck pipeline runs `tsc --noEmit` on a
 * fully prepared staging dir to validate slot code. tsc DOES catch
 * unresolvable imports, but with two costs:
 *   1. Latency: ~200-500ms to spawn tsc, parse the entire project, and
 *      surface the "Cannot find module" diagnostic.
 *   2. Diagnostic quality: tsc says `Cannot find module '@byte5/foo' or
 *      its corresponding type declarations`. The agent's auto-fix loop
 *      then tries to "fix" the import (rename, relative-path, etc.)
 *      which may not be the right move. The actual root-cause is one of:
 *        - The package is intentionally forbidden in plugins (Standalone-
 *          Compile-Contract, CLAUDE.md Checklist Point 1).
 *        - The package is not declared in the boilerplate's
 *          peerDependencies, so it never made it into the build-template.
 *
 * This resolver inspects the codegen-produced file map BEFORE the staging
 * dir is materialised, regex-extracts every bare-specifier import, and
 * surfaces structured `BuildError`-shaped issues with sharper, actionable
 * hints. When issues are found the pipeline returns early with
 * `reason: 'imports_invalid'` and skips the tsc roundtrip.
 *
 * The resolver intentionally uses a regex pass instead of a full TS AST
 * parse — slot code is small, the failure modes we care about are
 * narrow, and TS-AST setup costs would defeat the latency win we are
 * trying to capture. False-positives (e.g. a string literal that looks
 * like an import statement inside a template literal) are exceedingly
 * rare in plugin code, and the worst case is an unnecessary error that
 * the agent would have hit at the tsc stage anyway.
 */

export interface ImportLookup {
  /** True when the bare-specifier resolves to a package present in the
   *  build-template's `node_modules` at the time of the check. */
  isInstalled(specifier: string): boolean;
}

const TEXT_EXTS_FOR_IMPORT_SCAN: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/**
 * Path prefixes that are part of the boilerplate's build tooling, not
 * plugin runtime. Imports inside these files are evaluated by the host
 * (Node, when packaging the zip) and are never executed inside a plugin
 * sandbox, so they fall outside the gate's scope. Without this skip
 * the boilerplate's own `scripts/build-zip.mjs` (which uses
 * `node:child_process`, `node:fs`, …) would trip the gate on every
 * fill_slot turn even though the slot itself is fine.
 */
const BUNDLE_SCAN_SKIP_PATH_PREFIXES: readonly string[] = ['scripts/'];

/**
 * `node:` is the ESM-spec prefix for Node built-ins. Built-ins do not
 * resolve through `node_modules`, so the installed-packages lookup
 * cannot answer for them and the gate must intrinsically allow them.
 */
function isNodeBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:');
}

/**
 * Matches `import … from '<spec>'` and `import('<spec>')` and
 * `require('<spec>')`. We do NOT distinguish type-only imports (`import
 * type … from`) — TS strips them at compile time but tsc still resolves
 * the specifier, so unresolved type-only imports also produce errors
 * worth catching.
 *
 * The pattern stays loose around whitespace and supports both single and
 * double-quoted strings; backticks (template strings) are rare for
 * import paths and skipping them avoids false-positives from inline
 * code samples in JSDoc-adjacent strings.
 *
 * Comments are stripped from the input before this regex runs (see
 * `stripCommentsForImportScan` below). The `[\w*${}\s,]+` class would
 * otherwise span newlines and JSDoc asterisks, and JSDoc bodies
 * frequently embed example imports as a hint for the reader — e.g. the
 * boilerplate `types.ts` documents an `import type` sample from
 * `@omadia/plugin-api` inside a JSDoc block. Without the strip step
 * that example would trip IMPORT_FORBIDDEN against the standalone-compile
 * contract on every fill_slot turn that processes the boilerplate.
 */
const IMPORT_RE =
  /(?<=^|[^.\w])(?:import\s*(?:[\w*${}\s,]+\s*from\s*)?|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/gm;

/**
 * Replaces JS/TS comment bodies with spaces so the import regex cannot
 * match code samples embedded in JSDoc or trailing `//` notes. Newlines
 * are preserved so the line-offset table built from the original text
 * still maps match indices to the correct source line.
 *
 * Approximate by design — it does not track string or template-literal
 * state, so a comment sentinel inside a string (e.g. `"/* not a comment *\/"`)
 * is treated as a real comment. That is acceptable: the import regex
 * would not match a genuine bare-specifier import nested inside a string
 * either, and the gate's only mandate is to catch real imports.
 */
export function stripCommentsForImportScan(text: string): string {
  const blocksStripped = text.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  return blocksStripped.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

interface ImportFinding {
  specifier: string;
  /** 1-based line number where the specifier appeared. */
  line: number;
}

export function extractImports(text: string): ImportFinding[] {
  const out: ImportFinding[] = [];
  // Pre-compute line offsets so we can map match-index → line.
  const lineOffsets: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) lineOffsets.push(i + 1);
  }
  const scanText = stripCommentsForImportScan(text);
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(scanText)) !== null) {
    const specifier = m[1];
    if (typeof specifier !== 'string' || specifier.length === 0) continue;
    // Skip relative imports — they're resolved by tsc via rootDir,
    // outside the scope of this gate.
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
    const idx = m.index;
    // Binary search lineOffsets for the largest offset <= idx.
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      const offset = lineOffsets[mid];
      if (offset !== undefined && offset <= idx) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    out.push({ specifier, line: lo + 1 });
  }
  return out;
}

/**
 * npm-package-name → bare-specifier root. `@scope/pkg/sub/path` strips
 * the `/sub/path` suffix while preserving the scope; `pkg/sub` keeps
 * just `pkg`. node_modules resolution is rooted at the package
 * directory, so the package itself either exists or does not.
 */
export function packageRootOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    const slash = specifier.indexOf('/');
    if (slash === -1) return specifier;
    const second = specifier.indexOf('/', slash + 1);
    return second === -1 ? specifier : specifier.slice(0, second);
  }
  const slash = specifier.indexOf('/');
  return slash === -1 ? specifier : specifier.slice(0, slash);
}

export interface ImportIssueOptions {
  /** Override the forbidden-package list (tests). */
  forbiddenPackages?: ReadonlyMap<string, string>;
}

export function validateBundleImports(
  files: ReadonlyMap<string, Buffer>,
  lookup: ImportLookup,
  opts: ImportIssueOptions = {},
): BuildError[] {
  const forbidden = opts.forbiddenPackages ?? FORBIDDEN_INTERNAL_PACKAGES;
  const issues: BuildError[] = [];
  // Emit only one issue per (file, specifier) so a specifier imported
  // from many files (or referenced multiple times) doesn't drown out
  // other failures in the agent's bounded context.
  const seenPerFile = new Map<string, Set<string>>();

  for (const [relPath, buf] of files) {
    if (BUNDLE_SCAN_SKIP_PATH_PREFIXES.some((p) => relPath.startsWith(p))) {
      continue;
    }
    const ext = path.extname(relPath).toLowerCase();
    if (!TEXT_EXTS_FOR_IMPORT_SCAN.has(ext)) continue;
    const text = buf.toString('utf-8');
    const imports = extractImports(text);
    if (imports.length === 0) continue;

    let seen = seenPerFile.get(relPath);
    if (seen === undefined) {
      seen = new Set<string>();
      seenPerFile.set(relPath, seen);
    }

    for (const { specifier, line } of imports) {
      if (isNodeBuiltinSpecifier(specifier)) continue;
      const root = packageRootOf(specifier);
      if (seen.has(root)) continue;

      const forbiddenHint = forbidden.get(root);
      if (forbiddenHint !== undefined) {
        seen.add(root);
        issues.push({
          path: relPath,
          line,
          col: 1,
          code: 'IMPORT_FORBIDDEN',
          message:
            `Import '${root}' is forbidden in plugin slots — ` +
            'plugins must compile standalone (zip-upload contract). ' +
            forbiddenHint,
        });
        continue;
      }

      if (!lookup.isInstalled(root)) {
        seen.add(root);
        issues.push({
          path: relPath,
          line,
          col: 1,
          code: 'IMPORT_UNRESOLVED',
          message:
            `Import '${root}' cannot be resolved — package is not in the ` +
            'build-template node_modules. Either the boilerplate ' +
            'package.json must declare it in peerDependencies, or the ' +
            'slot must use a different approach (relative import, an ' +
            'already-installed package, or `external_reads` for cross-' +
            'plugin reads).',
        });
      }
    }
  }

  return issues;
}

/**
 * Reads the build-template root and returns an `ImportLookup` whose
 * `isInstalled` answers from the on-disk `node_modules`. Cached at
 * module level keyed by `templateRoot`; invalidated when the template's
 * `.harness-build-template.hash` file mtime changes (same trigger
 * `ensureBuildTemplate` uses to detect dep drift).
 */
const HASH_FILE = '.harness-build-template.hash';

interface CacheEntry {
  installedRoots: Set<string>;
  hashMtimeMs: number;
}

const lookupCache = new Map<string, CacheEntry>();

export async function loadInstalledPackagesLookup(
  templateRoot: string,
): Promise<ImportLookup> {
  const absRoot = path.resolve(templateRoot);
  const hashPath = path.join(absRoot, HASH_FILE);

  let hashMtimeMs = 0;
  try {
    const stat = await fs.stat(hashPath);
    hashMtimeMs = stat.mtimeMs;
  } catch {
    // No hash file yet — treat as a fresh template; we'll re-scan once
    // and cache by mtime=0 so the next call refreshes when the template
    // gets its first hash write.
  }

  const cached = lookupCache.get(absRoot);
  if (cached !== undefined && cached.hashMtimeMs === hashMtimeMs) {
    return makeLookup(cached.installedRoots);
  }

  const installedRoots = await scanInstalledRoots(absRoot);
  lookupCache.set(absRoot, { installedRoots, hashMtimeMs });
  return makeLookup(installedRoots);
}

function makeLookup(roots: ReadonlySet<string>): ImportLookup {
  return {
    isInstalled(specifier: string): boolean {
      return roots.has(packageRootOf(specifier));
    },
  };
}

async function scanInstalledRoots(templateRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  const nm = path.join(templateRoot, 'node_modules');
  let entries: Dirent[];
  try {
    entries = await fs.readdir(nm, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const name = e.name;
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      // Scoped packages: descend one level.
      let scoped: Dirent[];
      try {
        scoped = await fs.readdir(path.join(nm, name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) {
        const sname = s.name;
        if (sname.startsWith('.')) continue;
        if (s.isDirectory() || s.isSymbolicLink()) {
          out.add(`${name}/${sname}`);
        }
      }
    } else if (e.isDirectory() || e.isSymbolicLink()) {
      out.add(name);
    }
  }
  return out;
}

/** Test-only — clears the lookup cache between unit tests. */
export const _internal = {
  resetLookupCache(): void {
    lookupCache.clear();
  },
};
