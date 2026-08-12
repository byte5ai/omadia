#!/usr/bin/env node
/**
 * Guards the file-scoped `--test-timeout` (issue #566).
 *
 * THE RISK
 * --------
 * node applies `--test-timeout` to the test FILE, not to each leaf. A file
 * whose leaves are each fast but whose total crosses the ceiling is killed as
 * a unit — and the failure looks like a timeout on whichever leaf happened to
 * be running, not like "this file grew too big". #550 sized the ceiling on the
 * slowest file of the day; nothing has watched the margin since.
 *
 * WHY A FRACTION AND NOT A COMMITTED BASELINE
 * -------------------------------------------
 * The repo's other ratchets (core-decoupling, test-typecheck, PG_TEST_FLOOR)
 * commit an absolute number, because they count things that do not vary by
 * machine. Durations do: the same suite measured 36.5 s locally on 16 cores
 * and 172 s on a 4-vCPU CI runner — a 4.7x spread. An absolute ms baseline
 * would either be tuned for CI and never fire locally, or tuned locally and
 * red on every CI run, and it would need re-committing every time the suite
 * legitimately grows. That is the stale-baseline failure this repo has
 * already been bitten by.
 *
 * A fraction of the ceiling is portable and cannot go stale: it measures the
 * exact thing the issue is about — how close the slowest file is to being
 * killed — on whatever machine is running.
 *
 * THE CEILING IS NOT DUPLICATED HERE
 * ----------------------------------
 * It is parsed out of the `test` script in package.json, so lowering
 * `--test-timeout` automatically tightens this guard instead of silently
 * widening the gap between the two numbers.
 *
 *   node scripts/check-test-file-durations.mjs            # gate
 *   node scripts/check-test-file-durations.mjs --report   # table only, always exit 0
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIDDLEWARE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DURATIONS_FILE = path.join(MIDDLEWARE_ROOT, 'test-file-durations.json');
const PACKAGE_JSON = path.join(MIDDLEWARE_ROOT, 'package.json');

/** Fail once a single file burns this share of its own ceiling. */
const FAIL_FRACTION = 0.5;
/** Name-and-shame threshold — visible long before it is a problem. */
const WARN_FRACTION = 0.25;
/** How many of the slowest files to print. */
const TOP_N = 10;

function readTimeoutMs() {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  const script = pkg.scripts?.test ?? '';
  const match = /--test-timeout=(\d+)/.exec(script);
  if (!match) {
    throw new Error(
      'Could not read --test-timeout from the `test` script in package.json. ' +
        'This guard derives the ceiling from there on purpose — if the flag moved, ' +
        'point this parser at its new home rather than hardcoding a second copy.',
    );
  }
  return Number(match[1]);
}

function main() {
  const reportOnly = process.argv.includes('--report');

  if (!existsSync(DURATIONS_FILE)) {
    console.error(
      `No ${path.relative(MIDDLEWARE_ROOT, DURATIONS_FILE)} found. Run \`npm test\` first — ` +
        'it writes the file via the testFileDurations reporter.',
    );
    process.exit(1);
  }

  const { files } = JSON.parse(readFileSync(DURATIONS_FILE, 'utf8'));
  if (!Array.isArray(files) || files.length === 0) {
    console.error(
      'test-file-durations.json contains no files. Either the run recorded nothing ' +
        '(reporter not wired up?) or every file vanished — both are worth failing on, ' +
        'because a guard that silently checks zero files is worse than no guard.',
    );
    process.exit(1);
  }

  const ceilingMs = readTimeoutMs();
  const failMs = ceilingMs * FAIL_FRACTION;
  const warnMs = ceilingMs * WARN_FRACTION;

  const sorted = [...files].sort((a, b) => b.durationMs - a.durationMs);
  const slowest = sorted[0];

  console.log(`Slowest test files (ceiling ${ceilingMs} ms per FILE, not per test)\n`);
  for (const entry of sorted.slice(0, TOP_N)) {
    const share = entry.durationMs / ceilingMs;
    const flag = entry.durationMs >= failMs ? 'FAIL' : entry.durationMs >= warnMs ? 'WARN' : '    ';
    console.log(
      `  ${flag} ${String(Math.round(entry.durationMs)).padStart(7)} ms  ` +
        `${(share * 100).toFixed(1).padStart(5)}%  ${entry.file}`,
    );
  }

  const headroom = ceilingMs / slowest.durationMs;
  console.log(
    `\n  ${files.length} files, slowest ${Math.round(slowest.durationMs)} ms ` +
      `= ${headroom.toFixed(1)}x headroom to the ${ceilingMs} ms ceiling.`,
  );

  if (reportOnly) return;

  const offenders = sorted.filter((entry) => entry.durationMs >= failMs);
  if (offenders.length > 0) {
    console.error(
      `\nA test file is within ${(1 - FAIL_FRACTION) * 100}% of the per-file timeout:\n`,
    );
    for (const entry of offenders) {
      console.error(`  ${entry.file} — ${Math.round(entry.durationMs)} ms of ${ceilingMs} ms`);
    }
    console.error(
      '\n`--test-timeout` kills the whole FILE, so this does not fail as one slow test —\n' +
        'it takes every test in the file with it, and blames whichever leaf was running.\n' +
        'Split the file, or make it faster. Raising --test-timeout only moves the cliff.',
    );
    process.exit(1);
  }

  const warned = sorted.filter((entry) => entry.durationMs >= warnMs);
  if (warned.length > 0) {
    console.log(
      `\n  ${warned.length} file(s) past ${WARN_FRACTION * 100}% of the ceiling — worth splitting before they reach ${FAIL_FRACTION * 100}%.`,
    );
  }
  console.log('\n✓ No test file is near the per-file timeout.');
}

main();
