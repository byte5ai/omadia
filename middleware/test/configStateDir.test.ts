import { strict as assert } from 'node:assert';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { resolveStateDir } from '../src/config.js';

/**
 * Guards the persistence-location precedence for writable state dirs
 * (memory store, uploaded plugin packages). The regression this prevents:
 * with `PLATFORM_DATA_DIR` set, these dirs MUST default under it (the data
 * volume) — otherwise they live in the image layer and get wiped on every
 * `docker compose up --build`, orphaning installed.json entries so locally
 * installed plugins silently stop loading.
 */
describe('resolveStateDir — persistent-state dir precedence', () => {
  const SAVED = {
    UPLOADED_PACKAGES_DIR: process.env['UPLOADED_PACKAGES_DIR'],
    PLATFORM_DATA_DIR: process.env['PLATFORM_DATA_DIR'],
    // `src/config.ts` runs dotenv with `override: true`, so a developer's local
    // `.env` (which sets `MEMORY_DIR=./.memory`) leaks into process.env at import
    // and would otherwise be read as an explicit override below. Isolate it too.
    MEMORY_DIR: process.env['MEMORY_DIR'],
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('honours an explicit env override verbatim (absolute)', () => {
    process.env['UPLOADED_PACKAGES_DIR'] = '/custom/uploads';
    process.env['PLATFORM_DATA_DIR'] = '/data';
    assert.equal(
      resolveStateDir('UPLOADED_PACKAGES_DIR', './.uploaded-packages', '.uploaded-packages'),
      '/custom/uploads',
    );
  });

  it('defaults UNDER PLATFORM_DATA_DIR when no explicit override', () => {
    delete process.env['UPLOADED_PACKAGES_DIR'];
    delete process.env['MEMORY_DIR'];
    process.env['PLATFORM_DATA_DIR'] = '/data';
    assert.equal(
      resolveStateDir('UPLOADED_PACKAGES_DIR', './.uploaded-packages', '.uploaded-packages'),
      path.join('/data', '.uploaded-packages'),
    );
    assert.equal(
      resolveStateDir('MEMORY_DIR', './.memory', '.memory'),
      path.join('/data', '.memory'),
    );
  });

  it('falls back to the legacy app-root default without PLATFORM_DATA_DIR', () => {
    delete process.env['UPLOADED_PACKAGES_DIR'];
    delete process.env['PLATFORM_DATA_DIR'];
    const resolved = resolveStateDir(
      'UPLOADED_PACKAGES_DIR',
      './.uploaded-packages',
      '.uploaded-packages',
    );
    assert.ok(path.isAbsolute(resolved));
    assert.ok(
      resolved.endsWith(`${path.sep}.uploaded-packages`),
      `expected legacy default to end with /.uploaded-packages, got ${resolved}`,
    );
    assert.ok(
      !resolved.includes(`${path.sep}data${path.sep}.uploaded-packages`),
      'legacy default must NOT be under a data dir',
    );
  });
});
