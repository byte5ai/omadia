#!/usr/bin/env node
/**
 * Golden `.d.ts` API snapshot for `@omadia/plugin-api` (epic #470, item C1).
 *
 * WHY THIS EXISTS
 * ---------------
 * This package is the type contract between the kernel and every plugin. Today
 * nothing stops a breaking change to `PluginContext` — a renamed method, a
 * widened parameter, a removed field — from landing silently: `tsc` is happy
 * because every consumer still lives in this repo and gets recompiled in the
 * same commit. Once plugins live in their own repos (D1) that same silence is
 * an incident somewhere else, discovered at install time.
 *
 * So the surface becomes machine-checked. We compile the package's declarations
 * and compare the normalized result against a committed snapshot. Any change to
 * the emitted types shows up as a reviewable diff in the PR that causes it.
 *
 * WHAT IS SNAPSHOTTED
 * -------------------
 * Every `.d.ts` the package emits, not just `index.d.ts`. `index.ts` re-exports
 * most modules but the emitted declarations are what a consumer's `tsc` actually
 * reads, so the whole emitted tree is the contract. Files are concatenated in
 * code-unit-sorted POSIX path order, so the snapshot is stable regardless of
 * filesystem enumeration order or ambient locale collation.
 *
 * NORMALIZATION
 * -------------
 * Comments are stripped (a reworded JSDoc paragraph is not an API change),
 * blank lines are dropped, and runs of whitespace collapse to a single space.
 * What survives is the shape: names, modifiers, parameter lists, type
 * expressions. The comment stripper is a small scanner rather than a regex,
 * because `.d.ts` string-literal types legitimately contain `//` and `/*`.
 *
 * WHY DECLARATIONS GO TO A TEMP DIR
 * ---------------------------------
 * Not into `dist/`. Under the root suite this check runs alongside other test
 * files that import this package's compiled output; rewriting `dist/` in place
 * would race them. Emitting declarations only, into a throwaway directory, also
 * keeps the check honest: it always measures the CURRENT `src/`, never whatever
 * a previous build happened to leave behind.
 *
 *   node scripts/api-snapshot.mjs            # check (default) — fails on drift
 *   node scripts/api-snapshot.mjs --check    # same, explicit
 *   node scripts/api-snapshot.mjs --update   # accept the current surface
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIR = path.join(PACKAGE_ROOT, 'api-snapshot');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'plugin-api.d.ts.snap');
const SNAPSHOT_REL = path.relative(PACKAGE_ROOT, SNAPSHOT_FILE).split(path.sep).join('/');

/** Beyond this many line-pairs the LCS table is not worth the memory; report coarsely. */
const MAX_DIFF_CELLS = 2_000_000;
/** Lines of unchanged context printed around each hunk. */
const DIFF_CONTEXT = 3;
/** Code-unit ordering. Never `localeCompare`: a golden snapshot's order must not depend on ambient collation. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/** Locate the workspace `tsc`. Package-local first, then the hoisted install. */
function resolveTsc() {
  const candidates = [
    path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc'),
    path.join(PACKAGE_ROOT, '..', '..', 'node_modules', '.bin', 'tsc'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    `Could not find tsc. Looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}\n` +
      'Run `npm install` in middleware/ first.',
  );
}

/** Compile declarations only, into `outDir`. Throws with tsc's output on failure. */
function emitDeclarations(outDir) {
  try {
    execFileSync(
      resolveTsc(),
      [
        '-p',
        path.join(PACKAGE_ROOT, 'tsconfig.json'),
        '--outDir',
        outDir,
        '--declaration',
        '--emitDeclarationOnly',
        '--declarationMap',
        'false',
        '--sourceMap',
        'false',
        // `composite`/`incremental` would drop a .tsbuildinfo next to the
        // output and let a stale cache answer for the current source.
        '--composite',
        'false',
        '--incremental',
        'false',
        '--pretty',
        'false',
      ],
      { cwd: PACKAGE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    throw new Error(`tsc failed to emit declarations:\n\n${output || error.message}`);
  }
}

/** Every file under `dir` matching `suffix`, as POSIX paths relative to `dir`, sorted. */
function listFiles(dir, suffix) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      byCodeUnit(a.name, b.name),
    )) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (entry.name.endsWith(suffix)) {
        out.push(path.relative(dir, full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort(byCodeUnit);
}

/**
 * Guard against a silently empty snapshot.
 *
 * A snapshot check that compares nothing to nothing passes forever. If `rootDir`
 * shifts, or the `include` glob stops matching, tsc exits 0 having emitted less
 * than the source tree — and every future breaking change sails through green.
 * So derive the expectation from what is on disk: every `src/**\/*.ts` must have
 * produced a matching `.d.ts`.
 */
function assertEmitCoverage(sourceFiles, declarationFiles) {
  const emitted = new Set(declarationFiles);
  const missing = sourceFiles
    .map((file) => file.replace(/\.ts$/, '.d.ts'))
    .filter((expected) => !emitted.has(expected));

  if (sourceFiles.length === 0) {
    throw new Error(
      'No source files found under src/. The snapshot would be empty, which would ' +
        'pass forever while checking nothing.',
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `tsc emitted no declaration for ${missing.length} source file(s) — the snapshot ` +
        `would cover less than the package:\n${missing.map((f) => `  ${f}`).join('\n')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/**
 * Remove line and block comments, leaving string and template literals intact.
 *
 * A regex cannot do this correctly here: `.d.ts` files carry string-literal
 * types and template-literal types whose contents include `//` (URLs, route
 * prefixes) and `/*`. This scanner tracks quoting, so those survive.
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      // A space, not nothing: `a/* x */b` must not become `ab`.
      out += ' ';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      out += char;
      i += 1;
      while (i < source.length) {
        const inner = source[i];
        if (inner === '\\') {
          out += inner + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += inner;
        i += 1;
        if (inner === char) break;
      }
      continue;
    }

    out += char;
    i += 1;
  }
  return out;
}

/** Comment-free, blank-free, whitespace-collapsed lines for one declaration file. */
function normalizeDeclaration(source) {
  return stripComments(source)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/** Build the full snapshot text for an emitted declaration tree. */
function buildSnapshot(outDir, declarationFiles) {
  const lines = [
    '// Golden API snapshot for @omadia/plugin-api — generated, do not hand-edit.',
    '// Regenerate deliberately: npm run api:update -w packages/plugin-api',
  ];
  for (const file of declarationFiles) {
    lines.push('');
    lines.push(`// ===== ${file} =====`);
    lines.push(...normalizeDeclaration(readFileSync(path.join(outDir, file), 'utf8')));
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** Longest-common-subsequence edit script over two line arrays. */
function diffLines(before, after) {
  const rows = before.length;
  const cols = after.length;
  const table = new Int32Array((rows + 1) * (cols + 1));
  const at = (r, c) => r * (cols + 1) + c;

  for (let r = rows - 1; r >= 0; r -= 1) {
    for (let c = cols - 1; c >= 0; c -= 1) {
      table[at(r, c)] =
        before[r] === after[c]
          ? table[at(r + 1, c + 1)] + 1
          : Math.max(table[at(r + 1, c)], table[at(r, c + 1)]);
    }
  }

  const ops = [];
  let r = 0;
  let c = 0;
  while (r < rows && c < cols) {
    if (before[r] === after[c]) {
      ops.push({ kind: ' ', text: before[r] });
      r += 1;
      c += 1;
    } else if (table[at(r + 1, c)] >= table[at(r, c + 1)]) {
      ops.push({ kind: '-', text: before[r] });
      r += 1;
    } else {
      ops.push({ kind: '+', text: after[c] });
      c += 1;
    }
  }
  while (r < rows) ops.push({ kind: '-', text: before[r++] });
  while (c < cols) ops.push({ kind: '+', text: after[c++] });
  return ops;
}

/** Render a unified diff, or a coarse summary when the inputs are too large to align. */
function unifiedDiff(before, after, fromLabel, toLabel) {
  // Trim the identical head and tail first: a one-symbol change then aligns two
  // tiny arrays instead of two thousand-line ones.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const beforeCore = before.slice(head, before.length - tail);
  const afterCore = after.slice(head, after.length - tail);

  if (beforeCore.length * afterCore.length > MAX_DIFF_CELLS) {
    return [
      `--- ${fromLabel}`,
      `+++ ${toLabel}`,
      `@@ the surface changed in ${beforeCore.length} → ${afterCore.length} lines starting at line ${head + 1} @@`,
      'Too large to align line-by-line. First differing lines:',
      `- ${beforeCore[0] ?? '(end of file)'}`,
      `+ ${afterCore[0] ?? '(end of file)'}`,
    ].join('\n');
  }

  const ops = diffLines(beforeCore, afterCore);
  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];

  // Emit each run of changes with a little context around it.
  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === ' ') {
      index += 1;
      continue;
    }
    let end = index;
    while (end < ops.length && ops[end].kind !== ' ') end += 1;
    const from = Math.max(0, index - DIFF_CONTEXT);
    const to = Math.min(ops.length, end + DIFF_CONTEXT);
    out.push(`@@ around snapshot line ${head + from + 1} @@`);
    for (const op of ops.slice(from, to)) out.push(`${op.kind}${op.text}`);
    index = to;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = new Set(process.argv.slice(2));
  const doUpdate = args.has('--update');

  const outDir = mkdtempSync(path.join(os.tmpdir(), 'omadia-plugin-api-dts-'));
  let snapshot;
  try {
    emitDeclarations(outDir);
    const sourceFiles = listFiles(path.join(PACKAGE_ROOT, 'src'), '.ts');
    const declarationFiles = listFiles(outDir, '.d.ts');
    assertEmitCoverage(sourceFiles, declarationFiles);
    snapshot = buildSnapshot(outDir, declarationFiles);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  if (doUpdate) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const changed = !existsSync(SNAPSHOT_FILE) || readFileSync(SNAPSHOT_FILE, 'utf8') !== snapshot;
    writeFileSync(SNAPSHOT_FILE, snapshot);
    console.log(
      changed
        ? `Wrote ${SNAPSHOT_REL} (${snapshot.split('\n').length - 1} lines).\n` +
            'Review the diff, then bump the package version — a removed or narrowed ' +
            'symbol is a MAJOR, an added one a MINOR.'
        : `${SNAPSHOT_REL} already up to date.`,
    );
    return;
  }

  if (!existsSync(SNAPSHOT_FILE)) {
    console.error(
      `\n✗ No API snapshot at ${SNAPSHOT_REL}.\n` +
        'Create it with:  npm run api:update -w packages/plugin-api\n',
    );
    process.exit(1);
  }

  const committed = readFileSync(SNAPSHOT_FILE, 'utf8');
  if (committed === snapshot) {
    console.log(`✓ API snapshot up to date (${SNAPSHOT_REL}).`);
    return;
  }

  console.error(
    `\n✗ The public type surface of @omadia/plugin-api changed.\n\n` +
      unifiedDiff(
        committed.split('\n'),
        snapshot.split('\n'),
        `committed ${SNAPSHOT_REL}`,
        'current src/',
      ) +
      `\n\nThis package is the contract every plugin compiles against, so the change is\n` +
      `only allowed to land deliberately. If it is intended:\n\n` +
      `  1. npm run api:update -w packages/plugin-api\n` +
      `  2. Bump the version in packages/plugin-api/package.json:\n` +
      `       symbol removed / signature narrowed / field made required  → MAJOR\n` +
      `       symbol added / field made optional                          → MINOR\n` +
      `       nothing in this diff                                        → no bump\n` +
      `  3. Commit the regenerated snapshot alongside the source change.\n`,
  );
  process.exit(1);
}

main();
