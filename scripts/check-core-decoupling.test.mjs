import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-core-decoupling.mjs');
const PROBE_DIR = path.join(REPO_ROOT, 'middleware/src/__probe');
const PROBE_FILE = path.join(PROBE_DIR, 'check-core-decoupling.mjs');
const PROBE_TOKENS = [
  ['dev', 'platform'].join(''),
  ['dev', 'Runner'].join(''),
  ['dev', '_job'].join(''),
];
const PROBE_BODY = `${PROBE_TOKENS.join(' ')}\n`;

function runChecker(args = []) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

test('anchored self-exclusion hides only the real detector file', () => {
  rmSync(PROBE_DIR, { recursive: true, force: true });

  const clean = runChecker();
  assert.equal(
    clean.status,
    0,
    `expected a clean tree to pass, got:\n${clean.stderr || clean.stdout}`,
  );
  assert.match(clean.stdout, /Core is free of Dev Platform references\./);

  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(PROBE_FILE, PROBE_BODY);

  try {
    const hit = runChecker();
    assert.equal(
      hit.status,
      1,
      `expected the probe file to trip the checker, got:\n${hit.stderr || hit.stdout}`,
    );
    assert.match(hit.stderr, /Core re-acquired Dev Platform references: 1 found, 0 allowed\./);
    assert.match(hit.stderr, /middleware\/src: 1/);
  } finally {
    rmSync(PROBE_DIR, { recursive: true, force: true });
  }

  const cleanAgain = runChecker();
  assert.equal(
    cleanAgain.status,
    0,
    `expected the tree to return to clean after removing the probe, got:\n${cleanAgain.stderr || cleanAgain.stdout}`,
  );
});

test('the script zone remains clean because the exact detector path is excluded', () => {
  const rg = spawnSync(
    'rg',
    [
      '--no-config',
      '--no-heading',
      '--with-filename',
      '--line-number',
      ...PROBE_TOKENS.flatMap((token) => ['-e', token]),
      '--glob',
      '!**/node_modules/**',
      '--glob',
      '!**/dist/**',
      '--glob',
      '!**/.next/**',
      '--glob',
      '!**/*.tsbuildinfo',
      '--glob',
      '!**/package-lock.json',
      '--glob',
      '!**/*.map',
      '--glob',
      '!scripts/check-core-decoupling.mjs',
      '--',
      'scripts',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  );

  assert.equal(
    rg.status,
    1,
    `expected no hits in the scripts zone, got:\n${rg.stderr || rg.stdout}`,
  );
  assert.equal(
    rg.stdout,
    '',
    'the anchored exclusion must still hide the one real detector file from the scripts zone',
  );
});
