#!/usr/bin/env node
// ensure-native-abi — fail fast if better-sqlite3's native addon can't load.
//
// History (better-sqlite3 <= 12): the addon was a Node-ABI-specific binary at
// `build/Release/better_sqlite3.node`, compiled at install time. Any `npm
// install` that ran under a different Node major recompiled it against the
// wrong ABI and the middleware then crashed on boot with
//   `NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127`
// This script used to detect that and repair it with
// `npm rebuild better-sqlite3 --build-from-source --target=<active-version>`.
//
// Since better-sqlite3 v13 the addon is built on N-API (node-addon-api) and
// ships prebuilt binaries under `prebuilds/<platform>-<arch>.node` that are
// ABI-stable across Node majors. The mismatch this script was written for can
// no longer happen, so the rebuild path is gone — forcing a source build would
// now only demand a C++ toolchain nobody needs. The old probe also hardcoded
// the `build/Release/...` path, which v13 no longer produces at all.
//
// What remains is a cheap end-to-end probe: load the module and run one query.
// That catches a corrupt install, a platform with no prebuild, or a partially
// extracted node_modules at `npm run dev` time instead of at first DB access.

import process from 'node:process';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

try {
  const Database = requireCjs('better-sqlite3');
  const db = new Database(':memory:');
  db.prepare('select 1 as ok').get();
  db.close();
  process.exit(0);
} catch (err) {
  console.error(
    `[ensure-native-abi] better-sqlite3 native addon failed to load under Node ${process.version} (${process.platform}-${process.arch}).`,
  );
  console.error(`[ensure-native-abi] ${err && err.message}`);
  console.error('[ensure-native-abi] Try a clean reinstall:  rm -rf node_modules && npm ci');
  process.exit(1);
}
