#!/usr/bin/env node
/**
 * Core-decoupling ratchet for the Dev Platform extraction (epic #470).
 *
 * WHY THIS EXISTS
 * ---------------
 * `specs/470-dev-platform-plugin/core-decoupling-checklist.md` is a snapshot: it
 * tells you what was coupled the day it was written, and it goes stale the
 * moment anyone touches the tree. A checklist cannot tell you whether the
 * extraction is *finished*, and it cannot stop core from quietly re-acquiring a
 * dependency while the work is in flight.
 *
 * This does both, by counting references and refusing to let the count rise.
 * Extraction is done when the count is zero — that is the definition, and it is
 * machine-checked rather than asserted.
 *
 *   node scripts/check-core-decoupling.mjs            # verify against baseline
 *   node scripts/check-core-decoupling.mjs --report   # per-zone breakdown
 *   node scripts/check-core-decoupling.mjs --update   # record the count
 *
 * As of C13 the extraction is complete and the check asserts ZERO outright —
 * see `EXTRACTION_COMPLETE` below. The baseline file remains committed as the
 * record of where the count landed, and `--report` still shows per-zone
 * deltas against it, but it no longer decides pass/fail.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = path.join(
  REPO_ROOT,
  'specs/470-dev-platform-plugin/decoupling-baseline.json',
);

/**
 * Epic #470 C13 — the extraction is FINISHED and the floor is hard zero.
 *
 * While the work was in flight this was a ratchet: a committed count that was
 * allowed to fall and never rise. That shape was right for a migration in
 * progress and is wrong now. A ratchet parked at zero still reads its floor
 * out of a JSON file, and a JSON file is editable — one hand-edit and core can
 * legally re-acquire a reference again, which is precisely the outcome the
 * whole epic exists to prevent.
 *
 * So the check no longer asks the baseline what "good" means. Any reference at
 * all fails, whatever `decoupling-baseline.json` says. The baseline file stays
 * committed as the record of where the count landed and to give `--report` its
 * per-zone deltas, but it is no longer load-bearing for pass/fail.
 *
 * If the Dev Platform ever needs to come BACK into core, that is a real
 * architectural decision: flip this to `false`, restore a baseline, and argue
 * for it in review. It must not be reachable by editing a number.
 */
const EXTRACTION_COMPLETE = true;

/**
 * Identifiers that only exist because the Dev Platform lives in core.
 * Deliberately literal — a broad `/dev/i` would drown in false positives
 * ("developer", "device", "devDependencies").
 *
 * This array is itself 21 matches, which is why `EXCLUDE_GLOBS` below skips
 * this file: a detector that counts its own detector definitions can never
 * reach zero, and "zero except for the 27 that are the tool" is not a
 * property anyone can check at a glance. See the note there.
 */
const PATTERNS = [
  'devplatform',
  'dev-platform',
  'devPlatform',
  'DEV_PLATFORM',
  'devJob',
  'DevJob',
  'dev_job',
  'dev_repo',
  'dev_github_app',
  'dev_webhook',
  'devRunner',
  'dev-runner',
  'DEV_RUNNER',
  'DEV_FLY',
  'DEV_JOB',
  'DEV_WEBHOOK',
  'DEV_EGRESS',
  'DEV_ARTIFACT',
  'devWebhook',
  'devjobs',
  'djr_',
];

/**
 * Core-owned names that merely share the `DEV_` prefix. These are NOT
 * dev-platform and must never be counted, or the ratchet can never reach zero.
 */
const NOT_DEV_PLATFORM = [
  /DEV_ENDPOINTS_ENABLED/, // core dev-graph endpoints (/api/dev/*)
  /devteam/i, // dashboard onboarding persona
  /salesDev/, // builder persona template

  // ---------------------------------------------------------------------
  // Epic #470 C13 — the two things that must survive at a permanent zero.
  //
  // Both are HISTORICAL RECORD rather than coupling. Core reaching zero means
  // "no core code path, config key, fixture or comment refers to the Dev
  // Platform"; it cannot mean "rewrite what already happened", because a
  // record you are allowed to edit is not a record. Each entry is anchored on
  // a specific path so it cannot quietly widen into a general amnesty.
  // ---------------------------------------------------------------------

  // Migrations 0022–0030 created the Dev Platform's nine tables while it lived
  // in core, so every deployment that ran them has those FILENAMES in its
  // `schema_migrations` ledger. C11's plugin-side migrator seeds its own ledger
  // from exactly those donor rows (matched by filename, each guarded by a
  // schema witness) so the plugin does not re-run DDL that already applied.
  // Rename or reword one and the handoff stops matching on the installations
  // that need it most. The DDL body is equally frozen: it names the real table
  // and column names (`dev_jobs`, `dev_job_events`, …) that exist in those
  // databases right now.
  /^middleware\/migrations\/00(?:2[2-9]|30)_[^:]*:/,

  // A published changelog entry for a released version of `@omadia/plugin-api`.
  // It exists to be FOUND: it spells out the removed exports on one line so a
  // consumer grepping its own source for `DevJobKind` lands on the entry that
  // explains where the type went. Rewording it to satisfy this ratchet would
  // break the one job it has and would misreport what that version shipped.
  /^middleware\/packages\/plugin-api\/CHANGELOG\.md:/,
];

