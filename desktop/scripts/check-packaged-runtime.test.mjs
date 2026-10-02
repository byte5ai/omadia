// Tests for the packaged-runtime check, and for the extraResources block that
// keeps the runtime's node_modules in the package (see electron-builder.yml).
//
// Run: node --test desktop/scripts/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { RUNTIME_SENTINELS, assertRuntimeComplete, missingRuntimeEntries } from './check-packaged-runtime.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFiles(root, relPaths) {
  for (const rel of relPaths) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
  }
}

test('a complete package passes', (t) => {
  const root = tempDir(t);
  writeFiles(root, RUNTIME_SENTINELS);
  assert.deepEqual(missingRuntimeEntries(root), []);
  assert.doesNotThrow(() => assertRuntimeComplete(root));
});

test('a package without the kernel node_modules fails', (t) => {
  const kernel = RUNTIME_SENTINELS.filter((rel) => rel.startsWith('omadia/middleware/node_modules/'));
  const root = tempDir(t);
  writeFiles(root, RUNTIME_SENTINELS.filter((rel) => !kernel.includes(rel)));
  assert.deepEqual(missingRuntimeEntries(root), kernel);
  assert.throws(() => assertRuntimeComplete(root), /the kernel or the web UI loads at startup/);
});

test('a package without the web UI node_modules fails', (t) => {
  const root = tempDir(t);
  writeFiles(root, RUNTIME_SENTINELS.filter((rel) => !rel.startsWith('omadia/web-ui/node_modules/')));
  assert.throws(() => assertRuntimeComplete(root), /omadia\/web-ui\/node_modules\/next\/package\.json/);
});

test('electron-builder copies the whole staged runtime with this repo\'s extraResources block', async (t) => {
  // The electron-builder the desktop build installs, so its next bump runs this
  // against its own copy rules before a release build does.
  const builderLib = createRequire(import.meta.url).resolve('app-builder-lib/package.json');
  const fromBuilder = createRequire(builderLib);
  const { copyFiles, getFileMatchers } = fromBuilder('./out/fileMatcher.js');
  const yaml = fromBuilder('js-yaml');
  const config = yaml.load(fs.readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'));

  const project = tempDir(t);
  const staged = [
    ...RUNTIME_SENTINELS,
    'omadia/middleware/node_modules/express/node_modules/debug/package.json',
    'omadia/middleware/packages/canvas-core/node_modules/@jridgewell/trace-mapping/package.json',
    'omadia/middleware/migrations/0001_init.sql',
  ];
  writeFiles(
    project,
    [...staged.map((rel) => rel.replace(/^omadia\//, 'runtime/')), 'runtime/omadia-pg/bin/postgres'],
  );
  const resources = path.join(project, 'resources');
  const matchers = getFileMatchers(config, 'extraResources', resources, {
    defaultSrc: project,
    macroExpander: (pattern) => pattern,
    customBuildOptions: {},
    globalOutDir: path.join(project, 'release'),
  });
  await copyFiles(matchers);

  assert.deepEqual(missingRuntimeEntries(resources), []);
  for (const rel of [...staged, 'omadia-pg/bin/postgres']) {
    assert.ok(fs.existsSync(path.join(resources, ...rel.split('/'))), `${rel} is in the package`);
  }
});
