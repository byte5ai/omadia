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
 *   node scripts/check-core-decoupling.mjs --update   # lower the baseline
 *
 * `--update` only ever lowers it. Raising the baseline requires editing the
 * committed value by hand, which is exactly the kind of change that should
 * show up in a diff and be argued for in review.
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
 * Identifiers that only exist because the Dev Platform lives in core.
 * Deliberately literal — a broad `/dev/i` would drown in false positives
 * ("developer", "device", "devDependencies").
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
  { name: 'web-ui/app', path: 'web-ui/app' },
  { name: 'web-ui/messages', path: 'web-ui/messages' },
  { name: 'ci-workflows', path: '.github/workflows' },
  { name: 'scripts', path: 'scripts' },
  { name: 'compose', path: '.', globs: ['docker-compose*.yaml', 'Dockerfile'] },
];

/** Build output and vendored code regenerate; they are not source. */
const EXCLUDE_GLOBS = [
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/.next/**',
  '!**/*.tsbuildinfo',
  '!**/package-lock.json',
  '!**/*.map',
];

function rgCount(zone) {
  const args = ['--no-config', '--no-heading', '--with-filename', '--line-number'];
  for (const p of PATTERNS) args.push('-e', p);
  for (const g of EXCLUDE_GLOBS) args.push('--glob', g);
  if (zone.globs) for (const g of zone.globs) args.push('--glob', g);
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

const baseline = loadBaseline();
if (!baseline) {
  console.error(
    `no baseline at ${path.relative(REPO_ROOT, BASELINE_FILE)} — run with --update to create one.`,
  );
  process.exit(1);
}

if (result.total > baseline.total) {
  const worse = Object.entries(result.zones)
    .filter(([name, count]) => count > (baseline.zones[name] ?? 0))
    .map(([name, count]) => `  ${name}: ${String(baseline.zones[name] ?? 0)} → ${String(count)}`);
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
