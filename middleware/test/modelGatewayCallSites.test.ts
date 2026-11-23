/**
 * Spec 2042 §6 criterion 37 — "every model call site in the code is listed
 * in #2053 with its context". The list is `docs/model-gateway-call-sites.md`.
 *
 * This scans `src/` and `packages/*\/src` for model call expressions
 * (`.complete(`, `.stream(`, `.embed(`, `transcribe…(`, `'run_loop'`) and
 * fails for any file the page does not name. A new call site therefore
 * needs a row on that page saying which execution context it runs in.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const MIDDLEWARE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = path.resolve(MIDDLEWARE, '..', 'docs', 'model-gateway-call-sites.md');

const MODEL_CALL = /\.complete\(|\.stream\(|\.embed\(|\btranscribe(?:File|Stream)?\(|'run_loop'/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** The code of a file without its comments (block and line), roughly: a
 *  comment that mentions `ctx.llm.complete()` is no call site. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function roots(): string[] {
  const packages = path.join(MIDDLEWARE, 'packages');
  return [
    path.join(MIDDLEWARE, 'src'),
    ...readdirSync(packages)
      .map((p) => path.join(packages, p, 'src'))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      }),
  ];
}

/**
 * A file is listed when a row names it. The page names most files by their
 * base name; a base name several source files share (`plugin.ts`) counts only
 * on a row that also names the file's package or directory.
 */
function isListed(file: string, files: readonly string[], lines: readonly string[]): boolean {
  const base = path.basename(file);
  const shared = files.filter((f) => path.basename(f) === base).length > 1;
  const rel = path.relative(MIDDLEWARE, file).split(path.sep);
  // `packages/<pkg>/src/…` → the package directory; `src/<dir>/…` → the directory.
  const owner = rel[0] === 'packages' ? rel[1] : rel[rel.length - 2];
  return lines.some((line) => line.includes(base) && (!shared || (owner !== undefined && line.includes(owner))));
}

describe('model gateway call-site inventory', () => {
  it('criterion 37: every file with a model call site is listed in docs/model-gateway-call-sites.md', () => {
    const lines = readFileSync(INVENTORY, 'utf8').split('\n');
    const files = roots().flatMap(sourceFiles);
    const sites = files.filter((file) => MODEL_CALL.test(code(readFileSync(file, 'utf8'))));
    assert.ok(sites.length > 20, `the scan found ${String(sites.length)} call sites; the pattern broke`);
    const unlisted = sites
      .filter((file) => !isListed(file, files, lines))
      .map((file) => path.relative(MIDDLEWARE, file));
    assert.deepEqual(unlisted, [], 'model call sites missing from docs/model-gateway-call-sites.md');
  });
});
