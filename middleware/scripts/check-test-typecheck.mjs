#!/usr/bin/env node
/**
 * Test/scripts typecheck ratchet (issue #573).
 *
 * WHY THIS EXISTS
 * ---------------
 * `middleware/tsconfig.json` includes only the `src` tree, so the `test/` and
 * `scripts/` trees are outside the shipped project graph. `npm run typecheck`
 * (`tsc --noEmit` over src) never sees them. A type error in a test file passes
 * every gate and only surfaces when `tsx` hits it at runtime — or does not
 * surface at all, for a branch the test never takes. Same for one-off scripts.
 *
 * We do NOT fold the test tree into the root project: that would leak test-only
 * types into the shipped build's graph (Weegy's concern on #573). Instead the
 * committed `test/tsconfig.json` / `scripts/tsconfig.json` projects are typechecked
 * here, behind a ratchet.
 *
 * The trees carry a large pre-existing type-error debt (intentional partial
 * mocks, drifted fixtures, a few real bugs). Fixing all of it in one PR is a
 * 130-file diff. So — exactly like the #470 core-decoupling ratchet did, until
 * it was retired at C14 — this
 * counts errors per file against a committed baseline and refuses to let any
 * file's count rise. New test type errors fail CI immediately; the debt burns
 * down over time and the baseline only ever falls.
 *
 *   node scripts/check-test-typecheck.mjs            # verify against baseline
 *   node scripts/check-test-typecheck.mjs --report   # full per-file table
 *   node scripts/check-test-typecheck.mjs --update    # lower the baseline
 *
 * `--update` only ever lowers a file's count and drops files that reach zero.
 * It will NOT add a file that is not already in the baseline, and it cannot
 * raise a count — a NEW file with errors must be hand-added to the baseline
 * JSON, which is exactly the kind of change that should show up in a diff and
 * be argued for in review. (First run, with no baseline present, bootstraps the
 * full current snapshot.)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIDDLEWARE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = path.join(MIDDLEWARE_ROOT, 'test-typecheck-baseline.json');
const TSC = path.join(MIDDLEWARE_ROOT, 'node_modules', '.bin', 'tsc');

// The orphaned projects. Both extend the root tsconfig and add `../src/**/*.ts`,
// so src is (re)checked here too — it is clean, so it contributes nothing.
// Each entry pairs the project file with the tree it is responsible for; the
// coverage guard below asserts the project actually loads that whole tree.
const PROJECTS = [
  { project: 'test/tsconfig.json', tree: 'test' },
  { project: 'scripts/tsconfig.json', tree: 'scripts' },
];

const args = new Set(process.argv.slice(2));
const doUpdate = args.has('--update');
const doReport = args.has('--report');

/** Run `tsc -p <project>` and return its combined output (never throws on type errors). */
function runTsc(project) {
  try {
    execFileSync(TSC, ['-p', project, '--pretty', 'false'], {
      cwd: MIDDLEWARE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return ''; // exit 0 → no diagnostics
  } catch (err) {
    // tsc exits non-zero when it emits diagnostics; that is the expected path.
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

/** Every `.ts` file under `dir`, absolute, skipping node_modules/dist. */
function walkTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkTsFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Guard against silent coverage loss.
 *
 * A ratchet that measures errors is worthless if the project stops matching
 * files: `tsc` then exits 0 with no diagnostics, every baseline entry reads as
 * "improved", and the check prints ✓ while typechecking nothing. Verified: with
 * `test/tsconfig.json`'s include narrowed to one subdirectory, this script
 * reported "10 known error(s), no regressions" and exit 0 — 381 real errors
 * silently unchecked. Same failure class as the Postgres self-skip (#565/#612).
 *
 * So assert coverage directly, from the filesystem: every `.ts` file under the
 * tree a project owns must actually be loaded by that project. This derives the
 * expectation from what is on disk rather than pinning a count, so it cannot go
 * stale as the repo grows.
 */
function assertProjectCoverage() {
  const gaps = [];
  for (const { project, tree } of PROJECTS) {
    const listed = new Set(
      execFileSync(TSC, ['-p', project, '--listFilesOnly'], {
        cwd: MIDDLEWARE_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
        .split('\n')
        .filter(Boolean)
        .map((f) => path.resolve(MIDDLEWARE_ROOT, f.trim())),
    );
    for (const file of walkTsFiles(path.join(MIDDLEWARE_ROOT, tree))) {
      if (!listed.has(path.resolve(file))) {
        gaps.push({ project, file: path.relative(MIDDLEWARE_ROOT, file) });
      }
    }
  }
  if (!gaps.length) return;

  console.error(
    `\n✗ Test/scripts typecheck ratchet: ${gaps.length} file(s) on disk are NOT covered ` +
      `by their project — the ratchet would pass without checking them.\n`,
  );
  for (const { project, file } of gaps.slice(0, 20)) console.error(`  ${file}  (${project})`);
  if (gaps.length > 20) console.error(`  … and ${gaps.length - 20} more`);
  console.error(`\nFix the project's \`include\` so it covers the whole tree.\n`);
  process.exit(1);
}

