// Tests for the packaged-runtime check afterPack runs on every platform.
//
// The first Electron 44 build shipped without the kernel's and the web UI's
// node_modules: electron-builder 26 drops the top-level node_modules of every
// extraResources source. These tests pin the check that now fails such a build
// and the electron-builder.yml entries that keep the folders in the package.
//
// Run: node --test desktop/scripts/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RUNTIME_SENTINELS,
  assertRuntimeComplete,
  missingRuntimeEntries,
  packagedResourcesDir,
} from './check-packaged-runtime.mjs';

function resourcesWith(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-runtime-'));
  fs.mkdirSync(path.join(root, 'omadia', 'middleware', 'dist'), { recursive: true });
  for (const rel of entries) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
  }
  return root;
}

test('a complete package passes', () => {
  const root = resourcesWith(RUNTIME_SENTINELS);
  assert.deepEqual(missingRuntimeEntries(root), []);
  assert.doesNotThrow(() => assertRuntimeComplete(root));
});

test('a package without the kernel node_modules fails', () => {
  const kernel = RUNTIME_SENTINELS.filter((rel) => rel.startsWith('omadia/middleware/node_modules/'));
  const root = resourcesWith(RUNTIME_SENTINELS.filter((rel) => !kernel.includes(rel)));
  assert.deepEqual(missingRuntimeEntries(root), kernel);
  assert.throws(() => assertRuntimeComplete(root), /the packaged runtime is incomplete/);
});

test('a package without the web UI node_modules fails', () => {
  const root = resourcesWith(RUNTIME_SENTINELS.filter((rel) => !rel.startsWith('omadia/web-ui/')));
  assert.throws(() => assertRuntimeComplete(root), /omadia\/web-ui\/node_modules\/next\/package\.json/);
});

test('the resources directory per platform', () => {
  assert.equal(
    packagedResourcesDir('darwin', '/out/mac-arm64', 'omadia'),
    path.join('/out/mac-arm64', 'omadia.app', 'Contents', 'Resources'),
  );
  assert.equal(packagedResourcesDir('win32', '/out/win-unpacked', 'omadia'), path.join('/out/win-unpacked', 'resources'));
  assert.equal(packagedResourcesDir('linux', '/out/linux-unpacked', 'omadia'), path.join('/out/linux-unpacked', 'resources'));
});

test('electron-builder.yml ships both node_modules as extraResources of their own', () => {
  const yml = fs.readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  for (const dir of ['middleware', 'web-ui']) {
    assert.match(yml, new RegExp(`- from: runtime/${dir}/node_modules\\r?\\n\\s+to: omadia/${dir}/node_modules`));
  }
});
