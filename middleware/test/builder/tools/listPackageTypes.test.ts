import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { listPackageTypesTool } from '../../../src/plugins/builder/tools/listPackageTypes.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

/**
 * Seeds a fake `<templateRoot>/node_modules/<pkg>/` with package.json
 * + a tree of `.d.ts` files so we can exercise the tool without
 * pulling in real npm packages. Returns the `node_modules` root so the
 * caller can also seed siblings (e.g. for the not-installed test).
 */
function seedFakePackage(
  templateRoot: string,
  pkgName: string,
  files: Record<string, string>,
  pkgJsonExtra: Record<string, unknown> = {},
): string {
  const nm = path.join(templateRoot, 'node_modules');
  const pkgDir = path.join(nm, pkgName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: pkgName, version: '1.2.3', ...pkgJsonExtra }, null, 2),
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(pkgDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return nm;
}

describe('listPackageTypesTool', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('lists .d.ts files and reports the declared mainTypes entry', async () => {
    seedFakePackage(
      harness.context().templateRoot,
      'fake-sdk',
      {
        'index.d.ts': 'export {};\n',
        'client.d.ts': 'export class Client {}\n',
        'resources/messages.d.ts': 'export class Messages {}\n',
      },
      { types: './client.d.ts' },
    );

    const result = await listPackageTypesTool.run(
      { packageName: 'fake-sdk' },
      harness.context(),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.packageName, 'fake-sdk');
    assert.equal(result.version, '1.2.3');
    assert.equal(result.mainTypes, 'client.d.ts');
    assert.deepEqual(
      [...result.files].sort(),
      ['client.d.ts', 'index.d.ts', 'resources/messages.d.ts'],
    );
    assert.equal(result.truncated, false);
  });

  it('falls back to index.d.ts when package.json declares no types field', async () => {
    seedFakePackage(harness.context().templateRoot, 'no-types-decl', {
      'index.d.ts': 'export {};\n',
    });

    const result = await listPackageTypesTool.run(
      { packageName: 'no-types-decl' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mainTypes, 'index.d.ts');
  });

  it('returns mainTypes=null when neither types-field nor index.d.ts exists', async () => {
    seedFakePackage(harness.context().templateRoot, 'no-types', {
      'README.md': '# no types',
    });

    const result = await listPackageTypesTool.run(
      { packageName: 'no-types' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mainTypes, null);
    assert.deepEqual(result.files, []);
  });

  it('errors with a hint when the package is not installed', async () => {
    const result = await listPackageTypesTool.run(
      { packageName: 'never-installed' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not installed in the build template/);
    assert.match(result.hint ?? '', /node_modules/);
  });

  it('returns sharper, actionable hint for forbidden internal packages', async () => {
    // OB-44: agent sometimes calls list_package_types with
    // '@omadia/plugin-api' looking for PluginContext, but those
    // types are duplicated locally in the boilerplate's types.ts to
    // honour the standalone-compile contract. Generic "not installed"
    // burns 1-3 fix-up turns; the sharper hint short-circuits that.
    const result = await listPackageTypesTool.run(
      { packageName: '@omadia/plugin-api' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /intentionally not installed/);
    assert.match(result.error, /standalone/);
    assert.match(result.hint ?? '', /types\.ts/);
    assert.match(result.hint ?? '', /Checklist Point 1/);
  });

  it('still resolves cross-plugin integration packages on disk (not in forbidden list)', async () => {
    // Counter-test for the OB-44 fix: forbidden list must stay narrow.
    // @omadia/integration-* packages ARE shipped into the build
    // template (used by external_reads codegen) and must NOT short-
    // circuit to the forbidden-hint path.
    seedFakePackage(
      harness.context().templateRoot,
      '@omadia/integration-odoo',
      { 'index.d.ts': 'export class OdooClient {}\n' },
      { types: 'index.d.ts' },
    );
    const result = await listPackageTypesTool.run(
      { packageName: '@omadia/integration-odoo' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mainTypes, 'index.d.ts');
  });

  it('supports scoped packages', async () => {
    seedFakePackage(
      harness.context().templateRoot,
      '@anthropic-ai/sdk',
      { 'index.d.ts': 'export {};\n' },
      { types: 'index.d.ts' },
    );
    const result = await listPackageTypesTool.run(
      { packageName: '@anthropic-ai/sdk' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mainTypes, 'index.d.ts');
  });

  it('rejects path segments in packageName (defence in depth)', async () => {
    const result = await listPackageTypesTool.run(
      { packageName: 'foo/bar' as unknown as string },
      harness.context(),
    );
    // Either zod input validation or post-resolve check rejects this.
    assert.equal(result.ok, false);
  });

  it('skips node_modules and dotfiles when walking', async () => {
    seedFakePackage(harness.context().templateRoot, 'walker', {
      'index.d.ts': 'export {};\n',
      'node_modules/transitive/foo.d.ts': 'export {};\n',
      '.cache/stale.d.ts': 'export {};\n',
    });
    const result = await listPackageTypesTool.run(
      { packageName: 'walker' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([...result.files], ['index.d.ts']);
  });
});
