import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readPackageTypesTool } from '../../../src/plugins/builder/tools/readPackageTypes.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

function seedFakePackage(
  templateRoot: string,
  pkgName: string,
  files: Record<string, string>,
  pkgJsonExtra: Record<string, unknown> = {},
): void {
  const pkgDir = path.join(templateRoot, 'node_modules', pkgName);
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
}

describe('readPackageTypesTool', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('reads the declared mainTypes file when no `file` is given', async () => {
    seedFakePackage(
      harness.context().templateRoot,
      'fake-sdk',
      {
        'client.d.ts': 'export class Client { messages: Messages; }\n',
      },
      { types: './client.d.ts' },
    );

    const result = await readPackageTypesTool.run(
      { packageName: 'fake-sdk' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.file, 'client.d.ts');
    assert.match(result.content, /export class Client/);
  });

  it('reads a specific .d.ts under a sub-path', async () => {
    seedFakePackage(harness.context().templateRoot, 'fake-sdk', {
      'index.d.ts': 'export {};\n',
      'resources/messages.d.ts': 'export interface Message {}\n',
    });

    const result = await readPackageTypesTool.run(
      { packageName: 'fake-sdk', file: 'resources/messages.d.ts' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.content, /export interface Message/);
  });

  it('reads package.json when explicitly requested', async () => {
    seedFakePackage(harness.context().templateRoot, 'fake-sdk', {
      'index.d.ts': 'export {};\n',
    });
    const result = await readPackageTypesTool.run(
      { packageName: 'fake-sdk', file: 'package.json' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.content, /"name": "fake-sdk"/);
  });

  it('rejects unsupported extensions', async () => {
    seedFakePackage(harness.context().templateRoot, 'fake-sdk', {
      'index.d.ts': 'export {};\n',
      'README.md': '# fake',
    });
    const result = await readPackageTypesTool.run(
      { packageName: 'fake-sdk', file: 'README.md' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /unsupported extension/);
  });

  it('rejects path traversal via ".."', async () => {
    seedFakePackage(harness.context().templateRoot, 'fake-sdk', {
      'index.d.ts': 'export {};\n',
    });
    const result = await readPackageTypesTool.run(
      { packageName: 'fake-sdk', file: '../leak.d.ts' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /'\.\.'/);
  });

  it('rejects access into nested node_modules', async () => {
    seedFakePackage(harness.context().templateRoot, 'fake-sdk', {
      'index.d.ts': 'export {};\n',
      'node_modules/transitive/foo.d.ts': 'export {};\n',
    });
    const result = await readPackageTypesTool.run(
      { packageName: 'fake-sdk', file: 'node_modules/transitive/foo.d.ts' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /node_modules/);
  });

  it('errors when the package is not installed', async () => {
    const result = await readPackageTypesTool.run(
      { packageName: 'missing-pkg' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not installed/);
  });

  it('errors when the requested file does not exist', async () => {
    seedFakePackage(harness.context().templateRoot, 'fake-sdk', {
      'index.d.ts': 'export {};\n',
    });
    const result = await readPackageTypesTool.run(
      { packageName: 'fake-sdk', file: 'wrong.d.ts' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /does not exist/);
  });
});