/** Zones that must end up clean. Paths are repo-relative. */
const ZONES = [
  { name: 'middleware/src', path: 'middleware/src' },
  { name: 'middleware/test', path: 'middleware/test' },
  { name: 'middleware/packages', path: 'middleware/packages' },
  { name: 'middleware/scripts', path: 'middleware/scripts' },
  { name: 'middleware/sidecars', path: 'middleware/sidecars' },
  { name: 'middleware/migrations', path: 'middleware/migrations' },
  { name: 'middleware/package.json', path: 'middleware/package.json' },
  // Operator-facing config docs. A zone gap here let the count read 0 while
  // .env.example still documented 15 DEV_* keys — found by adversarial review.
  { name: 'middleware/env-example', path: 'middleware/.env.example' },
  { name: 'web-ui/app', path: 'web-ui/app' },
  { name: 'web-ui/messages', path: 'web-ui/messages' },
  // Root-level config only — maxDepth 1, or this rescans web-ui/app and
  // double-counts it against the zone above. Overlapping zones make the
  // total meaningless.
  { name: 'web-ui/config', path: 'web-ui', maxDepth: 1 },
  { name: 'ci-workflows', path: '.github/workflows' },
  { name: 'scripts', path: 'scripts' },
  { name: 'compose', path: '.', maxDepth: 1 },
];

/** Build output and vendored code regenerate; they are not source. */
const EXCLUDE_GLOBS = [
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/.next/**',
  '!**/*.tsbuildinfo',
  '!**/package-lock.json',
  '!**/*.map',

  // This file. `PATTERNS` above has to spell out the 21 identifiers it hunts
  // for, and the prose has to explain them, so an unfiltered scan of the
  // `scripts` zone counted 27 hits against the detector itself. That is not a
  // coupling — nothing here imports, calls, configures or routes to the Dev
  // Platform — but it is indistinguishable from one in the total, and it made
  // the target "27" instead of "0". A ratchet whose floor is a magic number
  // nobody can verify at a glance is a ratchet people stop reading.
  //
  // Self-exclusion is safe precisely because this file is the detector: it has
  // no runtime, ships in no image, and adding a pattern here can only ever
  // make the check stricter. The narrower alternative — skipping just the
  // `PATTERNS` array by line range — would break the moment the array moved.
  '!**/check-core-decoupling.mjs',
];

function rgCount(zone) {
  const args = ['--no-config', '--no-heading', '--with-filename', '--line-number'];
  for (const p of PATTERNS) args.push('-e', p);
  for (const g of EXCLUDE_GLOBS) args.push('--glob', g);
  if (zone.globs) for (const g of zone.globs) args.push('--glob', g);
  if (zone.maxDepth !== undefined) args.push('--max-depth', String(zone.maxDepth));
  args.push('--', zone.path);

  let out = '';
  try {
    out = execFileSync('rg', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // rg exits 1 when there are no matches — that is success here.
    if (err.status === 1) return { count: 0, hits: [] };
    throw err;
  }

  const hits = out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter((line) => !NOT_DEV_PLATFORM.some((re) => re.test(line)));

  return { count: hits.length, hits };
}

function scan() {
  const zones = {};
  let total = 0;
  for (const zone of ZONES) {
    if (!zone.globs && !existsSync(path.join(REPO_ROOT, zone.path))) {
      zones[zone.name] = 0;
      continue;
    }
    const { count } = rgCount(zone);
    zones[zone.name] = count;
    total += count;
  }
  return { total, zones };
}

function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) return null;
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
}

