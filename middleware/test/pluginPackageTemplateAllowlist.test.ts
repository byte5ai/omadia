/**
 * `.template` in the plugin-package extension allowlist — scoped to `appPackage/`.
 *
 * `@omadia/channel-teams` ships the Teams app-package manifest as a template
 * (`appPackage/manifest.json.template`) and the agent factory reads it verbatim
 * to build a per-agent Teams app (#860 W1a). Without the entry the extractor
 * rejects the whole package with `zip.forbidden_extension`, which is exactly
 * what a live store update hit: producer, gatekeeper and consumer are all
 * in-house and disagreed, so the feature could not install anywhere.
 *
 * The grant is deliberately SCOPED, mirroring `.woff2` under `ui/`: `.template`
 * says nothing about content, so it is admitted in the one directory that has a
 * reason to carry it and nowhere else. These tests pin the scope, not just the
 * happy path — if `.template` ever starts extracting outside `appPackage/`, the
 * narrowing has been lost.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import { extractZipToDir, ZipExtractionError } from '../src/plugins/zipExtractor.js';
import { readTemplateRevision } from '../src/services/teamsAppPackageAssets.js';
import {
  buildZip,
  fakeCatalog,
  fakeStore,
  packageZip,
} from './_helpers/pluginPackageZip.js';

/** Shape of the real file: JSON with the placeholders the factory substitutes. */
const MANIFEST_TEMPLATE = JSON.stringify(
  { id: '{{AGENT_APP_ID}}', name: { short: '{{AGENT_NAME}}' } },
  null,
  2,
);

// ---------------------------------------------------------------------------
// Extractor-level — the allowlist entry and its scope
// ---------------------------------------------------------------------------

