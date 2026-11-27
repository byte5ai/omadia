#!/usr/bin/env node
/**
 * build-zip.mjs — builds an uploadable agent package.
 *
 * Steps:
 *   1) npx tsc --project ./tsconfig.json      (→ dist/)
 *   2) Copy runtime artefacts into out/<id>-<version>-package/
 *   3) Verify dist/<entry> exists (abort otherwise)
 *   4) Zip into out/<id>-<version>.zip
 *
 * Zip contents (strict): manifest.yaml, package.json, dist/, skills/,
 *                        assets/ (optional), README.md, LICENSE (optional)
 * NOT included: TS sources (*.ts outside dist/), node_modules, .env, out/
 *
 * Extension allowlist in the host extractor:
 *   .yaml .md .json .js .mjs .cjs .map .png .svg .jpg .txt
 *   + LICENSE / README / NOTICE (without extension)
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

// A failure ends the script with ONE line on stderr and a non-zero exit code,
// never an uncaught exception: Node would print a stack trace with the
// absolute staging path, and the Builder's tsc parser would fold its
// indented frames into the last TypeScript error (#1739).
function fail(message) {
  // Node's own error messages may carry the absolute package path.
  console.error(`✗ build-zip: ${message.split(pkgRoot).join('.')}`);
  process.exit(1);
}

function readJson(p) {
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    fail(`cannot read ${relative(pkgRoot, p)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${relative(pkgRoot, p)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    fail(`${cmd} ${args.join(' ')} failed with code ${res.status}`);
  }
}

// --- 1) TypeScript compile ----------------------------------------------
console.log('▶ tsc');
run('npx', ['tsc', '--project', './tsconfig.json'], pkgRoot);

// --- 2) Metadata --------------------------------------------------------
const pkg = readJson(join(pkgRoot, 'package.json'));
if (!pkg.name || !pkg.version) {
  fail('package.json: name + version required');
}
const entryRel = pkg.main ?? 'dist/index.js';
const entryAbs = join(pkgRoot, entryRel);
if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
  fail(`entry not found after build: ${entryRel}`);
}

// --- 3) Stage runtime artefacts ----------------------------------------
// Sanitize the package name for filesystem use the same way `npm pack`
// does: strip the leading `@` and replace `/` with `-`. Scoped names like
// `@omadia/agent-foo` would otherwise produce a wrapper path with an
// embedded slash, which makes the host extractor see TWO nested levels
// instead of one and fail to locate package.json.
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const stageName = `${safeName}-${pkg.version}-package`;
const stageDir = join(pkgRoot, 'out', stageName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const INCLUDE = [
  'manifest.yaml',
  'package.json',
  'dist',
  // Plugin-owned SQL. The host allows .sql in a package (zipExtractor.ts); without
  // this entry the directory is silently dropped here and the install succeeds with
  // no schema at all — a green install and a missing table.
  'migrations',
  'skills',
  'assets',
  'README.md',
  'LICENSE',
  'NOTICE',
];

for (const entry of INCLUDE) {
  const src = join(pkgRoot, entry);
  if (!existsSync(src)) continue;
  try {
    cpSync(src, join(stageDir, entry), { recursive: true });
  } catch (err) {
    fail(`cannot stage ${entry}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- 4) Zip --------------------------------------------------------------
const zipPath = join(pkgRoot, 'out', `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });

// Portable zip: bevorzugt `zip` CLI (macOS/Linux). Windows → 7z / PowerShell.
const zipRes = spawnSync('zip', ['-r', '-q', zipPath, stageName], {
  cwd: join(pkgRoot, 'out'),
  stdio: 'inherit',
});
if (zipRes.status !== 0) {
  fail('zip CLI failed — auf Windows: 7z a oder Compress-Archive verwenden');
}

console.log(`✓ built ${zipPath}`);
