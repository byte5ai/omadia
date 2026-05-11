#!/usr/bin/env node
/**
 * build-zip.mjs — baut ein uploadbares Agent-Package.
 *
 * Steps:
 *   1) npx tsc --project ./tsconfig.json      (→ dist/)
 *   2) Runtime-Artefakte nach out/<id>-<version>-package/ kopieren
 *   3) dist/<entry> verifizieren (sonst Abbruch)
 *   4) zippen zu out/<id>-<version>.zip
 *
 * Zip-Inhalt (strikt): manifest.yaml, package.json, dist/, skills/,
 *                      assets/ (optional), README.md, LICENSE (optional)
 * NICHT drin: TS-Quellen (*.ts außerhalb dist/), node_modules, .env, out/
 *
 * Extension-Allowlist im Host-Extractor:
 *   .yaml .md .json .js .mjs .cjs .map .png .svg .jpg .txt
 *   + LICENSE / README / NOTICE (ohne Extension)
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with code ${res.status}`);
  }
}

// --- 1) TypeScript compile ----------------------------------------------
console.log('▶ tsc');
run('npx', ['tsc', '--project', './tsconfig.json'], pkgRoot);

// --- 2) Metadata --------------------------------------------------------
const pkg = readJson(join(pkgRoot, 'package.json'));
if (!pkg.name || !pkg.version) {
  throw new Error('package.json: name + version required');
}
const entryRel = pkg.main ?? 'dist/index.js';
const entryAbs = join(pkgRoot, entryRel);
if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
  throw new Error(`entry not found after build: ${entryRel}`);
}

// --- 3) Stage runtime artefacts ----------------------------------------
const stageName = `${pkg.name}-${pkg.version}-package`;
const stageDir = join(pkgRoot, 'out', stageName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const INCLUDE = [
  'manifest.yaml',
  'package.json',
  'dist',
  'skills',
  'assets',
  'README.md',
  'LICENSE',
  'NOTICE',
];

for (const entry of INCLUDE) {
  const src = join(pkgRoot, entry);
  if (!existsSync(src)) continue;
  cpSync(src, join(stageDir, entry), { recursive: true });
}

// --- 4) Zip --------------------------------------------------------------
const zipPath = join(pkgRoot, 'out', `${pkg.name}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });

// Portable zip: bevorzugt `zip` CLI (macOS/Linux). Windows → 7z / PowerShell.
const zipRes = spawnSync('zip', ['-r', '-q', zipPath, stageName], {
  cwd: join(pkgRoot, 'out'),
  stdio: 'inherit',
});
if (zipRes.status !== 0) {
  throw new Error('zip CLI failed — auf Windows: 7z a oder Compress-Archive verwenden');
}

console.log(`✓ built ${zipPath}`);
