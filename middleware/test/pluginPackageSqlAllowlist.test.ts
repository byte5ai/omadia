/**
 * `.sql` in the plugin-package extension allowlist.
 *
 * A distributed plugin ships its own schema as `migrations/*.sql`, so the
 * extractor has to accept the extension. That entry is only admissible
 * because uploaded content can never reach a directory a migrator scans:
 *
 *   - all eight SQL migrators resolve their directory from their own
 *     `import.meta.url` (or the fixed `middleware/migrations` / an operator
 *     env override), never from package content;
 *   - uploaded packages land only under the packages root, whose
 *     `<id>/<version>` segments are charset-gated in `manifestLoader` and
 *     containment-re-checked in `packageUploadService` (commit 09ff9cd0);
 *   - the `node_modules` symlink at the packages root — the one path that
 *     would lead into the host tree — is a reserved id.
 *
 * Adding `.sql` before that traversal was closed would have turned a
 * directory-delete into arbitrary SQL executed at boot. These tests pin the
 * conditions, not just the happy path: if any of them starts failing, `.sql`
 * has to come back out of the allowlist.
 *
 * The identity/containment gates themselves are covered by
 * `pluginInstallPathTraversal.test.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import { extractZipToDir, ZipExtractionError } from '../src/plugins/zipExtractor.js';
import {
  buildZip,
  fakeCatalog,
  fakeStore,
  manifestYaml,
  packageZip,
} from './_helpers/pluginPackageZip.js';

const MIGRATION_SQL = 'CREATE TABLE plugin_notes (id TEXT PRIMARY KEY);\n';

function sqlPackageZip(id: string, version: string): Promise<Buffer> {
  return packageZip(id, version, { 'migrations/001_init.sql': MIGRATION_SQL });
}

/**
 * A package zip carrying a Zip-Slip `.sql` entry. yazl refuses to *author* a
 * traversing entry name, so the name is swapped in afterwards at the byte
 * level: the placeholder and the payload are the same length, and the name is
 * stored verbatim in both the local header and the central directory, so a
 * global replace over the buffer keeps every offset valid.
 */
const SLIP_PLACEHOLDER = 'xx/xx/migrations/999_pwn.sql';
const SLIP_REAL = '../../migrations/999_pwn.sql';

async function zipSlipSqlZip(): Promise<Buffer> {
  assert.equal(SLIP_PLACEHOLDER.length, SLIP_REAL.length);
  const raw = await buildZip({
    'manifest.yaml': manifestYaml('@omadia/plugin-notes', '1.0.0'),
    'dist/plugin.js': 'module.exports = { activate() {} };\n',
    [SLIP_PLACEHOLDER]: 'DROP TABLE users;\n',
  });
  const patched = Buffer.from(
    raw.toString('latin1').split(SLIP_PLACEHOLDER).join(SLIP_REAL),
    'latin1',
  );
  assert.equal(patched.length, raw.length);
  return patched;
}

/** Every `.sql` file under `dir`, as paths relative to `dir`, sorted. */
async function sqlFilesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(current, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.name.endsWith('.sql')) found.push(path.relative(dir, abs));
    }
  };
  await walk(dir);
  return found.sort();
}

// ---------------------------------------------------------------------------
// Extractor-level — the allowlist entry itself
// ---------------------------------------------------------------------------

describe('zipExtractor × .sql', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-sql-'));
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

  it('accepts .sql under the default plugin-package allowlist', async () => {
    const files = await extract({ 'migrations/001_init.sql': MIGRATION_SQL });
    assert.deepEqual(files, ['migrations/001_init.sql']);
    assert.equal(
      await fs.readFile(path.join(root, 'out', 'migrations', '001_init.sql'), 'utf8'),
      MIGRATION_SQL,
    );
  });

  // The Profile-Bundle importer passes its own allowlist. A caller that opts
  // out of the default set must not silently inherit `.sql` — the override is
  // documented as replacing the default wholesale, and that has to stay true.
  it('rejects .sql when an explicit extensionAllowlist omits it', async () => {
    await assert.rejects(
      () =>
        extract(
          { 'migrations/001_init.sql': MIGRATION_SQL },
          { extensionAllowlist: new Set(['.json', '.yaml']) },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ZipExtractionError);
        assert.equal(err.code, 'zip.forbidden_extension');
        return true;
      },
    );
  });

  it('still rejects an extension outside both sets', async () => {
    await assert.rejects(
      () => extract({ 'run.sh': '#!/bin/sh\n' }),
      (err: unknown) =>
        err instanceof ZipExtractionError && err.code === 'zip.forbidden_extension',
    );
  });
});

