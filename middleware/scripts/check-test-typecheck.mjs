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
 * 130-file diff. So — exactly like `scripts/check-core-decoupling.mjs` — this
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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIDDLEWARE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = path.join(MIDDLEWARE_ROOT, 'test-typecheck-baseline.json');
const TSC = path.join(MIDDLEWARE_ROOT, 'node_modules', '.bin', 'tsc');

// The orphaned projects. Both extend the root tsconfig and add `../src/**/*.ts`,
// so src is (re)checked here too — it is clean, so it contributes nothing.
const PROJECTS = ['test/tsconfig.json', 'scripts/tsconfig.json'];

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

// A primary diagnostic line: `relative/path.ts(line,col): error TS1234: message`.
// Continuation lines (indented type text) do not match and are ignored.
const ERR_RE = /^(.+?)\((\d+),(\d+)\): error TS\d+/;

/** Count errors per file across all projects (max across projects, so a file
 *  reachable from both `../src` includes is not double-counted). */
function collectCounts() {
  const perProject = [];
  let sawCrash = false;
  for (const project of PROJECTS) {
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
