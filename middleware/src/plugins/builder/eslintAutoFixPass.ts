import path from 'node:path';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { extractSlotRegions } from './codegen.js';

/**
 * Programmatic ESLint auto-fix pass over a codegen bundle (OB-40 PR-B).
 *
 * Runs in-memory between `generate()` and the workspace-import gate.
 * Auto-fixes type-info-free style issues so tsc sees clean source —
 * marginal value compared to PR-A (which short-circuits the actual
 * resolution failures), but eliminates a class of churn turns where
 * the agent writes `let x = 1` and tsc's `noUnusedLocals` plays
 * weird with `prefer-const`-shaped diagnostics, or where stray
 * `var` declarations slip through.
 *
 * Design choices:
 *   - **In-memory only**: results are fed forward into the rest of the
 *     pipeline; the original slot text in the draftStore stays
 *     untouched. Persisting fixes back would require slot-extraction
 *     from marker regions (fragile) and would silently rewrite the
 *     agent's authored code, making the chat history misleading. The
 *     pass is idempotent — every codegen run reproduces the same input
 *     and ESLint fixes it the same way — so the in-memory effect is
 *     stable across rebuilds.
 *   - **Type-info-free rules only**: `prefer-const`, `no-var`,
 *     `no-useless-escape`. Type-aware rules (`no-floating-promises`,
 *     `no-misused-promises`) need `parserOptions.project` pointing at
 *     a real on-disk tsconfig with the staging dir's files in
 *     `include`, which is not available here. Those would have to run
 *     after `prepareStagingDir` — out of scope for v1.
 *   - **`ESLint` instance is cached**: ESLint construction parses the
 *     entire config + plugins, ~50-100ms cold. One instance per
 *     process amortises that across all fill_slot turns.
 *
 * Failure modes are swallowed: if ESLint cannot parse a file (e.g.
 * malformed TS the agent wrote on a half-baked turn), we return the
 * original buffer untouched and let tsc surface the parse error with
 * its better diagnostics. This is fail-open by design — the gate
 * exists to *help*, not to add another way the pipeline can break.
 */

const FIXABLE_EXTS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

let cachedEslint: ESLint | null = null;

/**
 * Builds the in-memory flat config for the auto-fix pass. Exposed for
 * tests (so they can inspect the configured rules) and for future
 * extension via the optional `extraRules` knob.
 */
export function buildAutoFixConfig(extraRules: Linter.RulesRecord = {}): Linter.Config[] {
  const baseRules: Linter.RulesRecord = {
    'prefer-const': 'error',
    'no-var': 'error',
    'no-useless-escape': 'error',
    ...extraRules,
  };

  return tseslint.config(
    {
      files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
      languageOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      rules: baseRules,
    },
  ) as Linter.Config[];
}

function getEslint(): ESLint {
  if (cachedEslint !== null) return cachedEslint;
  cachedEslint = new ESLint({
    fix: true,
    overrideConfigFile: true,
    overrideConfig: buildAutoFixConfig(),
  });
  return cachedEslint;
}

export interface EslintAutoFixOptions {
  /** Override the ESLint instance — tests pass a custom-config one. */
  eslint?: ESLint;
}

export async function eslintAutoFixBundle(
  files: ReadonlyMap<string, Buffer>,
  opts: EslintAutoFixOptions = {},
): Promise<Map<string, Buffer>> {
  const eslint = opts.eslint ?? getEslint();
  const out = new Map<string, Buffer>();

  for (const [relPath, buf] of files) {
    const ext = path.extname(relPath).toLowerCase();
    if (!FIXABLE_EXTS.has(ext)) {
      out.set(relPath, buf);
      continue;
    }

    const text = buf.toString('utf-8');
    let lintResults;
    try {
      lintResults = await eslint.lintText(text, { filePath: relPath });
    } catch {
      // Parse failure or plugin error — fall through to tsc.
      out.set(relPath, buf);
      continue;
    }

    const r = lintResults[0];
    if (r === undefined || r.output === undefined || r.output === text) {
      out.set(relPath, buf);
      continue;
    }
    out.set(relPath, Buffer.from(r.output, 'utf-8'));
  }

  return out;
}

/**
 * OB-46 persist-back: given the file bundles before and after the
 * ESLint pass, plus the agent's authored slot text, returns the slots
 * whose body should be written back into the DraftStore so the editor,
 * the build pipeline, the install zip, and clone-from-installed all see
 * the fixed code.
 *
 * **Placeholder safety**: slots whose original text contains
 * `{{TOKEN}}` placeholders are skipped. After codegen step 5c the file
 * contents have all placeholders resolved, so the post-fix slot body
 * extracted from the file would be the resolved value — persisting
 * that would corrupt the slot (the `{{...}}` reference would be lost).
 * Skipping is safe; the in-memory fix still applies for the current
 * tsc gate, and the scope of slots affected is narrow (placeholders
 * inside agent-authored slots are uncommon — they typically live in
 * boilerplate template code, not in slots the operator/agent writes).
 *
 * Cross-file collision policy: the first post-fix region found for a
 * given slot key wins. Slots are 1:1 with files in practice (each
 * `manifest.slots[i].target_file` is unique per key), so this is the
 * normal case; the policy is documented for the unlikely case where a
 * future template duplicates a marker.
 */
const PLACEHOLDER_RE = /\{\{[A-Z][A-Z0-9_]*\}\}/;

const TEXT_FILE_HINT_EXTS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.html',
  '.txt',
]);

export interface PersistableSlotFix {
  slotKey: string;
  fixedSource: string;
  /** The slot text we read from `draft.slots` before the fix. Surfaced
   *  so callers can attach it to logs / events for debuggability. */
  originalSource: string;
}

export interface ExtractPersistableSlotFixesOptions {
  preFixFiles: ReadonlyMap<string, Buffer>;
  postFixFiles: ReadonlyMap<string, Buffer>;
  originalSlots: Readonly<Record<string, string>>;
}

export function extractPersistableSlotFixes(
  opts: ExtractPersistableSlotFixesOptions,
): PersistableSlotFix[] {
  const preBodies = collectSlotBodies(opts.preFixFiles);
  const postBodies = collectSlotBodies(opts.postFixFiles);

  const fixes: PersistableSlotFix[] = [];
  for (const [slotKey, originalSource] of Object.entries(opts.originalSlots)) {
    if (PLACEHOLDER_RE.test(originalSource)) continue;

    const preBody = preBodies.get(slotKey);
    const postBody = postBodies.get(slotKey);
    if (preBody === undefined || postBody === undefined) continue;
    if (preBody === postBody) continue;
    if (postBody === originalSource) continue;

    fixes.push({ slotKey, fixedSource: postBody, originalSource });
  }
  return fixes;
}

function collectSlotBodies(
  files: ReadonlyMap<string, Buffer>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [relPath, buf] of files) {
    const ext = path.extname(relPath).toLowerCase();
    if (!TEXT_FILE_HINT_EXTS.has(ext)) continue;
    let text: string;
    try {
      text = buf.toString('utf-8');
    } catch {
      continue;
    }
    for (const region of extractSlotRegions(text)) {
      if (!out.has(region.key)) out.set(region.key, region.body);
    }
  }
  return out;
}

/** Test-only — clears the cached ESLint instance between cases that
 *  configure their own rules. */
export const _internal = {
  resetCachedEslint(): void {
    cachedEslint = null;
  },
};
