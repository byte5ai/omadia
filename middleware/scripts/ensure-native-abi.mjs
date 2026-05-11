#!/usr/bin/env node
// ensure-native-abi — guard against the better-sqlite3 ABI-mismatch saga.
//
// Symptom: middleware crashes on boot with
//   `NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127`
// Cause: any earlier `npm install` that ran under a different Node version
// (typically v24, default on this machine) recompiled the native binary
// against the wrong ABI. The next `npm rebuild` from the wrapper picks up
// the wrong target unless `--target=<active-version>` is passed explicitly.
//
// This script is idempotent and dirt-cheap when nothing is wrong:
//   1. Probe `process.dlopen(...)` against the bundled binary.
//   2. If it loads under the active Node, exit 0 without touching anything.
//   3. If it fails with ERR_DLOPEN_FAILED, run
//      `npm rebuild better-sqlite3 --build-from-source --target=<v> --runtime=node`.
//   4. Re-probe; exit 0 on success, 1 on failure.
//
// Saga reference: memory/feedback-node-version-pinning + repeated wrapper
// resets across May 4–8.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import Module from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const BINARY = path.join(
  ROOT,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);

function probe() {
  try {
    process.dlopen({ exports: {} }, BINARY);
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

function rebuild() {
  console.log(
    `[ensure-native-abi] better-sqlite3 ABI mismatch — rebuilding against Node ${process.version} (modules=${process.versions.modules})`,
  );
  // Resolve the active Node + npm CLIs to avoid PATH races (e.g. nvm shim
  // resolving to a different version than process.execPath).
  const nodeBin = process.execPath;
  const npmCli = path.join(path.dirname(nodeBin), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const nodeVersion = process.version.replace(/^v/, '');
  const args = [
    npmCli,
    'rebuild',
    'better-sqlite3',
    '--build-from-source',
    `--target=${nodeVersion}`,
    '--runtime=node',
  ];
  const result = spawnSync(nodeBin, args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return result.status === 0;
}

const first = probe();
if (first.ok) {
  // Silent fast-path: don't spam log on every dev restart.
  process.exit(0);
}

const code = first.err && first.err.code;
if (code !== 'ERR_DLOPEN_FAILED') {
  console.error(`[ensure-native-abi] unexpected probe failure (code=${code}):`, first.err);
  process.exit(1);
}

const rebuilt = rebuild();
if (!rebuilt) {
  console.error('[ensure-native-abi] npm rebuild failed — see output above');
  process.exit(1);
}

const second = probe();
if (!second.ok) {
  console.error(
    '[ensure-native-abi] still failing after rebuild — manual intervention needed:',
    second.err && second.err.message,
  );
  process.exit(1);
}

console.log('[ensure-native-abi] better-sqlite3 ABI matched after rebuild.');
process.exit(0);