// A primary diagnostic line: `relative/path.ts(line,col): error TS1234: message`.
// Continuation lines (indented type text) do not match and are ignored.
const ERR_RE = /^(.+?)\((\d+),(\d+)\): error TS\d+/;

/** Count errors per file across all projects (max across projects, so a file
 *  reachable from both `../src` includes is not double-counted). */
function collectCounts() {
  const perProject = [];
  let sawCrash = false;
  for (const { project } of PROJECTS) {
    const out = runTsc(project);
    const counts = new Map();
    let matched = 0;
    for (const line of out.split('\n')) {
      const m = ERR_RE.exec(line);
      if (!m) continue;
      matched += 1;
      const file = m[1].split(path.sep).join('/');
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    // tsc printed output we could not parse as file diagnostics → likely a
    // config/crash error (e.g. TS5083). Surface it rather than reading it as
    // "0 errors, all clear".
    if (out.trim() && matched === 0) {
      console.error(`\n[check-test-typecheck] ${project} produced unparsable tsc output:\n${out}`);
      sawCrash = true;
    }
    perProject.push(counts);
  }
  if (sawCrash) process.exit(1);

  const merged = new Map();
  for (const counts of perProject) {
    for (const [file, n] of counts) merged.set(file, Math.max(merged.get(file) ?? 0, n));
  }
  return merged;
}

function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) return null;
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
}

function writeBaseline(obj) {
  const sorted = Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

function total(map) {
  let t = 0;
  for (const n of map.values()) t += n;
  return t;
}

// ---------------------------------------------------------------------------

assertProjectCoverage();

const current = collectCounts();
const baselineObj = loadBaseline();

if (doReport) {
  console.log('Per-file type-error counts (test/ + scripts/ trees):\n');
  const rows = [...current.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [file, n] of rows) console.log(`  ${String(n).padStart(4)}  ${file}`);
  console.log(`\n  total: ${total(current)} errors across ${current.size} files`);
}

// Bootstrap: no baseline yet → snapshot the current state.
if (baselineObj === null) {
  if (!doUpdate) {
    console.error(
      `\nNo baseline at ${path.relative(MIDDLEWARE_ROOT, BASELINE_FILE)}.` +
        `\nRun: node scripts/check-test-typecheck.mjs --update  (to create it)\n`,
    );
    process.exit(1);
  }
  writeBaseline(Object.fromEntries(current));
  console.log(
    `Bootstrapped baseline: ${total(current)} errors across ${current.size} files → ` +
      `${path.relative(MIDDLEWARE_ROOT, BASELINE_FILE)}`,
  );
  process.exit(0);
}

const baseline = new Map(Object.entries(baselineObj));

if (doUpdate) {
  // Only ever lower. Keep min(old, current) for known files; drop zeros; never
  // add a file that is not already in the baseline.
  const next = {};
  const skippedNew = [];
  for (const [file, cur] of current) {
    if (!baseline.has(file)) {
      if (cur > 0) skippedNew.push(file);
      continue;
    }
    const lowered = Math.min(baseline.get(file), cur);
    if (lowered > 0) next[file] = lowered;
  }
  // Files in baseline no longer reported are fully fixed → dropped (min with 0).
  writeBaseline(next);
  const before = total(baseline);
  const after = total(new Map(Object.entries(next)));
  console.log(`Baseline lowered: ${before} → ${after} errors (${before - after} fixed).`);
  if (skippedNew.length) {
    console.log(
      `\nNOT added (new files with errors — hand-add to baseline if intentional):\n` +
        skippedNew.map((f) => `  ${f} (${current.get(f)})`).join('\n'),
    );
  }
  process.exit(0);
}

// Verify mode: no file may exceed its baseline; no new erroring file may appear.
const regressions = [];
for (const [file, cur] of current) {
  const allowed = baseline.get(file) ?? 0;
  if (cur > allowed) regressions.push({ file, cur, allowed });
}

const improvements = [];
for (const [file, allowed] of baseline) {
  const cur = current.get(file) ?? 0;
  if (cur < allowed) improvements.push({ file, cur, allowed });
}

if (regressions.length) {
  console.error(`\n✗ Test/scripts typecheck ratchet: NEW type errors (issue #573).\n`);
  for (const { file, cur, allowed } of regressions.sort((a, b) => a.file.localeCompare(b.file))) {
    console.error(
      allowed === 0
        ? `  ${file}: ${cur} error(s) — file not in baseline`
        : `  ${file}: ${cur} error(s) > baseline ${allowed}`,
    );
  }
  console.error(
    `\nFix the new error(s) above, or (only if you deliberately raised the debt) ` +
      `hand-edit ${path.relative(MIDDLEWARE_ROOT, BASELINE_FILE)}.\n` +
      `Run \`npm run typecheck:test -- --report\` for the full per-file table.\n`,
  );
  process.exit(1);
}

console.log(
  `✓ Test/scripts typecheck ratchet: ${total(current)} known error(s), no regressions ` +
    `(baseline ${total(baseline)}).`,
);
if (improvements.length) {
  console.log(
    `\n${improvements.length} file(s) improved below baseline — lower it with:\n` +
      `  npm run typecheck:test -- --update\n`,
  );
}
