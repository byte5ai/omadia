import { strict as assert } from 'node:assert';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * One grep so the entry-point guard bug cannot come back a fourth time.
 *
 * WHAT WENT WRONG
 * ---------------
 * Three CLI modules decided "am I the process entry point?" by comparing
 * their module URL against a `file://` URL built by string-concatenating
 * `argv[1]`. That puts a filesystem path where a URL belongs, and it is wrong
 * in three independent ways — Windows backslashes, percent-encoding of spaces
 * and `#`, and Node resolving the module URL through realpath while leaving
 * argv alone. Each failure mode makes the guard FALSE, so the script does
 * nothing and exits 0.
 *
 * The consequence shipped: every Windows installer up to and including
 * v0.149.2 was named `omadia.Setup.0.1.0.exe`, because
 * `desktop/scripts/set-desktop-version.mjs` never rewrote the version on the
 * Windows runner — while CI reported the step as a success and the macOS and
 * Linux artifacts of the same release carried the real version.
 *
 * WHY A REPO-WIDE GREP AND NOT JUST THE UNIT TESTS
 * ------------------------------------------------
 * `desktop/scripts/set-desktop-version.test.mjs` now drives the real CLI from
 * a path containing a space, which reproduces the same defect portably and
 * fails on any runner if the guard regresses. What it cannot do is notice a
 * FOURTH copy appearing in some other package — which is exactly how this
 * spread: the pattern is the first result for "esm main module" and looks
 * right on a developer's Mac. So the scan below covers the whole repository,
 * and it deliberately has NO per-file exclusion list: two guards in this repo
 * have already turned out to prove nothing because the exclusion list was
 * where they went blind.
 *
 * This file also lives in `middleware/test` on purpose rather than next to the
 * scripts it protects: `middleware (lint + typecheck + test)` is a required
 * status check on `main`, `desktop (typecheck + test)` is not.
 *
 * WHAT THIS GUARD DOES NOT CATCH — measured, not assumed
 * ------------------------------------------------------
 * The scan keys on the two tokens appearing near each other in code, so it
 * sees the INLINE form — which is the form all five real occurrences had, and
 * the form a newcomer writes. It does NOT see a regression hidden behind a
 * helper's parameter names: reverting `isEntryPoint` to
 * `moduleUrl === 'file://' + entry` leaves both tokens out of the file and this
 * guard stays green (verified by planting exactly that).
 *
 * That case is covered by the other half of the pair, and covered hard:
 * `desktop/scripts/set-desktop-version.test.mjs` drives the real CLI from a
 * path containing a space, and the same plant takes that suite from 217/217 to
 * 213/217. Two mechanisms, one blind spot each, and neither blind spot shared —
 * which is the only arrangement worth calling coverage.
 */

/**
 * The two tokens, assembled from fragments.
 *
 * If they appeared as plain adjacent literals, this file would be its own
 * first offender — the scan covers the repo including itself, which is the
 * point.
 */
const MODULE_URL = 'import.meta' + '.url';
const ENTRY_ARGV = 'process.argv' + '[1]';

/** The correct ways to cross the URL/path boundary. */
const SANCTIONED = ['fileURLToPath', 'pathToFileURL'];

const SCANNED_EXTENSIONS = [
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
];

/** Build output, dependencies and scratch trees carry copies we do not own. */
const SKIPPED_DIRS = new Set([
  // Local agent scratch worktrees. They hold whole extra copies of the repo,
  // so without this the scan reports the same handful of files a hundred times
  // over — and reports them against code nobody is shipping.
  '.claude',
  '.git',
  '.next',
  '.test-build',
  '.worktrees',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
  'runtime',
]);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue; // a broken symlink is not a source file
    }
    if (stats.isDirectory()) sourceFiles(full, out);
    else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

/**
 * Comments removed, newlines kept so offsets still map to lines.
 *
 * Prose has to be excluded or this guard would flag the very doc comments that
 * explain the bug — including the one above. Stripping is deliberately crude:
 * it does not understand a `//` inside a string literal, which at worst blinds
 * the scan to code on that one line. A named exclusion list would blind it to
 * whole files, which is worse.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) =>
      lead + ' '.repeat(m.length - lead.length),
    );
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * Template-literal interpolation braces rewritten as parentheses, in place.
 *
 * `${` and its matching `}` are not statement boundaries, but the crude
 * boundary scan below cannot tell them from a block. Without this,
 * `` `file://${process.argv[1]}` `` gets cut at the `${` and the entry token
 * lands outside the statement — the offender then reads as clean. Caught by
 * the fixture cases, which is the whole reason they exist. Lengths are
 * preserved so reported line numbers stay true.
 */
function neutralizeInterpolation(code: string): string {
  const out = code.split('');
  const stack: number[] = [];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === '$' && out[i + 1] === '{') {
      out[i + 1] = '(';
      stack.push(1);
      i += 1;
    } else if (stack.length > 0) {
      if (out[i] === '{') stack[stack.length - 1] += 1;
      else if (out[i] === '}') {
        const depth = (stack[stack.length - 1] as number) - 1;
        if (depth === 0) {
          out[i] = ')';
          stack.pop();
        } else stack[stack.length - 1] = depth;
      }
    }
  }
  return out.join('');
}

