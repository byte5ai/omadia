import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';

import { packagedPackagesEnv, packagedVersionEnv } from '../src/kernelEnvDefaults.ts';

const runtime = { packaged: true, version: '1.2.3', kernelCwd: '/app/omadia/middleware' };

describe('env only the packaged app sets', () => {
  it('stamps the version the kernel and the web UI report', () => {
    assert.deepEqual(packagedVersionEnv(runtime), { OMADIA_VERSION: 'v1.2.3' });
  });

  it('loads built-in plugins from where @omadia/* imports resolve, so there is one module instance', () => {
    assert.deepEqual(packagedPackagesEnv(runtime), {
      BUILT_IN_PACKAGES_DIR: path.join('/app/omadia/middleware', 'node_modules', '@omadia'),
    });
  });

  it('leaves a dev run on the kernel defaults', () => {
    const dev = { ...runtime, packaged: false };
    assert.deepEqual(packagedVersionEnv(dev), {});
    assert.deepEqual(packagedPackagesEnv(dev), {});
  });
});