// ---------------------------------------------------------------------------
// Ingest-level — where the .sql is allowed to end up
// ---------------------------------------------------------------------------

describe('PackageUploadService ingest × .sql payloads', () => {
  let root: string;
  let packagesDir: string;
  let victimDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-sql-'));
    packagesDir = path.join(root, '.uploaded-packages');
    await fs.mkdir(packagesDir, { recursive: true });
    // Stand-in for the real `migrations/` directory that sits next to the
    // packages root in the production image and is readdir+executed at boot.
    victimDir = path.join(root, 'migrations');
    await fs.mkdir(victimDir, { recursive: true });
    await fs.writeFile(path.join(victimDir, '001_init.sql'), 'SELECT 1;\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** The only `.sql` that may exist after a rejected ingest: the victim's own. */
  const untouched = (): string[] => [path.join('migrations', '001_init.sql')];

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

  it('installs a package that ships its own .sql migrations', async () => {
    const result = await service().ingest({
      fileBuffer: await sqlPackageZip('@omadia/plugin-notes', '1.0.0'),
      originalFilename: 'plugin-notes.zip',
      uploadedBy: 'operator@example.com',
    });

    assert.equal(result.ok, true);
    const finalDir = path.join(packagesDir, '@omadia', 'plugin-notes', '1.0.0');
    assert.equal(
      await fs.readFile(path.join(finalDir, 'migrations', '001_init.sql'), 'utf8'),
      MIGRATION_SQL,
    );
  });

  // The escalation this allowlist entry was previously blocked on. Rejection
  // happens after the staged extract but before the `fs.rm` + rename, so the
  // assertion is that no `.sql` survives outside the packages root — not that
  // the zip was never opened.
  it('never lands .sql outside the packages root for a traversing identity', async () => {
    const result = await service().ingest({
      fileBuffer: await sqlPackageZip('..', 'migrations'),
      originalFilename: 'evil.zip',
      uploadedBy: 'attacker@example.com',
    });

    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'package.manifest_invalid');
    assert.deepEqual(await sqlFilesUnder(root), untouched());
  });

  // `node_modules` is a syntactically valid npm name, so the loader lets it
  // through — the packages root's symlink to the host tree makes it the one
  // id that would walk `.sql` straight into the shipped migrator directories.
  it('never lands .sql through the reserved node_modules entry', async () => {
    const result = await service().ingest({
      fileBuffer: await sqlPackageZip('node_modules', '1.0.0'),
      originalFilename: 'evil.zip',
      uploadedBy: 'attacker@example.com',
    });

    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'package.path_traversal');
    assert.deepEqual(await sqlFilesUnder(root), untouched());
  });

  // Zip-Slip is the second way a `.sql` could reach a migrator dir, and it is
  // independent of the manifest: the entry path itself does the traversing.
  //
  // Three guards stack here, and the OUTERMOST one wins: yauzl's own
  // `validateFileName` rejects the entry while reading the central directory,
  // so it never reaches the extractor's `zip.path_escape` branch (which stays
  // as defence in depth) nor the manifest gate. yauzl surfaces that as a plain
  // `Error` on the zipfile, which `extractZipToDir` re-throws unwrapped and
  // `ingest` propagates — hence `rejects` rather than an `IngestFailure`. The
  // security property is the same either way and is what is asserted.
  it('rejects a .sql entry whose zip path escapes the staging root', async () => {
    const fileBuffer = await zipSlipSqlZip();
    await assert.rejects(
      () =>
        service().ingest({
          fileBuffer,
          originalFilename: 'evil.zip',
          uploadedBy: 'attacker@example.com',
        }),
      /invalid relative path/,
    );

    assert.deepEqual(await sqlFilesUnder(root), untouched());
  });
});
