#!/usr/bin/env node
/**
 * Baut ein uploadbares Agent-Zip aus middleware/packages/agent-seo-analyst/.
 *
 * Flow:
 *   1. tsc mit package-lokalem tsconfig.json → dist/
 *   2. Staging-Verzeichnis unter out/seo-analyst-package/ befüllen
 *      (manifest.yaml, package.json, README.md, dist/, skills/)
 *   3. Als out/seo-analyst-<version>.zip packen
 *
 * Invariant: Das Zip darf keine TS-Quellen, keine node_modules und keine
 * Quer-Imports ins middleware-Tree enthalten. `npm run typecheck` im
 * Package-Root ist der Gatekeeper.
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIDDLEWARE_ROOT = resolve(here, '..');
const REPO_ROOT = resolve(MIDDLEWARE_ROOT, '..');
const AGENT_DIR = resolve(MIDDLEWARE_ROOT, 'packages/agent-seo-analyst');
const OUT_DIR = resolve(REPO_ROOT, 'out');
const STAGING = resolve(OUT_DIR, 'seo-analyst-package');

function section(title) {
  process.stdout.write(`\n\x1b[1m▸ ${title}\x1b[0m\n`);
}

function run(cmd, opts = {}) {
  process.stdout.write(`  $ ${cmd}\n`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------

const pkg = readJson(resolve(AGENT_DIR, 'package.json'));
const version = pkg.version;
if (!version) {
  throw new Error('package.json missing version');
}

section(`Build seo-analyst ${version}`);

section('Clean staging');
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });
rmSync(resolve(AGENT_DIR, 'dist'), { recursive: true, force: true });

section('Compile TypeScript');
run(`npx --prefix "${MIDDLEWARE_ROOT}" tsc --project "${AGENT_DIR}/tsconfig.json"`);

section('Assemble package');
for (const rel of ['manifest.yaml', 'package.json', 'README.md']) {
  const src = resolve(AGENT_DIR, rel);
  if (!existsSync(src)) throw new Error(`missing required file: ${rel}`);
  cpSync(src, resolve(STAGING, rel));
  process.stdout.write(`  + ${rel}\n`);
}

const dirs = ['dist', 'skills', 'assets'];
for (const dir of dirs) {
  const src = resolve(AGENT_DIR, dir);
  if (!existsSync(src)) {
    process.stdout.write(`  · ${dir}/ (not present, skipped)\n`);
    continue;
  }
  cpSync(src, resolve(STAGING, dir), { recursive: true });
  process.stdout.write(`  + ${dir}/\n`);
}

section('Verify layout');
const required = ['manifest.yaml', 'package.json', 'dist/plugin.js', 'dist/index.js'];
for (const rel of required) {
  const p = resolve(STAGING, rel);
  if (!existsSync(p)) {
    throw new Error(`staged package is missing ${rel}`);
  }
}

section('Zip');
const zipPath = resolve(OUT_DIR, `seo-analyst-${version}.zip`);
rmSync(zipPath, { force: true });
run(`cd "${STAGING}" && zip -r "${zipPath}" . -x '*.DS_Store' 'node_modules/*'`);

const size = statSync(zipPath).size;
process.stdout.write(
  `\n\x1b[32m✓ ${zipPath}\x1b[0m (${(size / 1024).toFixed(1)} kB)\n`,
);
process.stdout.write(`  Staging kept at ${STAGING} for inspection.\n`);
