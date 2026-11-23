/**
 * The REAL plugin artifacts against the REAL ingest gate (#2043 rollout).
 *
 * channel-teams 0.36.0 could not be installed anywhere: it shipped a file the
 * zip ingest refuses. Every other test of that package had unpacked or linked
 * it by hand, so nothing ever asked the gate. This suite takes built zips and
 * pushes each one through `PackageUploadService.ingest`, exactly as an
 * upload or a Hub install does.
 *
 * Opt-in, because the artifacts live in sibling repositories:
 *
 *   OMADIA_REAL_PLUGIN_ZIPS=/path/a.zip:/path/b.zip npm test -- test/realPluginZipIngest.test.ts
 *
 * Without the variable the suite is skipped. The release checklist of a
 * plugin repository and the facilitator smoke kit (`data/e2e-2043/fresh.sh`)
 * run it with the zips they are about to publish or install.
 */

import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import { fakeCatalog, fakeStore } from './_helpers/pluginPackageZip.js';

const ZIPS = (process.env['OMADIA_REAL_PLUGIN_ZIPS'] ?? '')
  .split(':')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

/** The limits of the production upload route's defaults, not a test's. */
const LIMITS = { maxBytes: 50 * 1024 * 1024, maxExtractedBytes: 200 * 1024 * 1024, maxEntries: 5_000 };

describe('real plugin zips pass the ingest', { skip: ZIPS.length === 0 }, () => {
  for (const zipPath of ZIPS) {
    it(`ingests ${path.basename(zipPath)}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'real-zip-ingest-'));
      try {
        const packagesDir = path.join(root, '.uploaded-packages');
        await fs.mkdir(packagesDir, { recursive: true });
        const service = new PackageUploadService({
          store: fakeStore(),
          catalog: fakeCatalog(),
          packagesDir,
          limits: LIMITS,
          hostDependencies: {},
          log: () => undefined,
        });
        const result = await service.ingest({
          fileBuffer: await fs.readFile(zipPath),
          originalFilename: path.basename(zipPath),
          uploadedBy: 'release-check@example.com',
        });
        assert.equal(result.ok, true, `${zipPath} was refused: ${JSON.stringify(result)}`);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