describe('zipExtractor × .template', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-template-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function extract(
    files: Record<string, string>,
    overrides: Partial<Parameters<typeof extractZipToDir>[2]> = {},
  ): Promise<string[]> {
    const zipPath = path.join(root, 'in.zip');
    await fs.writeFile(zipPath, await buildZip(files));
    const result = await extractZipToDir(zipPath, path.join(root, 'out'), {
      maxEntries: 50,
      maxExtractedBytes: 1024 * 1024,
      ...overrides,
    });
    return result.files;
  }

  it('accepts appPackage/manifest.json.template under the default allowlist', async () => {
    const files = await extract({
      'appPackage/manifest.json.template': MANIFEST_TEMPLATE,
    });
    assert.deepEqual(files, ['appPackage/manifest.json.template']);
    assert.equal(
      await fs.readFile(
        path.join(root, 'out', 'appPackage', 'manifest.json.template'),
        'utf8',
      ),
      MANIFEST_TEMPLATE,
    );
  });

  // The scope IS the security property — a global `.template` grant would let
  // any package drop an arbitrarily-named blob anywhere in its tree.
  it('rejects .template at the package root', async () => {
    await assert.rejects(
      () => extract({ 'manifest.json.template': MANIFEST_TEMPLATE }),
      (err: unknown) => {
        assert.ok(err instanceof ZipExtractionError);
        assert.equal(err.code, 'zip.forbidden_extension');
        return true;
      },
    );
  });

  it('rejects .template in a directory that merely looks similar', async () => {
    await assert.rejects(
      () => extract({ 'appPackages/manifest.json.template': MANIFEST_TEMPLATE }),
      (err: unknown) =>
        err instanceof ZipExtractionError && err.code === 'zip.forbidden_extension',
    );
  });

  it('accepts appPackage/ below a single wrapper directory', async () => {
    // `npm pack`-style zips wrap everything in one top-level folder; the
    // sibling `ui/` rule tolerates that and this one has to match it.
    const files = await extract({
      'channel-teams/appPackage/manifest.json.template': MANIFEST_TEMPLATE,
    });
    assert.deepEqual(files, ['channel-teams/appPackage/manifest.json.template']);
  });

  // An explicit allowlist replaces the default set wholesale (the Profile-Bundle
  // importer relies on that), so it must not silently inherit `.template`.
  it('rejects .template when an explicit extensionAllowlist omits it', async () => {
    await assert.rejects(
      () =>
        extract(
          { 'appPackage/manifest.json.template': MANIFEST_TEMPLATE },
          { extensionAllowlist: new Set(['.json', '.yaml']) },
        ),
      (err: unknown) =>
        err instanceof ZipExtractionError && err.code === 'zip.forbidden_extension',
    );
  });

  it('still rejects an executable extension inside appPackage/', async () => {
    await assert.rejects(
      () => extract({ 'appPackage/run.sh': '#!/bin/sh\n' }),
      (err: unknown) =>
        err instanceof ZipExtractionError && err.code === 'zip.forbidden_extension',
    );
  });

  // The regression that would have caught this before it reached a live store
  // update: nothing ever held the PUBLISHED package layout against the ingest
  // gate. `npm run package` checks the zip is built and the drift-guard checks
  // versions, but neither asks "does this zip get past the extractor". These
  // are the four entries the 0.21.0 artifact actually carries under
  // `appPackage/` (verified against the hub zip's central directory), and
  // `teamsAppPackageAssets` requires the first three by name.
  // #2043 rollout: channel-teams 0.36.0 shipped `appPackage/TEMPLATE_REVISION`
  // (no extension), the kernel read exactly that name, and the ingest refused
  // the whole package. Producer and consumer agreed; the gate was never asked.
  // The name is now `TEMPLATE_REVISION.txt`; the bare name stays refused, so a
  // package that ships it fails here and not at a customer's install.
  it('accepts appPackage/TEMPLATE_REVISION.txt and still refuses the extension-less name', async () => {
    assert.deepEqual(await extract({ 'appPackage/TEMPLATE_REVISION.txt': '2\n' }), [
      'appPackage/TEMPLATE_REVISION.txt',
    ]);
    await assert.rejects(
      () => extract({ 'appPackage/TEMPLATE_REVISION': '2\n' }),
      (err: unknown) =>
        err instanceof ZipExtractionError &&
        err.code === 'zip.forbidden_extension' &&
        /appPackage\/TEMPLATE_REVISION has a disallowed extension \(<none>\)/.test(err.message),
    );
  });

  it('accepts the published channel-teams appPackage/ layout as a whole', async () => {
    const files = await extract({
      'appPackage/manifest.json.template': MANIFEST_TEMPLATE,
      // Extension-gated, so byte-accurate PNGs would prove nothing extra here.
      'appPackage/color.png': 'PNG',
      'appPackage/outline.png': 'PNG',
      'appPackage/README.md': '# app package\n',
    });
    assert.deepEqual(files.sort(), [
      'appPackage/README.md',
      'appPackage/color.png',
      'appPackage/manifest.json.template',
      'appPackage/outline.png',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Ingest-level — the store update that actually failed
// ---------------------------------------------------------------------------

describe('PackageUploadService ingest × the Teams app-package layout', () => {
  let root: string;
  let packagesDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-template-'));
    packagesDir = path.join(root, '.uploaded-packages');
    await fs.mkdir(packagesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function service(): PackageUploadService {
    return new PackageUploadService({
      store: fakeStore(),
      catalog: fakeCatalog(),
      packagesDir,
      limits: {
        maxBytes: 1024 * 1024,
        maxExtractedBytes: 4 * 1024 * 1024,
        maxEntries: 50,
      },
      hostDependencies: {},
      log: () => undefined,
    });
  }

  it('installs a channel package shipping appPackage/{template,icons}', async () => {
    const result = await service().ingest({
      fileBuffer: await packageZip('@omadia/channel-teams', '0.21.0', {
        'appPackage/manifest.json.template': MANIFEST_TEMPLATE,
        'appPackage/README.md': '# app package\n',
      }),
      originalFilename: 'channel-teams.zip',
      uploadedBy: 'operator@example.com',
    });

    assert.equal(result.ok, true);
    const finalDir = path.join(packagesDir, '@omadia', 'channel-teams', '0.21.0');
    assert.equal(
      await fs.readFile(
        path.join(finalDir, 'appPackage', 'manifest.json.template'),
        'utf8',
      ),
      MANIFEST_TEMPLATE,
    );
  });

  // The file list of the real `omadia-channel-teams-0.36.x.zip` (central
  // directory of the artifact, dist/ reduced to one module with every kind of
  // file tsc emits). Every entry the real package carries passes the real
  // ingest, and the kernel finds what it reads there by name.
  it('installs a package shaped exactly like channel-teams 0.36.1, and the kernel reads its template revision', async () => {
    const result = await service().ingest({
      fileBuffer: await packageZip('@omadia/channel-teams', '0.36.1', {
        LICENSE: 'MIT\n',
        'README.md': '# channel-teams\n',
        'package.json': '{"name":"@omadia/channel-teams","version":"0.36.1"}\n',
        'appPackage/README.md': '# app package\n',
        'appPackage/TEMPLATE_REVISION.txt': '2\n',
        'appPackage/color.png': 'PNG',
        'appPackage/outline.png': 'PNG',
        'appPackage/manifest.json.template': MANIFEST_TEMPLATE,
        'dist/plugin.js.map': '{}',
        'dist/plugin.d.ts': 'export {};\n',
        'dist/plugin.d.ts.map': '{}',
        'dist/teamsMeetingSource.js': 'export {};\n',
        'dist/teamsMeetingSource.js.map': '{}',
        'dist/teamsMeetingSource.d.ts': 'export {};\n',
        'dist/teamsMeetingSource.d.ts.map': '{}',
      }),
      originalFilename: 'omadia-channel-teams-0.36.1.zip',
      uploadedBy: 'operator@example.com',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const appPackage = path.join(packagesDir, '@omadia', 'channel-teams', '0.36.1', 'appPackage');
    assert.equal(await readTemplateRevision(appPackage), 2);
  });

  it('refuses the 0.36.0 shape (extension-less TEMPLATE_REVISION) with the entry named', async () => {
    const result = await service().ingest({
      fileBuffer: await packageZip('@omadia/channel-teams', '0.36.0', {
        'appPackage/manifest.json.template': MANIFEST_TEMPLATE,
        'appPackage/TEMPLATE_REVISION': '2\n',
      }),
      originalFilename: 'omadia-channel-teams-0.36.0.zip',
      uploadedBy: 'operator@example.com',
    });
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /appPackage\/TEMPLATE_REVISION/);
  });
});
