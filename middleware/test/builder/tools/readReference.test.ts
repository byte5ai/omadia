import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';

import { readReferenceTool } from '../../../src/plugins/builder/tools/readReference.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

describe('readReferenceTool', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness({
      referenceFiles: {
        'manifest.yaml': 'name: test\nversion: 0.1.0\n',
        'plugin.ts': 'export const plugin = {};\n',
        'toolkit.ts': 'export const toolkit = {};\n',
        'skills/foo.md': '# foo skill\n',
        'analyzers/seo.ts': 'export const seo = {};\n',
        'assets/admin-ui/index.html':
          '<!doctype html><html><body><!-- #region builder:admin-ui-body --><p>x</p><!-- #endregion --></body></html>',
        'private.bin': 'binary noise',
      },
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('reads a root file by basename', async () => {
    const result = await readReferenceTool.run(
      { file: 'manifest.yaml' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.content, /name: test/);
    assert.equal(result.bytes, 'name: test\nversion: 0.1.0\n'.length);
    assert.equal(result.name, 'seo-analyst');
  });

  it('reads a file under skills/', async () => {
    const result = await readReferenceTool.run(
      { file: 'skills/foo.md' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.content, /foo skill/);
  });

  it('reads a file under analyzers/', async () => {
    const result = await readReferenceTool.run(
      { file: 'analyzers/seo.ts' },
      harness.context(),
    );
    assert.equal(result.ok, true);
  });

  it('auto-strips a leading host-path prefix that includes the reference root', async () => {
    const ctx = harness.context();
    // The LLM observed in production passed full paths like
    // `middleware/packages/agent-seo-analyst/manifest.yaml`. The tool
    // accepts both that and the bare basename.
    const tail = path.basename(ctx.referenceCatalog['seo-analyst']!.root);
    const fullPath = `middleware/packages/${tail}/manifest.yaml`;
    const result = await readReferenceTool.run(
      { file: fullPath },
      ctx,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.content, /name: test/);
  });

  it('reads an HTML file from assets/admin-ui/ (S+7.7 admin-ui boilerplate)', async () => {
    const result = await readReferenceTool.run(
      { file: 'assets/admin-ui/index.html' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.content, /<!-- #region builder:admin-ui-body -->/);
  });

  it('rejects a file with a non-allowed extension', async () => {
    const result = await readReferenceTool.run(
      { file: 'private.bin' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /extension/);
  });

  it('rejects path traversal via "../"', async () => {
    const result = await readReferenceTool.run(
      { file: '../etc/passwd' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /\.\./);
  });

  it('rejects an absolute path', async () => {
    const result = await readReferenceTool.run(
      { file: '/etc/passwd' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /relative/);
  });

  it('rejects a path that touches a blocked segment (node_modules)', async () => {
    const result = await readReferenceTool.run(
      { file: 'node_modules/leaked.json' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /node_modules/);
  });

  it('returns ok=false for a non-existent (but allowed) file', async () => {
    const result = await readReferenceTool.run(
      { file: 'tsconfig.json' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /does not exist/);
  });

  it('lists the available files when the requested file is missing', async () => {
    // Live-observed 2026-05-04: the LLM tried `src/plugin.ts` against the
    // boilerplate (which has `plugin.ts` at the root). Without a file
    // listing in the error, it just guesses again. The error now carries
    // an `availableFiles` array + a `hint` enumerating real paths so the
    // LLM can pick one on the next turn.
    const result = await readReferenceTool.run(
      { file: 'src/plugin.ts' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /does not exist/);
    assert.ok(
      Array.isArray(result.availableFiles),
      'availableFiles should be populated on file-not-found',
    );
    const files = result.availableFiles ?? [];
    assert.ok(
      files.includes('plugin.ts'),
      `expected plugin.ts in availableFiles, got: ${files.join(', ')}`,
    );
    assert.ok(
      files.includes('skills/foo.md'),
      'nested files should also be surfaced',
    );
    assert.ok(
      !files.some((f) => f.endsWith('private.bin')),
      'disallowed extensions must not leak into the suggestion list',
    );
    assert.match(result.hint ?? '', /available files in 'seo-analyst'/);
    assert.match(result.hint ?? '', /plugin\.ts/);
  });

  it('returns ok=false for an unknown reference name', async () => {
    const result = await readReferenceTool.run(
      { name: 'no-such-agent', file: 'manifest.yaml' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /unknown reference name/);
  });
});
