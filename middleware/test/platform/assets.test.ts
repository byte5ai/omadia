import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveAssetBundle } from '../../src/platform/assets.js';

describe('resolveAssetBundle', () => {
  const ENV_VAR = 'OB41_TEST_ASSET_DIR';
  const FILE_ENV_VAR = 'OB41_TEST_ASSET_FILE';
  let workdir: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'ob41-assets-'));
    delete process.env[ENV_VAR];
    delete process.env[FILE_ENV_VAR];
  });

  afterEach(async () => {
    delete process.env[ENV_VAR];
    delete process.env[FILE_ENV_VAR];
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('uses the env-var path when set, marks source as "env"', () => {
    const dir = path.join(workdir, 'from-env');
    process.env[ENV_VAR] = dir;
    const bundle = resolveAssetBundle({
      id: 'demo',
      envVar: ENV_VAR,
      devFallback: '/some/dev/fallback',
      prodHint: 'COPY x ./x',
      kind: 'directory',
    });
    assert.equal(bundle.root, dir);
    assert.equal(bundle.source, 'env');
    assert.equal(bundle.kind, 'directory');
    assert.equal(bundle.envVar, ENV_VAR);
  });

  it('falls back to devFallback when env-var is unset, marks source as "devFallback"', () => {
    const fallback = path.join(workdir, 'fallback');
    const bundle = resolveAssetBundle({
      id: 'demo',
      envVar: ENV_VAR,
      devFallback: fallback,
      prodHint: 'COPY x ./x',
      kind: 'directory',
    });
    assert.equal(bundle.root, fallback);
    assert.equal(bundle.source, 'devFallback');
  });

  it('treats an empty env-var as unset (falls back)', () => {
    process.env[ENV_VAR] = '';
    const fallback = path.join(workdir, 'fallback');
    const bundle = resolveAssetBundle({
      id: 'demo',
      envVar: ENV_VAR,
      devFallback: fallback,
      prodHint: 'COPY x ./x',
      kind: 'directory',
    });
    assert.equal(bundle.source, 'devFallback');
    assert.equal(bundle.root, fallback);
  });

  it('verify() resolves cleanly when the directory exists', async () => {
    const dir = path.join(workdir, 'real-dir');
    await fs.mkdir(dir);
    process.env[ENV_VAR] = dir;
    const bundle = resolveAssetBundle({
      id: 'demo',
      envVar: ENV_VAR,
      devFallback: '/nope',
      prodHint: 'hint',
      kind: 'directory',
    });
    await bundle.verify();
  });

  it('verify() resolves cleanly when the file exists', async () => {
    const file = path.join(workdir, 'real.yaml');
    await fs.writeFile(file, 'key: value\n');
    process.env[FILE_ENV_VAR] = file;
    const bundle = resolveAssetBundle({
      id: 'registry',
      envVar: FILE_ENV_VAR,
      devFallback: '/nope',
      prodHint: 'hint',
      kind: 'file',
    });
    await bundle.verify();
  });

  it('verify() throws with id + path + envVar + prodHint when the path is missing', async () => {
    const dir = path.join(workdir, 'absent');
    process.env[ENV_VAR] = dir;
    const bundle = resolveAssetBundle({
      id: 'boilerplate',
      envVar: ENV_VAR,
      devFallback: '/dev/fallback',
      prodHint: 'COPY foo ./foo',
      kind: 'directory',
    });
    await assert.rejects(
      () => bundle.verify(),
      (err: Error) => {
        assert.match(err.message, /boilerplate/);
        assert.match(err.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(err.message, /not found/);
        assert.match(err.message, new RegExp(`Set ${ENV_VAR}`));
        assert.match(err.message, /COPY foo \.\/foo/);
        return true;
      },
    );
  });

  it('verify() throws when kind=directory but the path is a file', async () => {
    const file = path.join(workdir, 'i-am-a-file');
    await fs.writeFile(file, '');
    process.env[ENV_VAR] = file;
    const bundle = resolveAssetBundle({
      id: 'demo',
      envVar: ENV_VAR,
      devFallback: '/nope',
      prodHint: 'hint',
      kind: 'directory',
    });
    await assert.rejects(
      () => bundle.verify(),
      /is not a directory/,
    );
  });

  it('verify() throws when kind=file but the path is a directory', async () => {
    const dir = path.join(workdir, 'i-am-a-dir');
    await fs.mkdir(dir);
    process.env[FILE_ENV_VAR] = dir;
    const bundle = resolveAssetBundle({
      id: 'registry',
      envVar: FILE_ENV_VAR,
      devFallback: '/nope',
      prodHint: 'hint',
      kind: 'file',
    });
    await assert.rejects(
      () => bundle.verify(),
      /is not a file/,
    );
  });
});