function saveBaseline(result) {
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify({ total: result.total, zones: result.zones }, null, 2)}\n`,
  );
}

const mode = process.argv[2];
const result = scan();

if (mode === '--report') {
  const baseline = loadBaseline();
  console.log('Dev Platform references remaining in core\n');
  for (const [name, count] of Object.entries(result.zones)) {
    const was = baseline?.zones?.[name];
    const delta = was === undefined ? '' : ` (baseline ${String(was)})`;
    console.log(`  ${count === 0 ? 'CLEAN' : String(count).padStart(5)}  ${name}${delta}`);
  }
  console.log(`\n  TOTAL ${result.total}${baseline ? ` / baseline ${String(baseline.total)}` : ''}`);
  console.log(
    result.total === 0
      ? '\nExtraction complete — core has no Dev Platform references.'
      : '\nSee specs/470-dev-platform-plugin/core-decoupling-checklist.md',
  );
  process.exit(0);
}

if (mode === '--update') {
  const baseline = loadBaseline();
  if (EXTRACTION_COMPLETE && result.total > 0) {
    console.error(
      `refusing to record a non-zero baseline: ${String(result.total)} reference(s) found.\n` +
        'The extraction is complete (EXTRACTION_COMPLETE = true), so zero is the\n' +
        'only baseline this script will write. Remove the references, or make the\n' +
        'architectural argument for reversing the extraction.\n' +
        'Run `node scripts/check-core-decoupling.mjs --report` for the breakdown.',
    );
    process.exit(1);
  }
  if (baseline && result.total > baseline.total) {
    console.error(
      `refusing to raise the baseline: ${String(result.total)} > ${String(baseline.total)}.\n` +
        'The ratchet only goes down. If a new coupling is genuinely required,\n' +
        'edit the committed baseline by hand so it shows up in review.',
    );
    process.exit(1);
  }
  saveBaseline(result);
  console.log(
    `baseline updated: ${String(baseline?.total ?? 'none')} → ${String(result.total)}`,
  );
  process.exit(0);
}

if (EXTRACTION_COMPLETE) {
  if (result.total === 0) {
    console.log('Core is free of Dev Platform references.');
    process.exit(0);
  }
  const offenders = Object.entries(result.zones)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `  ${name}: ${String(count)}`);
  console.error(
    `Core re-acquired Dev Platform references: ${String(result.total)} found, 0 allowed.\n\n` +
      `${offenders.join('\n')}\n\n` +
      'The Dev Platform lives in its own repository (epic #470). Core carries no\n' +
      'code path, config key, i18n key, fixture or comment that names it, and\n' +
      'that is enforced as an absolute — there is no baseline to raise.\n\n' +
      'If you are adding a plugin integration point, name it generically: the\n' +
      'mechanisms are manifest-declared (permissions.public_paths + operator\n' +
      'grants, the service registry, the UI route catalogue), so core never has\n' +
      'to name a particular plugin.\n\n' +
      'Run `node scripts/check-core-decoupling.mjs --report` for the breakdown.',
  );
  process.exit(1);
}

const baseline = loadBaseline();
if (!baseline) {
  console.error(
    `no baseline at ${path.relative(REPO_ROOT, BASELINE_FILE)} — run with --update to create one.`,
  );
  process.exit(1);
}

// Per-zone, not just the total. An aggregate-only check passes when one zone
// falls while another rises by the same amount — which is exactly what a
// half-finished move looks like.
const regressed = Object.entries(result.zones)
  .filter(([name, count]) => count > (baseline.zones[name] ?? 0))
  .map(([name, count]) => `  ${name}: ${String(baseline.zones[name] ?? 0)} → ${String(count)}`);

if (regressed.length > 0 || result.total > baseline.total) {
  const worse = regressed.length > 0 ? regressed : ['  (total rose without a single zone rising)'];
  console.error(
    `Core re-acquired Dev Platform references: ${String(baseline.total)} → ${String(result.total)}\n\n` +
      `${worse.join('\n')}\n\n` +
      'The Dev Platform is being extracted into its own repository (epic #470),\n' +
      'so new references to it from core move the wrong way. If this is\n' +
      'unavoidable, raise the baseline in the same commit and say why.\n' +
      'Run `node scripts/check-core-decoupling.mjs --report` for the breakdown.',
  );
  process.exit(1);
}

if (result.total < baseline.total) {
  console.log(
    `Dev Platform references: ${String(baseline.total)} → ${String(result.total)} ` +
      `(-${String(baseline.total - result.total)}). Run --update to lower the baseline.`,
  );
  process.exit(0);
}

console.log(
  result.total === 0
    ? 'Core is free of Dev Platform references.'
    : `Dev Platform references held at ${String(result.total)}.`,
);