/**
 * The statement containing `index`, bounded by `;`, `{` and `}`.
 *
 * A character-proximity window looked simpler and was WRONG: with the correct
 * `isEntryPoint` helper defined a few lines above a bad inline guard, the
 * window picked up the helper's `fileURLToPath` and forgave the guard. Verified
 * by planting exactly that — the scan stayed green on a genuine offender.
 * Statement bounds keep a neighbouring correct call from vouching for its
 * broken neighbour, and still tolerate a comparison prettier split over four
 * lines, since none of those lines carries a `;` or a brace.
 */
function enclosingStatement(code: string, index: number): string {
  const isBoundary = (ch: string): boolean =>
    ch === ';' || ch === '{' || ch === '}';
  let start = index;
  while (start > 0 && !isBoundary(code[start - 1] as string)) start -= 1;
  let end = index;
  while (end < code.length && !isBoundary(code[end] as string)) end += 1;
  return code.slice(start, end);
}

/** Every statement that compares the module URL against the entry path. */
function findComparisons(
  files: readonly string[],
): { file: string; line: number; sanctioned: boolean }[] {
  const hits: { file: string; line: number; sanctioned: boolean }[] = [];
  for (const file of files) {
    const code = neutralizeInterpolation(
      stripComments(readFileSync(file, 'utf8')),
    );
    let from = 0;
    for (;;) {
      const at = code.indexOf(MODULE_URL, from);
      if (at === -1) break;
      from = at + MODULE_URL.length;
      const statement = enclosingStatement(code, at);
      if (!statement.includes(ENTRY_ARGV)) continue;
      hits.push({
        file: relative(repoRoot, file),
        line: lineOf(code, at),
        sanctioned: SANCTIONED.some((ok) => statement.includes(`${ok}(`)),
      });
    }
  }
  return hits;
}

describe('entry-point guards compare paths as paths', () => {
  const files = sourceFiles(repoRoot);

  it('scans a repository, not an empty list', () => {
    // Anti-vacuity: a walker that silently reached nothing would make every
    // assertion below pass. Two of this repo's guards failed exactly that way.
    assert.ok(
      files.length > 500,
      `expected the repo scan to reach hundreds of files, got ${files.length}`,
    );
    const scanned = new Set(files.map((f) => relative(repoRoot, f)));
    for (const known of [
      'desktop/scripts/isEntryPoint.mjs',
      'desktop/scripts/set-desktop-version.mjs',
      'desktop/scripts/merge-mac-update-feed.mjs',
      'middleware/sidecars/updater/src/server.mjs',
    ]) {
      assert.ok(scanned.has(known), `scan must reach ${known}`);
    }
  });

  it('actually fires on the bad form and stays quiet on the good one', () => {
    // The detector's own negative control. A clean repository legitimately
    // yields zero hits, so "found nothing" is not evidence that the scan
    // works — only a planted sample is. Fixtures are written to disk rather
    // than passed as strings so they go through the very same read + strip +
    // scan path as real files.
    const dir = mkdtempSync(join(tmpdir(), 'omadia-entryguard-'));
    const cases: [string, string, boolean][] = [
      // [filename, body, should be flagged]
      [
        'template.mjs',
        'const m = import' + '.meta.url === `file://${process.argv[1]}`;\n',
        true,
      ],
      [
        'concat.mjs',
        "const m = import" + ".meta.url === 'file://' + process.argv[1];\n",
        true,
      ],
      [
        'reversed.mjs',
        'const m = `file://${process.argv[1]}` === import' + '.meta.url;\n',
        true,
      ],
      [
        'basename.ts',
        'const m = import' +
          ".meta.url.endsWith(process.argv[1].split('/').pop());\n",
        true,
      ],
      [
        'multiline.mjs',
        'const m =\n  import' +
          '.meta.url ===\n  `file://` +\n  process.argv[1];\n',
        true,
      ],
      [
        'good-fileurltopath.mjs',
        'const m = fileURLToPath(import' +
          '.meta.url) === realpathSync(process.argv[1]);\n',
        false,
      ],
      [
        'good-pathtofileurl.mjs',
        'const m = import' +
          '.meta.url === pathToFileURL(process.argv[1]).href;\n',
        false,
      ],
      [
        'commented-out.mjs',
        '// const m = import' +
          '.meta.url === `file://${process.argv[1]}`;\n',
        false,
      ],
    ];
    for (const [name, body] of cases) writeFileSync(join(dir, name), body);

    const flagged = new Set(
      findComparisons(
        cases.map(([name]) => join(dir, name)),
      )
        .filter((h) => !h.sanctioned)
        .map((h) => h.file.split('/').pop()),
    );
    rmSync(dir, { recursive: true, force: true });

    for (const [name, , shouldFlag] of cases) {
      assert.equal(
        flagged.has(name),
        shouldFlag,
        shouldFlag
          ? `the scan must flag ${name} — otherwise it proves nothing`
          : `the scan must NOT flag ${name} — a false positive makes the guard noise`,
      );
    }
  });

  it('never builds a file:// URL out of the entry path', () => {
    const offenders = findComparisons(files).filter((h) => !h.sanctioned);
    assert.deepEqual(
      offenders,
      [],
      'Compare paths with fileURLToPath (and realpath both sides), or reuse ' +
        'desktop/scripts/isEntryPoint.mjs. Concatenating the entry path into a ' +
        'file:// URL is false on Windows, on paths that percent-encode, and ' +
        'through symlinks — and it fails SILENTLY.\nOffenders:\n' +
        offenders.map((o) => `  ${o.file}:${o.line}`).join('\n'),
    );
  });
});
